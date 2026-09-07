# Rodalies en directe — R2 Sud / R15 / R17

Static, front-end-only web app (no server) that shows, for any origin → destination pair on R2 Sud and the R15/R17 regionals:

- the **next train** and a countdown, with **estimated arrival** (scheduled time + delay reported by Renfe),
- the list of upcoming trains with live delay / cancellation status and **where each train is right now**,
- a **map** with the lines, stations and train positions (Google Maps if you add an API key, OpenStreetMap otherwise),
- a **⇄ button** to flip origin/destination for the return trip.

Default route: Vilanova i la Geltrú → Barcelona-Sants.

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css`, `app.js` | the app |
| `data.js` | stations (Adif codes + coordinates), line geometry, and the full stop-time schedule extracted from the official R2 (01/09/2026) and R15 (10/07/2026) timetable PDFs |
| `tracks.js` | real track geometry per line (polyline + chainage of each station), generated from OpenStreetMap by `tools/build_tracks.py` |
| `tools/build_tracks.py` | regenerates `tracks.js` from the OSM Rodalies route relations (Overpass API, stdlib only) |
| `fixture_trip_updates.json` | a fake feed for testing (`index.html?feed=fixture_trip_updates.json`) |

## Deploy on GitHub Pages

1. Create a repo, copy these files to the root (or `/docs`).
2. Settings → Pages → Source: *Deploy from a branch* → pick the branch/folder → Save.
3. Open `https://<user>.github.io/<repo>/`.

Nothing else to configure. Optional: open **Configuració** in the app to add a Google Maps JavaScript API key (restrict it to your Pages domain in Google Cloud) and/or a CORS proxy.

## CORS relay (Cloudflare Worker)

`worker/worker.js` is a ~40-line Worker that fetches `https://gtfsrt.renfe.com/*` server-side, caches it at the edge for 20 s (Renfe's update interval, so all visitors share one upstream request) and returns it with `Access-Control-Allow-Origin` set. Only `gtfsrt.renfe.com` is relayed and only the origins listed in `ALLOWED_ORIGINS` get the header.

Deploy (free tier is plenty):

```sh
cd worker
npx wrangler login      # first time only
npx wrangler deploy     # prints https://rodalies-proxy.<your-subdomain>.workers.dev
```

Then make sure `DEFAULT_PROXY` in `src/app.js` matches the printed URL (with `/?url=` appended), and add any extra origin you serve the app from to `ALLOWED_ORIGINS` in `worker/worker.js`.

## Data sources

- **Schedule**: `data.js` was generated from the Rodalies PDFs. R15/R17/R14/R16/MD rows carry the train number, so live data is matched by number. R2 rows have no train number on the sheet, so R2 live trips are matched by *predicted time − delay ≈ scheduled time at the reported stop* (±3.5 min).
- **Real time**: Renfe's open GTFS-RT feed, updated every 20 s, no API key, CC BY 4.0:
  - `https://gtfsrt.renfe.com/trip_updates.json` — delay per trip (`tripUpdate.delay`, seconds), next stop, cancellations, skipped stops
  - `https://gtfsrt.renfe.com/vehicle_positions.json` — GPS positions when available
  - Trip IDs look like `5137J15021R15` → train **15021**, line **R15**; stop IDs are Adif station codes (71700 = Vilanova, 71801 = Sants…).
- Estimated time at any station = scheduled time + the trip's current delay. When a train has no GPS entry, its map position is interpolated between stations from the schedule + delay.

## Known limitations / things to check

- **CORS.** `gtfsrt.renfe.com` sends no `Access-Control-Allow-Origin` header, so the browser cannot read the feed directly. The app therefore always fetches Renfe URLs through the Cloudflare Worker in `worker/` (see below). If the worker is unreachable the app falls back to schedule-only (status badge turns red). The *Configuració* panel lets you point at a different proxy (`https://host/?url=` format).
- **Station codes marked `verified:false` in `data.js`** (Garraf, Gavà, Castelldefels, Segur de Calafell) were inferred from the numbering sequence. If a live R2 train at one of those stations is not matched, check the *Diagnòstic* panel: unknown stop IDs are listed there; correct the code in `data.js`.
- The schedule is a snapshot of the printed timetables. Sunday/holiday timetable is applied automatically on Sundays and on public holidays, computed for any year from the Catalonia calendar (fixed dates + Good Friday, Easter Monday) plus Barcelona's two local holidays (Segona Pasqua, La Mercè). Not handled: years where the Generalitat swaps or moves a holiday (e.g. a fixed date falling on Sunday being moved to Monday), and special pre-holiday services (24/31 Dec). Edit `holidaysFor()` in `app.js` if a year differs.
- R17 south of Tarragona (Salou-Port Aventura) and Nord-side stations are not in the schedule; only the França–Sants–Vilanova–Tarragona–Riba-roja corridor is covered.
- Lines on the map and estimated train positions follow the real track from `tracks.js` (OSM route relations R2S, R2, R2N, R15, R17, R14, R16; ODbL). Segments not covered by an OSM relation (R15 beyond Riba-roja, R2N at Estació de França) fall back to straight lines between stations. Re-run `python3 tools/build_tracks.py` if OSM changes or you add a line; it warns about stations that sit far from the track.
- If the browser grants geolocation and the device is in Catalonia, the map centres on the user (blue dot); otherwise it shows the default R2 Sud view.
- The timetable sheets are the only source for stop times; Renfe's static GTFS would be more complete but is a large zip and not CORS-enabled either. If you later want that, download `stop_times.txt` once and regenerate `data.js`.
