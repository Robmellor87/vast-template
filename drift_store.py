"""
EPG Drift store.

For every /vast request the player tells us the pod duration it is
trying to fill (via the ?duration= query param). We snapshot the ads
that were returned in that response and then track how far the player
actually got into each one, via VAST tracking pixels.

    drift = requested - actually_played

Played time is credited fractionally from the highest milestone each
ad reaches:

    impression / start  ->  0%   (playback requested, no duration elapsed)
    firstQuartile       -> 25%
    midpoint            -> 50%
    thirdQuartile       -> 75%
    complete            -> 100%

This matches how broadcasters think about EPG gaps — a 30s ad that
dies at midpoint due to a transcode error represents 15s of rendered
inventory and 15s of drift, not 30s of drift. Milestones only ever
ratchet upward per ad, so out-of-order or duplicate pixels can't
regress the number.

Records start life as "pending" and are committed to the cumulative
under/over-fill totals in one of two ways:
  1. Every ad in the returned pod hits 'complete' — finalise immediately.
  2. The break goes idle for more than FINALISE_IDLE_SECONDS — finalise
     lazily on the next snapshot() call, crediting whatever milestones
     had fired up to that point.

Over-fill (player rendered more than it asked for) shouldn't happen in
the real world but is allowed here because the user can configure any
pod. Those records are flagged with warning=True and contribute to the
informational total_overfill counter only.

Multi-session: the public `DriftStore` at the bottom of this file is a
dispatcher keyed by session_id — one `_SessionDriftStore` instance per
session, materialised on first touch. All public methods take a
session_id so two testers hitting the same hosted instance can't see
each other's pending breaks or cumulative totals. Unqualified requests
route to a `"default"` session.
"""

import threading
from collections import deque
from datetime import datetime


MAX_RECORDS            = 500   # keep the last N /vast requests per session
FINALISE_IDLE_SECONDS  = 15.0  # break considered "done" after this much silence

# VAST tracking event -> fraction of ad duration considered played
EVENT_FRACTIONS = {
    "impression":    0.0,
    "start":         0.0,
    "firstQuartile": 0.25,
    "midpoint":      0.50,
    "thirdQuartile": 0.75,
    "complete":      1.0,
}


# ---------------------------------------------------------------------------
# Per-session state — the original single-session store, unchanged in
# behaviour. Exists as a private class so the public DriftStore can
# route per-session traffic to its own instance.
# ---------------------------------------------------------------------------

