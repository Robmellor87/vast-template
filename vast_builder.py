"""
Builds VAST 3.0 compliant XML responses.

Only the fields required for this product are included:
  - VAST wrapper/inline
  - Ad pod sequencing
  - Linear creative with MediaFile
  - Impression tracking
  - Linear tracking events (start, quartiles, complete)
  - AdParameters (omitted – not needed)
  - No Companions, NonLinear, Extensions
"""

from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom import minidom
import urllib.parse


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def build_vast_response(
    config: dict,
    break_id: str,
    base_url: str,
    session_id: str = "default",
) -> str:
    """
    Build a VAST 3.0 AdPod XML string from the supplied configuration.

    Args:
        config:      Current pod config ({"ads": [ad dicts]}). Returned pod
                     duration is implicitly the sum of ad durations.
        break_id:    Identifier for this ad break (used in tracking URLs)
        base_url:    Public base URL of this service (for tracking pixels)
        session_id:  Session identifier — baked into every tracking pixel
                     URL so pixels fired by the CTV player route back to
                     the right session partition on arrival at /track.
                     Defaults to "default" for backwards compatibility.

    Returns:
        UTF-8 XML string
    """
    root = Element("VAST", version="3.0")

    ads = sorted(config.get("ads", []), key=lambda a: a["sequence"])

    for ad in ads:
        _build_inline_ad(root, ad, break_id, base_url, session_id)

    return _pretty_xml(root)


# ---------------------------------------------------------------------------
# Per-ad builder
# ---------------------------------------------------------------------------

def _build_inline_ad(
    parent: Element,
    ad: dict,
    break_id: str,
    base_url: str,
    session_id: str,
) -> None:
    """Append an  element to the VAST root."""

    ad_id    = ad["ad_id"]
    title    = ad["title"]
    duration = ad["duration"]
    sequence = ad["sequence"]
    asset    = ad["asset"]          # resolved asset dict (injected by config_store)

    # ──  ──────────────────────────────────────────────────────────────
    ad_el = SubElement(parent, "Ad", id=ad_id, sequence=str(sequence))

    # ──  ──────────────────────────────────────────────────────────
    inline = SubElement(ad_el, "InLine")

    SubElement(inline, "AdSystem").text = "VASTTestPlatform"
    SubElement(inline, "AdTitle").text  = title

    # ── Impression tracking pixel ─────────────────────────────────────────
    imp_url = _tracking_url(base_url, "impression", ad_id, break_id, sequence, session_id)
    SubElement(inline, "Impression", id="imp_1").text = imp_url

    # ──  ───────────────────────────────────────────────────────
    creatives = SubElement(inline, "Creatives")
    creative  = SubElement(creatives, "Creative", id=f"cr_{ad_id}", sequence="1")
    linear    = SubElement(creative, "Linear")

    # Duration  HH:MM:SS
    SubElement(linear, "Duration").text = _seconds_to_hhmmss(duration)

    # ── Tracking events ───────────────────────────────────────────────────
    tracking_events = SubElement(linear, "TrackingEvents")

    for event in ("start", "firstQuartile", "midpoint", "thirdQuartile", "complete"):
        url = _tracking_url(base_url, event, ad_id, break_id, sequence, session_id)
        SubElement(tracking_events, "Tracking", event=event).text = url

    # ── Media file ────────────────────────────────────────────────────────
    media_files = SubElement(linear, "MediaFiles")

    for variant in asset.get("variants", [asset]):   # support multi-bitrate assets
        SubElement(
            media_files,
            "MediaFile",
            delivery   = "progressive",
            type       = variant.get("mime_type", "video/mp4"),
            bitrate    = str(variant.get("bitrate_kbps", 0)),
            width      = str(variant.get("width",  1920)),
            height     = str(variant.get("height", 1080)),
        ).text = variant.get("url", "")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _tracking_url(
    base_url: str,
    event: str,
    ad_id: str,
    break_id: str,
    sequence: int,
    session_id: str,
) -> str:
    params = urllib.parse.urlencode({
        "event":      event,
        "ad_id":      ad_id,
        "break_id":   break_id,
        "sequence":   sequence,
        "session_id": session_id,
    })
    return f"{base_url}/track?{params}"


def _seconds_to_hhmmss(seconds: float) -> str:
    seconds = int(seconds)
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def _pretty_xml(root: Element) -> str:
    raw   = tostring(root, encoding="unicode", xml_declaration=False)
    reparsed = minidom.parseString(f'{raw}')
    return reparsed.toprettyxml(indent="  ", encoding=None)