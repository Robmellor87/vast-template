"""
Asset library.

Each asset represents a video creative.  Multi-bitrate assets carry a
`variants` list; single-rendition assets carry a single entry.

Replace the placeholder URLs with real CDN/storage URLs when you have
a hosting solution in place.
"""


# ---------------------------------------------------------------------------
# Asset definitions
# ---------------------------------------------------------------------------
#
# Naming convention for placeholder URLs:
#   https://assets.placeholder.example.com//x_kbps.mp4
#
# Resolutions targeted:
#   - 1920×1080 (1080p)  – primary CTV resolution
#   - 1280×720  (720p)   – mid-tier / bandwidth constrained
#   - 640×360   (360p)   – low bandwidth fallback
#
# Durations: 6 s, 15 s, 20 s, 30 s
# ---------------------------------------------------------------------------

_BASE = "https://assets.placeholder.example.com"

def _variants(asset_id: str, width_height_pairs=None) -> list:
    """Generate multi-bitrate variant list for a given asset."""
    if width_height_pairs is None:
        width_height_pairs = [
            (1920, 1080, 5000),
            (1280,  720, 2500),
            ( 640,  360,  800),
        ]
    return [
        {
            "url":          f"{_BASE}/{asset_id}/{w}x{h}_{br}kbps.mp4",
            "mime_type":    "video/mp4",
            "width":        w,
            "height":       h,
            "bitrate_kbps": br,
        }
        for w, h, br in width_height_pairs
    ]


_ASSETS = [
    # ── 6-second spots ───────────────────────────────────────────────────
    {
        "asset_id":    "asset_001",
        "name":        "Brand Bumper – 6s",
        "duration":    6,
        "description": "Short brand bumper, ideal for pre-roll or pod cap.",
        "tags":        ["6s", "bumper"],
        "thumbnail":   f"{_BASE}/asset_001/thumb.jpg",
        "variants":    _variants("asset_001"),
    },
    {
        "asset_id":    "asset_002",
        "name":        "Product Flash – 6s",
        "duration":    6,
        "description": "6-second product highlight.",
        "tags":        ["6s", "bumper"],
        "thumbnail":   f"{_BASE}/asset_002/thumb.jpg",
        "variants":    _variants("asset_002"),
    },

    # ── 15-second spots ───────────────────────────────────────────────────
    {
        "asset_id":    "asset_003",
        "name":        "Promo Spot A – 15s",
        "duration":    15,
        "description": "Standard 15-second promotional creative.",
        "tags":        ["15s"],
        "thumbnail":   f"{_BASE}/asset_003/thumb.jpg",
        "variants":    _variants("asset_003"),
    },
    {
        "asset_id":    "asset_004",
        "name":        "Promo Spot B – 15s",
        "duration":    15,
        "description": "Alternate 15-second creative.",
        "tags":        ["15s"],
        "thumbnail":   f"{_BASE}/asset_004/thumb.jpg",
        "variants":    _variants("asset_004"),
    },

    # ── 20-second spots ───────────────────────────────────────────────────
    {
        "asset_id":    "asset_005",
        "name":        "Demo Reel – 20s",
        "duration":    20,
        "description": "20-second product demo.",
        "tags":        ["20s"],
        "thumbnail":   f"{_BASE}/asset_005/thumb.jpg",
        "variants":    _variants("asset_005"),
    },

    # ── 30-second spots ───────────────────────────────────────────────────
    {
        "asset_id":    "asset_006",
        "name":        "Brand Story – 30s",
        "duration":    30,
        "description": "Full 30-second brand narrative.",
        "tags":        ["30s"],
        "thumbnail":   f"{_BASE}/asset_006/thumb.jpg",
        "variants":    _variants("asset_006"),
    },
    {
        "asset_id":    "asset_007",
        "name":        "Product Deep-Dive – 30s",
        "duration":    30,
        "description": "Detailed 30-second product walkthrough.",
        "tags":        ["30s"],
        "thumbnail":   f"{_BASE}/asset_007/thumb.jpg",
        "variants":    _variants("asset_007"),
    },
    {
        "asset_id":    "asset_008",
        "name":        "Campaign Hero – 30s",
        "duration":    30,
        "description": "Hero campaign creative, 30 seconds.",
        "tags":        ["30s", "hero"],
        "thumbnail":   f"{_BASE}/asset_008/thumb.jpg",
        "variants":    _variants("asset_008"),
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