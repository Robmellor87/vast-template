# VAST Test Platform

A self-contained VAST 3.0 ad server and dashboard for testing CTV ad
integrations — build ad pods, point a player at the VAST endpoint, watch
drift and render-rate metrics update live, and review break history.

## Quick start

```bash
pip install -r requirements.txt
python app.py
```

Open http://localhost:5000 in your browser. The app ships with a default
pod so you can hit `/vast` immediately without configuring anything.

To simulate a CTV player firing tracking pixels against the running
server, open a second terminal and run:

```bash
python simulate_playout.py
```

The simulator uses duration-scaled quartile timing, so a 30s creative
takes ~30 seconds to "play out" — its `firstQuartile`, `midpoint`,
`thirdQuartile`, and `complete` pixels land at 25%, 50%, 75%, and 100%
of the creative's duration.

## What it does

Build an ad pod by dragging creatives from the library into the pod
zone — changes autosave. Point your CTV player at the VAST URL (shown
in the **VAST URL** tab). As the player plays, the live pod view shows
the creative currently on screen with a synthesised TV-preview card, the
EPG strip marches right-to-left with the live cursor, the drift panel
tracks requested-vs-played across the session, and the render-rate
panel shows what fraction of shipped inventory was actually rendered.

Each completed break lands in the break history below with its quartile
milestones, drift figure, and per-break render rate.

## Endpoints

| Method | Path                   | Description                                                                 |
|--------|------------------------|-----------------------------------------------------------------------------|
| GET    | `/`                    | Web app UI                                                                  |
| GET    | `/vast`                | Core VAST 3.0 XML endpoint — load this into your CTV player                 |
| GET    | `/track`               | Tracking pixel endpoint (hit by the player)                                 |
| GET    | `/api/assets`          | List all creative assets                                                    |
| GET    | `/api/config`          | Get current pod configuration                                               |
| POST   | `/api/config`          | Update pod configuration                                                    |
| POST   | `/api/config/reset`    | Reset to default pod                                                        |
| GET    | `/api/events`          | Recent tracking events (frontend polls this every 2s)                       |
| POST   | `/api/events/clear`    | Clear the tracking event log                                                |
| GET    | `/api/drift`           | Current drift / render-rate snapshot (cumulative totals + per-break records)|
| POST   | `/api/drift/reset`     | Reset cumulative drift and render-rate totals to zero                       |

### VAST URL format

```
https://<host>/vast?break_id=break_1&cb=%%CACHEBUSTER%%&duration=60
```

- `break_id` — label for this ad break, used to correlate tracking pixels
  with the request. The simulator assigns these from a persistent counter
  (`.sim_break_counter`) so successive runs always get unique IDs.
- `cb` — cache buster. Replace `%%CACHEBUSTER%%` with your platform's macro.
- `duration` — optional. The pod duration (in seconds) the player is trying
  to fill. When supplied, the server records EPG drift for this request.

### Pod configuration payload (`POST /api/config`)

```json
{
  "ads": [
    { "ad_id": "spot_001", "title": "30s Spot",   "asset_id": "asset_006", "duration": 30, "sequence": 1 },
    { "ad_id": "spot_002", "title": "6s Bumper",  "asset_id": "asset_001", "duration": 6,  "sequence": 2 }
  ]
}
```

Rules: `sequence` starts at 1 and is unique; `asset_id` must match an
entry in `asset_library.py`. The pod duration is always the sum of ad
durations — it is not stored separately.

## How drift and render rate are calculated

### Tracking events

The player fires one `GET /track?event=…&ad_id=…&break_id=…&sequence=…`
for each of:

| Event           | Fires at              | Credited playback |
|-----------------|-----------------------|-------------------|
| `impression`    | Ad starts rendering   | 0%                |
| `start`         | 0% playback           | 0%                |
| `firstQuartile` | 25% playback          | 25%               |
| `midpoint`      | 50% playback          | 50%               |
| `thirdQuartile` | 75% playback          | 75%               |
| `complete`      | 100% playback         | 100%              |

### Drift (fractional, played-based)

For each `/vast` request the server opens a **pending** record holding
the ads it returned and the requested duration. As tracking pixels
arrive, each ad's highest-so-far milestone ratchets upward; the played
time for the break is the sum of `(highest_fraction × duration)` across
ads. A break is finalised either when every ad hits `complete` or when
it has been idle for 15 seconds (whichever comes first).

```
drift = requested - played     (positive = under-fill)
```

This means a 30s ad that dies at `midpoint` due to a transcode error
represents 15s of played inventory and 15s of drift — not 30s either
way. That matches how a broadcaster thinks about EPG gaps.

### Render rate

Aggregate yield across all finalised breaks:

```
render_rate = Σ played / Σ returned
```

Surfaced on each break card in history, and as a headline figure under
the EPG Drift panel. Colour-coded: ≥99.5% green, ≥90% amber, below that
red. Breaks still in progress don't contribute until they finalise.

## Architecture

Flask backend, vanilla-JS single-page frontend, no build step.

- `app.py` — Flask routes, serves HTML + JSON + VAST XML.
- `asset_library.py` — static list of creatives and their variant URLs.
- `drift_store.py` — thread-safe drift / render-rate store. Pending
  breaks finalise on completion or after 15s of silence.
- `vast_builder.py` — assembles the VAST 3.0 XML.
- `tracker.py` — in-memory tracking event log.
- `config_store.py` — in-memory pod configuration.
- `simulate_playout.py` — CLI simulator that fires VAST and tracking
  pixels against a running server.
- `templates/index.html`, `static/app.js`, `static/style.css` — frontend.

All state except `.sim_break_counter` is in-memory. Restarting the Flask
process resets pod config, event log, drift totals, and break history.

## Asset hosting

Assets are currently defined with placeholder URLs in
`asset_library.py`. For real playback you'll want to host MP4s somewhere
CTV-friendly:

- **AWS S3 + CloudFront** — recommended for CTV bitrates
- **Cloudflare R2** — cost-effective alternative
- **Bunny CDN** — simple video hosting with good CTV support

Update the `_BASE` constant in `asset_library.py` and the `variants`
URLs per asset when real files are available.

## Environment variables

| Variable   | Default        | Description                                                       |
|------------|----------------|-------------------------------------------------------------------|
| `BASE_URL` | auto-detected  | Public URL of this service, used to build tracking pixel URLs     |
