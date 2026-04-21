"""
In-memory tracking event store.
Stores pixel pings from VAST players and exposes them
for the dashboard UI.
"""

import threading
from collections import deque
from datetime import datetime


# Maximum events to keep in memory (circular buffer)
MAX_EVENTS = 2000

# Canonical VAST tracking event order (used for progress display)
EVENT_ORDER = [
    "vast_request",
    "impression",
    "start",
    "firstQuartile",
    "midpoint",
    "thirdQuartile",
    "complete",
]

EVENT_LABELS = {
    "vast_request":    "VAST Request",
    "impression":      "Impression",
    "start":           "Start (0%)",
    "firstQuartile":   "1st Quartile (25%)",
    "midpoint":        "Midpoint (50%)",
    "thirdQuartile":   "3rd Quartile (75%)",
    "complete":        "Complete (100%)",
}


class TrackingStore:
    """Thread-safe circular-buffer event store."""

    def __init__(self):
        self._events: deque = deque(maxlen=MAX_EVENTS)
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def add_event(self, event: dict) -> None:
        if "ts" not in event:
            event["ts"] = datetime.utcnow().isoformat()
        with self._lock:
            self._events.appendleft(event)   # newest first

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def query(
        self,
        limit: int = 100,
        ad_id: str = None,
        event: str = None,
    ) -> dict:
        """
        Return events plus summary statistics.
        """
        with self._lock:
            events = list(self._events)

        # Filter
        if ad_id:
            events = [e for e in events if e.get("ad_id") == ad_id]
        if event:
            events = [e for e in events if e.get("event") == event]

        # Paginate
        paged = events[:limit]

        # Build summary (counts per event type, per ad)
        summary = self._summarise(events)

        return {
            "events":  paged,
            "total":   len(events),
            "summary": summary,
        }

    def clear(self) -> None:
        with self._lock:
            self._events.clear()

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _summarise(self, events: list) -> dict:
        """Aggregate counts per ad_id per event type."""
        summary: dict = {}   # { ad_id: { event: count } }
        for e in events:
            ad_id = e.get("ad_id", "unknown")
            ev    = e.get("event", "unknown")
            if ad_id not in summary:
                summary[ad_id] = {k: 0 for k in EVENT_ORDER}
            if ev in summary[ad_id]:
                summary[ad_id][ev] += 1
            else:
                summary[ad_id][ev] = summary[ad_id].get(ev, 0) + 1
        return summary