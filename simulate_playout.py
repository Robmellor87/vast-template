"""
VAST Playout Simulator
Fires tracking pixel URLs in sequence to mimic a real VAST player.
Run this while the Flask app is running and watch the Live Pod View update.

Usage:
  python simulate_playout.py
"""

import os
import requests
import time
import json

# Target server. Defaults to localhost for local dev; set SIM_BASE_URL
# (or BASE_URL) to point the simulator at a Railway-hosted instance
# without editing this file — e.g.
#     SIM_BASE_URL=https://vast-template.up.railway.app python simulate_playout.py
BASE_URL = os.environ.get("SIM_BASE_URL") or os.environ.get("BASE_URL") or "http://localhost:5000"
BASE_URL = BASE_URL.rstrip("/")

# Persistent break-id counter. Incremented every time we start a new
# break, and stored next to this script so successive runs (and a mid-
# pod Ctrl+C followed by another run) never reuse the same id. Reusing
# ids was muddying break history and per-break drift records.
_COUNTER_FILE   = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".sim_break_counter")
_COUNTER_PREFIX = "sim_break"


def _read_counter() -> int:
    try:
        with open(_COUNTER_FILE, "r") as f:
            return int(f.read().strip() or "0")
    except (FileNotFoundError, ValueError):
        return 0


def _write_counter(n: int) -> None:
    try:
        with open(_COUNTER_FILE, "w") as f:
            f.write(str(n))
    except OSError as e:
        # Non-fatal — worst case we reuse an id, which now just produces
        # two rows in history (also fine post frontend fix).
        print(f"  [WARN] could not persist break counter: {e}")


def next_break_id() -> str:
    """Return the next unique break id, e.g. 'sim_break_042'."""
    n = _read_counter() + 1
    _write_counter(n)
    return f"{_COUNTER_PREFIX}_{n:03d}"

# Tracking events in the order a real player would fire them.
#
# Each milestone has:
#   offset_s  — fixed kick-off offset (seconds) added on top of the
#               fractional position. Lets us model the small handshake
#               gap between the VAST response, the impression pixel,
#               and the start pixel (all of which fire within the first
#               few hundred ms in the real world).
#   fraction  — position as a fraction of the ad's duration, so quartile
#               pixels fire at the same wall-clock points a real player
#               would emit them: 25% / 50% / 75% / 100% of the creative.
#
# Wall-clock time for milestone n is:
#       offset_s_n + fraction_n * ad.duration
# and the inter-event sleep is the difference between successive such
# timestamps (see simulate_break). Hard-coded delays no longer apply —
# a 6s ad takes ~6s to play out, a 30s ad takes ~30s.
EVENT_TIMELINE = [
    { "event": "impression",    "offset_s": 0.30, "fraction": 0.00 },
    { "event": "start",         "offset_s": 0.50, "fraction": 0.00 },
    { "event": "firstQuartile", "offset_s": 0.50, "fraction": 0.25 },
    { "event": "midpoint",      "offset_s": 0.50, "fraction": 0.50 },
    { "event": "thirdQuartile", "offset_s": 0.50, "fraction": 0.75 },
    { "event": "complete",      "offset_s": 0.50, "fraction": 1.00 },
]


def get_current_config():
    """Fetch the current pod config from the API."""
    res = requests.get(f"{BASE_URL}/api/config")
    return res.json()


def fire_pixel(event, ad_id, break_id, sequence):
    """Fire a single tracking pixel."""
    url = f"{BASE_URL}/track"
    params = {
        "event":    event,
        "ad_id":    ad_id,
        "break_id": break_id,
        "sequence": sequence,
    }
    try:
        res = requests.get(url, params=params, timeout=5)
        status = "OK" if res.status_code == 200 else f"HTTP {res.status_code}"
        print(f"  [{status}] {event:<16} ad={ad_id}  break={break_id}  seq={sequence}")
    except Exception as e:
        print(f"  [ERROR] {event} - {e}")


def fetch_vast(break_id, requested_duration):
    """
    Hit the /vast endpoint the way a real player would — with a
    ?duration= so the server can record EPG drift for this request.
    """
    try:
        res = requests.get(
            f"{BASE_URL}/vast",
            params={
                "break_id": break_id,
                "cb":       str(int(time.time() * 1000)),
                "duration": requested_duration,
            },
            timeout=5,
        )
        status = "OK" if res.status_code == 200 else f"HTTP {res.status_code}"
        print(f"  [{status}] GET /vast  break={break_id}  duration={requested_duration}s")
    except Exception as e:
        print(f"  [ERROR] /vast request failed - {e}")


