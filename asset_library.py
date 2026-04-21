"""
Asset library.

Each asset represents a video creative. Assets carry a `variants`
list — a single-rendition entry today, but the VAST builder iterates
this list, so dropping in a multi-bitrate ladder later is a
field-level change rather than a code change.

Creatives are hosted on Cloudflare R2 (public bucket). All files are
single-rendition 1920×1080 MP4s at a medium-quality 1080p bitrate.
Duration is encoded as the leading number in each filename
(e.g. `25s_Q77B_ad.mp4` is 25 seconds).
"""


# ---------------------------------------------------------------------------
# Asset definitions
# ---------------------------------------------------------------------------

_BASE = "https://pub-f4f95ac7eb384df3985e9d27daf244f6.r2.dev"


def _single_rendition(filename: str, bitrate_kbps: int = 5000) -> list:
    """
    Build a single-rendition variants list for a 1920×1080 creative.

    Bitrate defaults to 5000 kbps — a reasonable approximation for the
    "medium quality 1080p" bucket these files are encoded at. The
    value is only used to populate the VAST `<MediaFile bitrate="…">`
    attribute; it does not influence playback.
    """
    return [
        {
            "url":          f"{_BASE}/{filename}",
            "mime_type":    "video/mp4",
            "width":        1920,
            "height":       1080,
            "bitrate_kbps": bitrate_kbps,
        }
    ]


_ASSETS = [
    # ── 20-second spots ───────────────────────────────────────────────────
    {
        "asset_id":    "asset_freestyle_20s",
        "name":        "Freestyle – 20s",
        "duration":    20,
        "description": "Freestyle product spot, 20 seconds.",
        "tags":        ["20s"],
        "variants":    _single_rendition("20s_freestyle_ad.mp4"),
    },

    # ── 25-second spots ───────────────────────────────────────────────────
    {
        "asset_id":    "asset_q77b_25s",
        "name":        "Q77B – 25s",
        "duration":    25,
        "description": "Q77B product spot, 25 seconds.",
        "tags":        ["25s"],
        "variants":    _single_rendition("25s_Q77B_ad.mp4"),
    },

    # ── 28-second spots ───────────────────────────────────────────────────
    {
        "asset_id":    "asset_s95f_oled_28s",
        "name":        "S95F OLED – 28s",
        "duration":    28,
        "description": "S95F OLED product spot, 28 seconds.",
        "tags":        ["28s", "oled"],
        "variants":    _single_rendition("28s_S95F_OLED_ad.mp4"),
    },

    # ── 30-second spots ───────────────────────────────────────────────────
    {
        "asset_id":    "asset_promo_30s",
        "name":        "Promo – 30s",
        "duration":    30,
        "description": "General promo, 30 seconds.",
        "tags":        ["30s", "promo"],
        "variants":    _single_rendition("30_promo.mp4"),
    },
    {
        "asset_id":    "asset_ai_promo_30s",
        "name":        "AI Promo – 30s",
        "duration":    30,
        "description": "AI-themed promo, 30 seconds.",
        "tags":        ["30s", "promo", "ai"],
        "variants":    _single_rendition("30s_ai_promo.mp4"),
    },
]

# Build lookup dict once at import time
_ASSET_MAP = {a["asset_id"]: a for a in _ASSETS}


# ---------------------------------------------------------------------------
# Public class
# ---------------------------------------------------------------------------

class AssetLibrary:
    """Simple read-only asset catalogue."""

    def all(self) -> list:
        return _ASSETS

    def get(self, asset_id: str) -> dict | None:
        return _ASSET_MAP.get(asset_id)

    def by_duration(self, duration: int) -> list:
        return [a for a in _ASSETS if a["duration"] == duration]

    def by_tag(self, tag: str) -> list:
        return [a for a in _ASSETS if tag in a.get("tags", [])]
