"""
VAST Testing Platform - Core Flask Application
Provides:
  GET  /vast          - Core VAST endpoint (serve to CTV platform)
  POST /api/config    - Update pod configuration via web app
  GET  /api/config    - Get current configuration
  GET  /api/assets    - List available media assets
  GET  /track         - Tracking pixel endpoint
  GET  /api/events    - Get tracking events (for dashboard)
  GET  /              - Web app UI
"""

from flask import Flask, request, Response, jsonify, render_template
from flask_cors import CORS
import logging
import os
from datetime import datetime

from config_store import ConfigStore
from vast_builder import build_vast_response
from asset_library import AssetLibrary
from tracker import TrackingStore
from drift_store import DriftStore

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = Flask(__name__)
CORS(app)  # Allow web app to call API from any origin during development

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shared state (in-memory; swap for Redis/DB in production)
# ---------------------------------------------------------------------------

config_store = ConfigStore()
asset_library = AssetLibrary()
tracking_store = TrackingStore()
drift_store = DriftStore()

# ---------------------------------------------------------------------------
# VAST endpoint  –  this is the URL you load into your CTV platform
# ---------------------------------------------------------------------------

@app.route("/vast")
def vast_endpoint():
    """
    Core VAST endpoint.
    Query params (all optional, primarily for logging/correlation):
      ?break_id=   - Ad break identifier passed by the CTV platform
      ?cb=         - Cache-buster
      ?duration=   - Pod duration the player is trying to fill (seconds).
                     When supplied, the difference between this and the
                     total duration of returned ads is recorded as EPG drift.
    """
    break_id = request.args.get("break_id", "default")
    cb       = request.args.get("cb", "")
    requested_duration = _parse_duration(request.args.get("duration"))

    current_config = config_store.get()

    # Actual duration we are returning = sum of ad durations (what will play)
    returned_duration = sum(ad.get("duration", 0) for ad in current_config["ads"])

    log.info(
        "VAST request  break_id=%s  cb=%s  requested=%s  returned=%ss  ads=%d",
        break_id,
        cb,
        f"{requested_duration}s" if requested_duration is not None else "-",
        returned_duration,
        len(current_config["ads"]),
    )

    # Record that a VAST request was made (shows up in tracking dashboard)
    tracking_store.add_event({
        "event":    "vast_request",
        "break_id": break_id,
        "ts":       datetime.utcnow().isoformat(),
    })

    # Record EPG drift for this request. The record starts "pending" and
    # is finalised once every returned ad has fired complete, or after an
    # idle timeout — whichever comes first. Drift = requested - actually
    # played, so abandoning a pod mid-playback now correctly shows as
    # under-fill.
    drift_store.record_request(
        break_id=break_id,
        requested=requested_duration,
        pod_ads=current_config["ads"],
    )

    xml = build_vast_response(
        config=current_config,
        break_id=break_id,
        base_url=_base_url(),
    )

    return Response(xml, mimetype="application/xml")


# ---------------------------------------------------------------------------
# Configuration API  –  called by the web app
# ---------------------------------------------------------------------------

@app.route("/api/config", methods=["GET"])
def get_config():
    """Return the current pod configuration."""
    return jsonify(config_store.get())


@app.route("/api/config", methods=["POST"])
def set_config():
    """
    Replace the current pod configuration.

    Expected JSON body:
    {
      "ads": [
        {
          "ad_id":      "ad_001",
          "title":      "My 30s Spot",
          "asset_id":   "asset_003",
          "duration":   30,
          "sequence":   1
        },
        ...
      ]
    }

    The pod's returned duration is always the sum of the ad durations.
    """
    body = request.get_json(force=True)

    errors = _validate_config(body)
    if errors:
        return jsonify({"ok": False, "errors": errors}), 400

    config_store.set(body)
    ads = body.get("ads", [])
    total = sum(ad.get("duration", 0) for ad in ads)
    log.info("Config updated: ads=%d  total=%ss", len(ads), total)

    return jsonify({"ok": True, "config": config_store.get()})


@app.route("/api/config/reset", methods=["POST"])
def reset_config():
    """Reset to the default configuration."""
    config_store.reset()
    return jsonify({"ok": True, "config": config_store.get()})


# ---------------------------------------------------------------------------
# Asset library API
# ---------------------------------------------------------------------------

@app.route("/api/assets", methods=["GET"])
def get_assets():
    """Return the full list of available media assets."""
    return jsonify(asset_library.all())


# ---------------------------------------------------------------------------
# Tracking endpoint  –  pinged by VAST tracking pixels in the XML
# ---------------------------------------------------------------------------