def simulate_break(break_id=None, requested_duration=None):
    """Simulate a full ad break using the current pod configuration.
    If no break_id is supplied, pulls the next one from the persistent
    counter so every invocation produces a unique id."""
    if break_id is None:
        break_id = next_break_id()

    print("\n" + "="*60)
    print(f" VAST Playout Simulator")
    print("="*60)

    config = get_current_config()
    ads    = sorted(config.get("ads", []), key=lambda a: a["sequence"])

    if not ads:
        print("No ads in current config. Add some in the Ad Pod Builder first.")
        return

    ads_total = sum(a.get("duration", 0) for a in ads)

    # Default the player's requested duration to the sum of ad durations
    # we're about to return, so an untouched run is an exact fill.
    if requested_duration is None:
        requested_duration = ads_total

    print(f"\n Break ID       : {break_id}")
    print(f" Ads in pod     : {len(ads)} (total {ads_total}s)")
    print(f" Player wants   : {requested_duration}s")
    print()

    # First: the player fetches VAST (this is what records EPG drift)
    print(f"-" * 60)
    print(" VAST fetch")
    print(f"-" * 60)
    fetch_vast(break_id=break_id, requested_duration=requested_duration)
    time.sleep(0.3)
    print()

    for ad in ads:
        duration = float(ad.get("duration", 0) or 0)

        print(f"-" * 60)
        print(f" Ad {ad['sequence']}: {ad['title']}  ({ad['duration']}s)  [{ad['ad_id']}]")
        print(f"-" * 60)

        # Convert the (offset_s, fraction) timeline into absolute wall-
        # clock timestamps for this specific ad, then sleep between them
        # so pixels fire at the same points a real player would emit
        # them — e.g. midpoint at t=15s on a 30s creative.
        prev_t = 0.0
        for step in EVENT_TIMELINE:
            t = step["offset_s"] + step["fraction"] * duration
            wait = t - prev_t
            if wait > 0:
                time.sleep(wait)
            prev_t = t
            fire_pixel(
                event    = step["event"],
                ad_id    = ad["ad_id"],
                break_id = break_id,
                sequence = ad["sequence"],
            )

        print(f" Ad {ad['sequence']} complete.\n")
        # Short inter-ad gap to mimic the slate/handover between creatives
        time.sleep(0.5)

    print("="*60)
    print(f" Break {break_id} simulation complete.")
    print("="*60 + "\n")


def simulate_multiple_breaks(count=3, gap_seconds=5, requested_duration=None):
    """
    Simulate multiple sequential breaks.
    Useful for testing break history logging and EPG drift accumulation.
    Each break pulls a fresh id from the persistent counter.
    """
    for i in range(1, count + 1):
        simulate_break(requested_duration=requested_duration)
        if i < count:
            print(f"Waiting {gap_seconds}s before next break...\n")
            time.sleep(gap_seconds)


def simulate_continuous(gap_seconds=5, requested_duration=None, break_prefix=None):
    """
    Loop break simulation forever, picking up any pod-config changes
    between iterations. Each break pulls a fresh id from the persistent
    counter. Stops cleanly on Ctrl+C.

    (break_prefix is accepted for backwards-compat but ignored — break
    ids come from the shared counter now.)
    """
    print("\n" + "*"*60)
    print(" Continuous mode — Ctrl+C to stop")
    print("*"*60)

    i = 0
    try:
        while True:
            i += 1
            simulate_break(requested_duration=requested_duration)
            print(f"Waiting {gap_seconds}s before next break... (Ctrl+C to stop)\n")
            time.sleep(gap_seconds)
    except KeyboardInterrupt:
        print("\n" + "*"*60)
        print(f" Stopped after {i} break(s).")
        print("*"*60 + "\n")


def _prompt_duration(default_hint="press Enter for configured pod duration"):
    """
    Ask the user for the requested pod duration (in seconds) to pass on
    the VAST request via ?duration=. Blank input -> None (server will
    record but drift will fall back to pod_duration default behaviour).
    """
    raw = input(f"Requested pod duration in seconds ({default_hint}): ").strip()
    if not raw:
        return None
    try:
        val = float(raw)
        if val <= 0:
            print("  Duration must be positive; falling back to default.")
            return None
        # Prefer int display when it's a whole number
        return int(val) if val.is_integer() else val
    except ValueError:
        print("  Not a number; falling back to default.")
        return None


if __name__ == "__main__":
    import sys

    print("\nVAST Playout Simulator")
    print("Make sure Flask is running at", BASE_URL)
    print()
    print("Options:")
    print("  1 - Simulate a single break")
    print("  2 - Simulate 3 breaks in sequence")
    print("  3 - Simulate a single break with custom break ID")
    print("  4 - Loop forever (Ctrl+C to stop)")
    print()

    choice = input("Enter option (1/2/3/4): ").strip()

    if choice == "1":
        requested = _prompt_duration()
        simulate_break(requested_duration=requested)

    elif choice == "2":
        requested = _prompt_duration()
        simulate_multiple_breaks(count=3, gap_seconds=5, requested_duration=requested)

    elif choice == "3":
        custom_id = input("Enter break ID (e.g. my_break_001): ").strip()
        if not custom_id:
            custom_id = "custom_break_001"
        requested = _prompt_duration()
        simulate_break(break_id=custom_id, requested_duration=requested)

    elif choice == "4":
        requested = _prompt_duration()
        gap_raw = input("Gap between breaks in seconds (press Enter for 5): ").strip()
        try:
            gap = float(gap_raw) if gap_raw else 5.0
            if gap < 0:
                gap = 5.0
        except ValueError:
            gap = 5.0
        simulate_continuous(gap_seconds=gap, requested_duration=requested)

    else:
        print("Invalid option, running single break simulation.")
        requested = _prompt_duration()
        simulate_break(requested_duration=requested)