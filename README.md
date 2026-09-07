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
| `fixture_trip_updates.json` | a fake feed for testing (`index.html?feed=fixture_trip_updates.json`) |

## Deploy on GitHub Pages

1. Create a repo, copy these files to the root (or `/docs`).
2. Settings → Pages → Source: *Deploy from a branch* → pick the branch/folder → Save.
3. Open `https://<user>.github.io/<repo>/`.

Nothing else to configure. Optional: open **Configuració** in the app to add a Google Maps JavaScript API key (restrict it to your Pages domain in Google Cloud) and/or a CORS proxy.

## Data sources

- **Schedule**: `data.js` was generated from the Rodalies PDFs. R15/R17/R14/R16/MD rows carry the train number, so live data is matched by number. R2 rows have no train number on the sheet, so R2 live trips are matched by *predicted time − delay ≈ scheduled time at the reported stop* (±3.5 min).
- **Real time**: Renfe's open GTFS-RT feed, updated every 20 s, no API key, CC BY 4.0:
  - `https://gtfsrt.renfe.com/trip_updates.json` — delay per trip (`tripUpdate.delay`, seconds), next stop, cancellations, skipped stops
  - `https://gtfsrt.renfe.com/vehicle_positions.json` — GPS positions when available
  - Trip IDs look like `5137J15021R15` → train **15021**, line **R15**; stop IDs are Adif station codes (71700 = Vilanova, 71801 = Sants…).
- Estimated time at any station = scheduled time + the trip's current delay. When a train has no GPS entry, its map position is interpolated between stations from the schedule + delay.

## Known limitations / things to check

- **CORS.** The feed is fetched directly from the browser. If Renfe's server does not send `Access-Control-Allow-Origin`, the browser blocks it and the app falls back to schedule-only (status badge turns red). Fix: paste a CORS proxy URL in *Configuració* (e.g. a 10-line Cloudflare Worker that forwards `?url=` and adds the header; free tier is plenty for one user polling every 30 s). Public proxies such as `https://corsproxy.io/?url=` also work but are not reliable.
- **Station codes marked `verified:false` in `data.js`** (Garraf, Gavà, Castelldefels, Segur de Calafell) were inferred from the numbering sequence. If a live R2 train at one of those stations is not matched, check the *Diagnòstic* panel: unknown stop IDs are listed there; correct the code in `data.js`.
- The schedule is a snapshot of the printed timetables. Holidays are not auto-detected — tick *Avui és festiu*.
- R17 south of Tarragona (Salou-Port Aventura) and Nord-side stations are not in the schedule; only the França–Sants–Vilanova–Tarragona–Riba-roja corridor is covered.
- Line drawings on the map are straight segments between stations, not the real track.
- The timetable sheets are the only source for stop times; Renfe's static GTFS would be more complete but is a large zip and not CORS-enabled either. If you later want that, download `stop_times.txt` once and regenerate `data.js`.