class _SessionDriftStore:
    """Thread-safe rolling record of VAST-request fill for one session."""

    def __init__(self):
        self._records: deque = deque(maxlen=MAX_RECORDS)
        self._pending: dict  = {}           # break_id -> record (latest only)
        self._total_underfill: float = 0.0  # cumulative seconds
        self._total_overfill: float  = 0.0  # cumulative seconds (informational)
        self._total_returned: float  = 0.0  # cumulative seconds shipped
        self._total_played: float    = 0.0  # cumulative seconds actually rendered
        self._finalised_breaks: int  = 0    # count of breaks contributing to totals
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def record_request(
        self,
        break_id: str,
        requested: float | None,
        pod_ads: list,
    ) -> dict:
        """
        Log a single /vast request and start a pending record for this
        break. `pod_ads` is the list of ads returned in the VAST response
        — each item must expose `ad_id` and `duration`.

        If this break_id already had a pending record, that previous
        record is finalised first (so a fresh /vast for the same break
        can't silently swallow a partial playout).
        """
        now = datetime.utcnow()
        ts  = now.isoformat()

        returned = sum(float(ad.get("duration", 0) or 0) for ad in pod_ads)
        ad_map   = {ad["ad_id"]: float(ad.get("duration", 0) or 0) for ad in pod_ads}

        entry = {
            "ts":          ts,
            "break_id":    break_id,
            "requested":   requested,
            "returned":    returned,
            "played":      0.0,
            "diff":        None,            # populated on finalise
            "warning":     False,           # populated on finalise
            "pending":     True,
            "ad_map":      ad_map,          # ad_id -> duration (returned pod)
            "ad_progress": {},              # ad_id -> highest fraction fired (0..1)
            "last_event":  now.timestamp(), # monotonic-ish idle watermark
        }

        with self._lock:
            prior = self._pending.pop(break_id, None)
            if prior is not None:
                self._finalise_locked(prior)

            self._records.appendleft(entry)
            self._pending[break_id] = entry

        return self._public_view(entry)

    def register_event(self, break_id: str, ad_id: str, event: str) -> None:
        """
        Record a VAST tracking event for an ad in the pending break.

        Each event maps to a fraction of the ad's duration (see
        EVENT_FRACTIONS). The ad's best-so-far fraction is stored, and
        the break's 'played' is recomputed from the sum of
        fraction * duration across all ads. Any event recognised as
        belonging to this break refreshes the idle watermark so a
        still-playing pod isn't timed out prematurely.

        If every ad has reached 100% (i.e. fired complete), the break
        is finalised immediately rather than waiting for the idle sweep.
        """
        with self._lock:
            entry = self._pending.get(break_id)
            if entry is None:
                return

            # Any known-shape event for this break keeps the watchdog happy,
            # even if the ad_id isn't in the returned pod.
            entry["last_event"] = datetime.utcnow().timestamp()

            fraction = EVENT_FRACTIONS.get(event)
            if fraction is None:
                return                        # unknown event — watermark only
            if ad_id not in entry["ad_map"]:
                return                        # pixel for an ad we never returned

            prev = entry["ad_progress"].get(ad_id, 0.0)
            if fraction <= prev:
                return                        # not a new-high milestone

            entry["ad_progress"][ad_id] = fraction

            # Recompute played from scratch — cheap, and keeps us immune to
            # any accidental drift between incremental updates.
            played = 0.0
            for aid, frac in entry["ad_progress"].items():
                played += frac * entry["ad_map"].get(aid, 0.0)
            entry["played"] = played

            # If every returned ad has hit 100%, finalise now.
            all_done = all(
                entry["ad_progress"].get(aid, 0.0) >= 1.0
                for aid in entry["ad_map"].keys()
            )
            if all_done:
                self._pending.pop(break_id, None)
                self._finalise_locked(entry)

    def touch(self, break_id: str) -> None:
        """Refresh the idle watermark without crediting any progress.
        Useful for events outside the standard VAST set (e.g. custom
        heartbeats) that still prove the player is alive."""
        with self._lock:
            entry = self._pending.get(break_id)
            if entry is not None:
                entry["last_event"] = datetime.utcnow().timestamp()

    def reset(self) -> None:
        with self._lock:
            self._records.clear()
            self._pending.clear()
            self._total_underfill  = 0.0
            self._total_overfill   = 0.0
            self._total_returned   = 0.0
            self._total_played     = 0.0
            self._finalised_breaks = 0

    # ------------------------------------------------------------------
    # Finalise
    # ------------------------------------------------------------------

    def _finalise_locked(self, entry: dict) -> None:
        """Commit a pending entry's diff to cumulative totals.
        Caller must hold self._lock."""
        if not entry.get("pending"):
            return

        requested = entry.get("requested")
        played    = entry.get("played", 0.0)

        if requested is None:
            diff    = 0.0
            warning = False
        else:
            diff    = requested - played     # positive = under-fill
            warning = played > requested

        entry["diff"]    = diff
        entry["warning"] = warning
        entry["pending"] = False

        if requested is not None:
            if diff > 0:
                self._total_underfill += diff
            elif diff < 0:
                self._total_overfill += -diff

        # Render rate totals are tracked regardless of whether the request
        # had a ?duration= — they describe shipped-vs-rendered inventory.
        returned = entry.get("returned", 0.0) or 0.0
        played   = entry.get("played",   0.0) or 0.0
        self._total_returned   += returned
        self._total_played     += played
        self._finalised_breaks += 1

    def _sweep_idle_pending_locked(self) -> None:
        """Finalise any pending break that has been idle past the
        timeout. Caller must hold self._lock."""
        if not self._pending:
            return
        now_ts = datetime.utcnow().timestamp()
        stale  = [
            bid for bid, e in self._pending.items()
            if (now_ts - e["last_event"]) > FINALISE_IDLE_SECONDS
        ]
        for bid in stale:
            entry = self._pending.pop(bid)
            self._finalise_locked(entry)

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def snapshot(self, limit: int = 100) -> dict:
        """Return current drift state for the dashboard. Always sweeps
        idle-timeouts first so the headline total converges even if the
        simulator / player abandons a break silently."""
        with self._lock:
            self._sweep_idle_pending_locked()
            records          = [self._public_view(r) for r in list(self._records)]
            total_underfill  = self._total_underfill
            total_overfill   = self._total_overfill
            total_returned   = self._total_returned
            total_played     = self._total_played
            finalised_breaks = self._finalised_breaks

        last = records[0] if records else None
        last_requested = None
        if last is not None:
            last_requested = last.get("requested")

        # Seconds-weighted render rate across all finalised breaks.
        # Unweighted by break size so a single tiny 6s break can't
        # swing the number — matches how a broadcaster thinks about
        # stream-level yield. Pending breaks don't contribute yet.
        render_rate = None
        if total_returned > 0:
            render_rate = total_played / total_returned

        return {
            "total_drift":          total_underfill,
            "total_overfill":       total_overfill,
            "request_count":        len(records),
            "last_requested":       last_requested,
            "last_record":          last,
            "records":              records[:limit],
            # Render-rate headline
            "total_returned":       total_returned,
            "total_played":         total_played,
            "render_rate":          render_rate,          # 0..1 or None
            "finalised_breaks":     finalised_breaks,
        }

    def by_break(self, break_id: str) -> dict | None:
        with self._lock:
            for r in self._records:
                if r.get("break_id") == break_id:
                    return self._public_view(r)
        return None

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    @staticmethod
    def _public_view(entry: dict) -> dict:
        """Drop internal bookkeeping (sets, ad maps, watermarks) before
        handing a record out over the API."""
        return {
            "ts":        entry.get("ts"),
            "break_id":  entry.get("break_id"),
            "requested": entry.get("requested"),
            "returned":  entry.get("returned"),
            "played":    entry.get("played"),
            "diff":      entry.get("diff"),
            "warning":   entry.get("warning"),
            "pending":   entry.get("pending", False),
        }