@app.route("/track")
def track():
    """
    Tracking pixel endpoint.
    Query params (appended by VAST player):
      ?event=        e.g. impression, start, firstQuartile, midpoint,
                               thirdQuartile, complete
      ?ad_id=
      ?break_id=
      ?sequence=
    """
    event    = request.args.get("event",    "unknown")
    ad_id    = request.args.get("ad_id",    "unknown")
    break_id = request.args.get("break_id", "unknown")
    sequence = request.args.get("sequence", "0")

    entry = {
        "event":    event,
        "ad_id":    ad_id,
        "break_id": break_id,
        "sequence": sequence,
        "ts":       datetime.utcnow().isoformat(),
        "ua":       request.headers.get("User-Agent", ""),
        "ip":       request.remote_addr,
    }
    tracking_store.add_event(entry)
    log.info("TRACK %s | ad=%s break=%s seq=%s", event, ad_id, break_id, sequence)

    # Feed the drift store so played-duration reflects reality. Every
    # recognised VAST milestone credits a fraction of the ad's duration
    # (0% at impression/start, 25/50/75% at the quartiles, 100% at
    # complete). An SSAI skip or transcode failure mid-ad now surfaces
    # as accurate seconds-level drift rather than a binary 0-or-full.
    drift_store.register_event(break_id=break_id, ad_id=ad_id, event=event)

    # Return a 1×1 transparent GIF (some players expect an image response)
    return Response(
        _TRANSPARENT_GIF,
        mimetype="image/gif",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.route("/api/events", methods=["GET"])
def get_events():
    """
    Return recent tracking events.
    Query params:
      ?limit=   default 100
      ?ad_id=   filter by ad
      ?event=   filter by event type
    """
    limit  = int(request.args.get("limit",  100))
    ad_id  = request.args.get("ad_id",  None)
    event  = request.args.get("event",  None)

    events = tracking_store.query(limit=limit, ad_id=ad_id, event=event)
    return jsonify(events)


@app.route("/api/events/clear", methods=["POST"])
def clear_events():
    """Clear all stored tracking events."""
    tracking_store.clear()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# EPG drift  –  cumulative under-fill across /vast requests
# ---------------------------------------------------------------------------

@app.route("/api/drift", methods=["GET"])
def get_drift():
    """
    Return current EPG drift state.
    Query params:
      ?limit=   max number of per-request records to return (default 100)
    """
    limit = int(request.args.get("limit", 100))
    return jsonify(drift_store.snapshot(limit=limit))


@app.route("/api/drift/reset", methods=["POST"])
def reset_drift():
    """Clear drift records and reset the cumulative counter."""
    drift_store.reset()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Web app
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _base_url() -> str:
    """
    The public base URL of this service.
    In production set the BASE_URL environment variable (Railway deploys
    should set this to the public service URL so tracking-pixel URLs
    baked into the VAST XML resolve back here).
    """
    return os.environ.get("BASE_URL", request.host_url.rstrip("/"))


def _parse_duration(raw):
    """
    Parse the ?duration= query param from the VAST request.
    Returns a float of seconds, or None if missing / invalid / non-positive.
    """
    if raw is None or raw == "":
        return None
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return None
    if val <= 0:
        return None
    return val


def _validate_config(body: dict) -> list:
    errors = []
    if not isinstance(body, dict):
        return ["Body must be a JSON object"]

    if "ads" not in body:
        errors.append("ads array is required")
    elif not isinstance(body["ads"], list):
        errors.append("ads must be an array")
    else:
        for i, ad in enumerate(body["ads"]):
            prefix = f"ads[{i}]"
            for field in ("ad_id", "title", "asset_id"):
                if not ad.get(field):
                    errors.append(f"{prefix}.{field} is required")
            if not isinstance(ad.get("duration"), (int, float)) or ad.get("duration", 0) <= 0:
                errors.append(f"{prefix}.duration must be a positive number")
            if not isinstance(ad.get("sequence"), int) or ad.get("sequence", 0) < 1:
                errors.append(f"{prefix}.sequence must be a positive integer")

    return errors


# 1×1 transparent GIF binary
_TRANSPARENT_GIF = (
    b"\x47\x49\x46\x38\x39\x61\x01\x00\x01\x00\x80\x00\x00"
    b"\xff\xff\xff\x00\x00\x00\x21\xf9\x04\x00\x00\x00\x00"
    b"\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02"
    b"\x44\x01\x00\x3b"
)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
#
# In production this module is loaded by gunicorn via the Procfile, so
# the block below only runs for local `python app.py` invocations. Both
# paths honour the same env vars so behaviour is consistent:
#
#   PORT         - port to bind (Railway injects this automatically;
#                  falls back to 5000 locally)
#   FLASK_DEBUG  - "1"/"true" enables Flask's auto-reloader + error
#                  pages. Off by default so hosted deployments don't
#                  leak tracebacks.
#   BASE_URL     - public URL used when building tracking-pixel URLs
#                  inside the VAST XML. See _base_url() above.

def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


if __name__ == "__main__":
    port  = int(os.environ.get("PORT", "5000"))
    debug = _env_flag("FLASK_DEBUG", default=False)
    app.run(debug=debug, host="0.0.0.0", port=port)