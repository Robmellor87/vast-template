"""
In-memory configuration store.
Holds the current ad pod definition that will be used
by the next VAST request.

The returned pod duration is always the sum of the ad durations — there
is no separate pod_duration ceiling. The player tells us what duration
they are trying to fill on the /vast request itself (via ?duration=).

Multi-session: `ConfigStore` is a dispatcher keyed by session_id — each
session has its own pod config, materialised on first touch with a deep
copy of the default pod. Two testers editing pods simultaneously can't
clobber each other's work.
"""

import copy
import threading
from asset_library import AssetLibrary

_asset_lib = AssetLibrary()

# ---------------------------------------------------------------------------
# Default configuration – a single 30 s ad
# ---------------------------------------------------------------------------
#
# Points at a real R2-hosted creative so the very first /vast hit after
# a cold start returns playable XML without requiring the user to build
# a pod first. Every new session inherits this as its starting pod.

_DEFAULT_CONFIG = {
    "ads": [
        {
            "ad_id":    "ad_default_001",
            "title":    "Default Test Ad (30s)",
            "asset_id": "asset_ai_promo_30s",
            "duration": 30,
            "sequence": 1,
        }
    ],
}


class ConfigStore:
    """
    Thread-safe multi-session config holder.

    Each session_id gets its own copy of the default pod on first read
    or write. The outer-level lock only guards the session dict itself.
    """

    def __init__(self):
        self._sessions: dict = {}
        self._sessions_lock  = threading.Lock()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, session_id: str) -> dict:
        """
        Return the current config for the given session with asset
        objects resolved. The returned dict is a deep copy — mutating it
        has no effect on the stored config.
        """
        config = self._ensure_session(session_id)
        cfg = copy.deepcopy(config)
        cfg["ads"] = [self._resolve_asset(ad) for ad in cfg["ads"]]
        return cfg

    def set(self, session_id: str, new_config: dict) -> None:
        """Replace the config for the given session (stores only ad_ids,
        not full asset objects)."""
        flat = {
            "ads": [
                {
                    "ad_id":    ad["ad_id"],
                    "title":    ad["title"],
                    "asset_id": ad["asset_id"],
                    "duration": ad["duration"],
                    "sequence": ad["sequence"],
                }
                for ad in new_config.get("ads", [])
            ],
        }
        with self._sessions_lock:
            self._sessions[session_id] = flat

    def reset(self, session_id: str) -> None:
        """Reset this session's pod to the default. Other sessions are
        untouched."""
        with self._sessions_lock:
            self._sessions[session_id] = copy.deepcopy(_DEFAULT_CONFIG)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_session(self, session_id: str) -> dict:
        """Return the raw (unresolved) config for a session, creating
        it from the default if this is the first touch."""
        with self._sessions_lock:
            cfg = self._sessions.get(session_id)
            if cfg is None:
                cfg = copy.deepcopy(_DEFAULT_CONFIG)
                self._sessions[session_id] = cfg
            return cfg

    def _resolve_asset(self, ad: dict) -> dict:
        """Attach the full asset dict to an ad entry."""
        asset = _asset_lib.get(ad["asset_id"])
        if asset is None:
            # Fallback stub so VAST is always valid
            asset = {
                "asset_id":  ad["asset_id"],
                "name":      "Unknown Asset",
                "duration":  ad["duration"],
                "variants": [
                    {
                        "url":          f"https://placeholder.example.com/{ad['asset_id']}.mp4",
                        "mime_type":    "video/mp4",
                        "width":        1920,
                        "height":       1080,
                        "bitrate_kbps": 3000,
                    }
                ],
            }
        ad_copy = dict(ad)
        ad_copy["asset"] = asset
        return ad_copy