# ---------------------------------------------------------------------------
# Public multi-session dispatcher
# ---------------------------------------------------------------------------

class DriftStore:
    """
    Thread-safe multi-session drift store.

    Each session_id gets its own `_SessionDriftStore` with an independent
    records deque, pending-break map, and cumulative totals. Session
    state is created lazily on first touch. The outer-level lock only
    guards the session dict — per-session operations rely on the inner
    store's own lock, so unrelated sessions don't contend.
    """

    def __init__(self):
        self._sessions: dict = {}
        self._sessions_lock  = threading.Lock()

    def _get(self, session_id: str) -> _SessionDriftStore:
        with self._sessions_lock:
            store = self._sessions.get(session_id)
            if store is None:
                store = _SessionDriftStore()
                self._sessions[session_id] = store
            return store

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def record_request(
        self,
        session_id: str,
        break_id: str,
        requested: float | None,
        pod_ads: list,
    ) -> dict:
        return self._get(session_id).record_request(break_id, requested, pod_ads)

    def register_event(self, session_id: str, break_id: str, ad_id: str, event: str) -> None:
        self._get(session_id).register_event(break_id, ad_id, event)

    def touch(self, session_id: str, break_id: str) -> None:
        self._get(session_id).touch(break_id)

    def reset(self, session_id: str) -> None:
        """Clear drift records and cumulative counters for one session.
        Other sessions are untouched."""
        self._get(session_id).reset()

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def snapshot(self, session_id: str, limit: int = 100) -> dict:
        return self._get(session_id).snapshot(limit=limit)

    def by_break(self, session_id: str, break_id: str) -> dict | None:
        return self._get(session_id).by_break(break_id)
