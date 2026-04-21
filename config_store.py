"""
In-memory configuration store.
Holds the current ad pod definition that will be used
by the next VAST request.

The returned pod duration is always the sum of the ad durations — there
is no separate pod_duration ceiling. The player tells us what duration
they are trying to fill on the /vast request itself (via ?duration=).
"""

import copy
from asset_library import AssetLibrary

_asset_lib = AssetLibrary()

# ---------------------------------------------------------------------------
# Default configuration – a single 30 s ad
# ---------------------------------------------------------------------------

_DEFAULT_CONFIG = {
    "ads": [
        {
            "ad_id":    "ad_default_001",
            "title":    "Default Test Ad (30s)",
            "asset_id": "asset_001",
            "duration": 30,
            "sequence": 1,
        }
    ],
}


class ConfigStore:
    """Thread-safe (GIL is sufficient for single-process dev) config holder."""

    def __init__(self):
        self._config = copy.deepcopy(_DEFAULT_CONFIG)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self) -> dict:
        """
        Return the current config with asset objects resolved.
        The returned dict is a deep copy – mutating it has no effect on
        the stored config.
        """
        cfg = copy.deepcopy(self._config)
        cfg["ads"] = [self._resolve_asset(ad) for ad in cfg["ads"]]
        return cfg

    def set(self, new_config: dict) -> None:
        """Replace the current config (stores only ad_ids, not full asset objects)."""
        self._config = {
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

    def reset(self) -> None:
        self._config = copy.deepcopy(_DEFAULT_CONFIG)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

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