/* Rodalies en directe — front-end only tracker for R2 Sud / R15 / R17.
   Data sources:
   - window.SCHEDULE / STATIONS / LINES from data.js (extracted from the official timetable PDFs)
   - Renfe GTFS-Realtime: https://gtfsrt.renfe.com/trip_updates.json and vehicle_positions.json
*/
(() => {
'use strict';

const TZ = 'Europe/Madrid';
const FEED_TU = 'https://gtfsrt.renfe.com/trip_updates.json';
const FEED_VP = 'https://gtfsrt.renfe.com/vehicle_positions.json';
// gtfsrt.renfe.com sends no Access-Control-Allow-Origin header, so the browser cannot read it directly.
// Renfe URLs are always fetched through this relay (see worker/worker.js); the Configuració field overrides it.
const DEFAULT_PROXY = 'https://rodalies-proxy.raimon-rafols.workers.dev/?url=';
const DEFAULTS = { origin: '71700', destination: '71801', holiday: false, onlyLive: false, gmapsKey: '', proxy: '', feedUrl: FEED_TU };
const REFRESH_MS = 30000;
const R2_FAMILY = new Set(['R2', 'R2S', 'R2N']);

const $ = id => document.getElementById(id);
const settings = loadSettings();

// ---------- time helpers (everything in Europe/Madrid) ----------
const fmtParts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
function madrid(date) {
  const p = {};
  for (const x of fmtParts.formatToParts(date)) p[x.type] = x.value;
  const hour = p.hour === '24' ? 0 : +p.hour;
  return { y: +p.year, m: +p.month, d: +p.day, h: hour, mi: +p.minute, s: +p.second, dow: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday) };
}
// epoch ms for a Madrid civil date (y,m,d) + minutes after midnight (minutes may exceed 1440)
function epochOf(y, m, d, minutes) {
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0) + minutes * 60000;
  for (let i = 0; i < 2; i++) {
    const p = madrid(new Date(guess));
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    guess += (Date.UTC(y, m - 1, d, 0, 0, 0) + minutes * 60000) - asUtc;
  }
  return guess;
}
function hm(str) { const [h, m] = str.split(':').map(Number); return h * 60 + m; }
function fmtHM(ms) { const p = madrid(new Date(ms)); return `${String(p.h).padStart(2,'0')}:${String(p.mi).padStart(2,'0')}`; }
function serviceDay(now) {
  // trains running after midnight belong to the previous "service day" (timetable shows them as 0.xx)
  const p = madrid(now);
  if (p.h < 3) {
    const prev = new Date(Date.UTC(p.y, p.m - 1, p.d) - 86400000);
    const q = madrid(prev); return { y: q.y, m: q.m, d: q.d, dow: q.dow, nowMin: p.h * 60 + p.mi + 1440 };
  }
  return { y: p.y, m: p.m, d: p.d, dow: p.dow, nowMin: p.h * 60 + p.mi };
}
function dayTags(sd) {
  const holiday = settings.holiday;
  const tags = new Set(['all']);
  if (holiday || sd.dow === 0) { tags.add('we'); tags.add('sun'); }
  else if (sd.dow === 6) { tags.add('we'); tags.add('sat'); }
  else { tags.add('wd'); if (sd.dow === 5) tags.add('fri'); if (sd.dow === 1) tags.add('mon'); }
  return tags;
}

// ---------- schedule ----------
function tripsForToday(sd) {
  const tags = dayTags(sd);
  return SCHEDULE.filter(t => tags.has(t.days)).map((t, i) => ({
    id: `${t.line}-${t.train || 's' + i}-${t.stops[0][1]}`,
    line: t.line, train: t.train, type: t.type, src: t.src,
    stops: t.stops.map(([sid, time]) => ({ sid, min: hm(time), sched: epochOf(sd.y, sd.m, sd.d, hm(time)) })),
  }));
}
function stopIndex(trip, sid) { return trip.stops.findIndex(s => s.sid === sid); }

// ---------- realtime ----------
function parseTripId(id) {
  const m = /^\d{4}J(\d{4,6})([A-Za-z]+\d*[A-Za-z]*)$/.exec(id || '');
  return m ? { train: m[1], line: m[2].toUpperCase() } : null;
}
function needsProxy(url) { return /^https?:\/\/gtfsrt\.renfe\.com\//.test(url); }
async function fetchJson(url) {
  const proxy = settings.proxy || DEFAULT_PROXY;
  // Renfe's feed always fails CORS when fetched directly, so don't waste a request on it: go via the relay.
  // Local/fixture URLs are fetched as-is.
  const tryUrls = needsProxy(url) && proxy ? [proxy + encodeURIComponent(url)] : [url];
  let lastErr;
  for (const u of tryUrls) {
    try {
      const r = await fetch(u, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('fetch failed');
}

const state = { trips: [], live: new Map(), vehicles: new Map(), unmatched: [], unknownStops: new Set(), lastOk: null, error: null, sd: null };

function matchRealtime(tuFeed, vpFeed) {
  const sd = state.sd;
  const byTrain = new Map();
  for (const t of state.trips) if (t.train) byTrain.set(t.train, t);
  const live = new Map(); const unmatched = [];
  for (const e of (tuFeed.entity || [])) {
    const tu = e.tripUpdate; if (!tu || !tu.trip) continue;
    const pid = parseTripId(tu.trip.tripId); if (!pid) continue;
    const family = R2_FAMILY.has(pid.line) || /^R1[4-7]$/.test(pid.line) || byTrain.has(pid.train);
    if (!family) continue;
    const cancelled = tu.trip.scheduleRelationship === 'CANCELED';
    const stu = (tu.stopTimeUpdate || [])[0];
    const delaySec = tu.delay ?? stu?.arrival?.delay ?? stu?.departure?.delay ?? 0;
    const skipped = (tu.stopTimeUpdate || []).filter(x => x.scheduleRelationship === 'SKIPPED').map(x => x.stopId);
    const predMs = stu ? +((stu.arrival || stu.departure || {}).time || 0) * 1000 : 0;
    if (stu && !STATIONS[stu.stopId]) state.unknownStops.add(`${stu.stopId} (${pid.line} ${pid.train})`);
    let trip = byTrain.get(pid.train) || null;
    if (!trip && stu && predMs) {
      // R2 trips have no train numbers on the sheet: match by (predicted time - delay) at the reported stop
      const schedMs = predMs - delaySec * 1000;
      let best = null, bestD = 3.5 * 60000;
      for (const t of state.trips) {
        if (!R2_FAMILY.has(t.line)) continue;
        const s = t.stops.find(x => x.sid === stu.stopId); if (!s) continue;
        const d = Math.abs(s.sched - schedMs);
        if (d < bestD) { bestD = d; best = t; }
      }
      trip = best;
    }
    const rec = { tripId: tu.trip.tripId, line: pid.line, train: pid.train, delaySec, cancelled, skipped, stopId: stu?.stopId, predMs, ts: +(tuFeed.header?.timestamp || 0) * 1000 };
    if (trip) live.set(trip.id, rec); else unmatched.push(rec);
  }
  const vehicles = new Map();
  for (const e of (vpFeed?.entity || [])) {
    const v = e.vehicle; if (!v || !v.position) continue;
    const pid = parseTripId(v.trip?.tripId); if (!pid) continue;
    vehicles.set(pid.train + '|' + pid.line, { lat: +v.position.latitude, lng: +v.position.longitude, status: v.currentStatus, stopId: v.stopId, ts: +(v.timestamp || 0) * 1000 });
  }
  state.live = live; state.unmatched = unmatched; state.vehicles = vehicles;
}

// ETA / position for a trip
function tripInfo(trip, nowMs) {
  const rt = state.live.get(trip.id);
  const delayMs = rt ? rt.delaySec * 1000 : 0;
  const stops = trip.stops.map(s => ({ ...s, eta: s.sched + delayMs }));
  const first = stops[0], last = stops[stops.length - 1];
  let status, segFrom = null, segTo = null, frac = 0;
  if (rt?.cancelled) status = 'cancelled';
  else if (nowMs < first.eta - 60000) status = 'notstarted';
  else if (nowMs > last.eta + 120000) status = 'finished';
  else {
    status = 'running';
    for (let i = 0; i < stops.length - 1; i++) {
      if (nowMs >= stops[i].eta && nowMs < stops[i + 1].eta) {
        segFrom = stops[i]; segTo = stops[i + 1];
        frac = (nowMs - stops[i].eta) / Math.max(1, stops[i + 1].eta - stops[i].eta); break;
      }
    }
    if (!segFrom) { segFrom = last; segTo = last; frac = 1; }
  }
  let pos = null; const veh = rt && state.vehicles.get(rt.train + '|' + rt.line);
  if (veh && veh.lat) pos = { lat: veh.lat, lng: veh.lng, gps: true };
  else if (status === 'running' && segFrom && STATIONS[segFrom.sid] && STATIONS[segTo.sid]) {
    const a = STATIONS[segFrom.sid], b = STATIONS[segTo.sid];
    pos = { lat: a.lat + (b.lat - a.lat) * frac, lng: a.lng + (b.lng - a.lng) * frac, gps: false };
  }
  return { rt, delayMin: Math.round(delayMs / 60000), stops, status, segFrom, segTo, frac, pos };
}

// ---------- rendering ----------
function stationName(sid) { return STATIONS[sid]?.name || sid; }
function badge(line) { return `<span class="badge ${line.toLowerCase()}">${LINES[line]?.name || line}</span>`; }
function delayChip(info) {
  if (info.status === 'cancelled') return '<span class="delay cancel">Cancel·lat</span>';
  if (!info.rt) return '<span class="delay sched">programat</span>';
  const d = info.delayMin;
  if (d <= 1 && d >= -1) return '<span class="delay ok">puntual</span>';
  return `<span class="delay ${d > 0 ? 'late' : 'ok'}">${d > 0 ? '+' : ''}${d} min</span>`;
}
function whereText(info, trip) {
  if (info.status === 'notstarted') return `Encara no ha sortit de ${stationName(trip.stops[0].sid)}`;
  if (info.status === 'finished') return `Ha arribat a ${stationName(trip.stops[trip.stops.length - 1].sid)}`;
  if (info.status === 'cancelled') return 'Servei cancel·lat';
  if (info.segFrom === info.segTo) return `A ${stationName(info.segFrom.sid)}`;
  if (info.frac < 0.08) return `Sortint de ${stationName(info.segFrom.sid)}`;
  return `Entre ${stationName(info.segFrom.sid)} i ${stationName(info.segTo.sid)}${info.pos?.gps ? ' (GPS)' : ''}`;
}

function render() {
  const nowMs = Date.now();
  const o = settings.origin, d = settings.destination;
  const rows = [];
  for (const trip of state.trips) {
    const io = stopIndex(trip, o), id = stopIndex(trip, d);
    if (io < 0 || id < 0 || io >= id) continue;
    const info = tripInfo(trip, nowMs);
    if (settings.onlyLive && !info.rt) continue;
    const etaO = info.stops[io].eta, etaD = info.stops[id].eta;
    if (etaO < nowMs - 20 * 60000) continue;           // keep a short history
    rows.push({ trip, info, io, id, etaO, etaD });
  }
  rows.sort((a, b) => a.etaO - b.etaO);
  const nextIdx = rows.findIndex(r => r.etaO >= nowMs - 30000 && r.info.status !== 'cancelled');

  // next-train card
  const nc = $('nextCard');
  if (nextIdx < 0) nc.innerHTML = `<div class="muted">No queden trens ${stationName(o)} → ${stationName(d)} avui amb l'horari carregat.</div>`;
  else {
    const r = rows[nextIdx]; const mins = Math.max(0, Math.round((r.etaO - nowMs) / 60000));
    const sO = r.info.stops[r.io], sD = r.info.stops[r.id];
    nc.innerHTML = `
      <div class="muted small">Proper tren · ${stationName(o)} → ${stationName(d)}</div>
      <div class="big">${mins === 0 ? 'ara' : 'en ' + mins + ' min'} <span class="small">${fmtHM(r.etaO)}</span></div>
      <div class="eta">${badge(r.trip.line)} ${r.trip.train ? '<span class="muted">' + r.trip.train + '</span>' : ''}
        arribada estimada a ${stationName(d)}: <b>${fmtHM(r.etaD)}</b>
        ${r.info.delayMin ? `<span class="muted small">(programat ${fmtHM(sD.sched)})</span>` : ''} ${delayChip(r.info)}</div>
      <div class="sub">${whereText(r.info, r.trip)}</div>`;
  }

  // list
  $('listTitle').textContent = `Trens ${stationName(o)} → ${stationName(d)}`;
  $('list').innerHTML = rows.slice(0, 40).map((r, i) => {
    const sO = r.info.stops[r.io];
    const cls = ['trip', i === nextIdx ? 'next' : '', r.info.rt ? 'live' : '', r.etaO < nowMs - 30000 ? 'past' : ''].join(' ');
    const dep = r.info.delayMin ? `<span class="strike small">${fmtHM(sO.sched)}</span> <b>${fmtHM(r.etaO)}</b>` : `<b>${fmtHM(r.etaO)}</b>`;
    return `<div class="${cls}">
      <div>${badge(r.trip.line)}<div class="muted small">${r.trip.train || ''} ${r.trip.type || ''}</div></div>
      <div>${delayChip(r.info)} <span class="muted small">→ ${stationName(r.trip.stops[r.trip.stops.length - 1].sid)}</span></div>
      <div class="times">${dep} <span class="muted">→</span> ${fmtHM(r.etaD)}</div>
      <div class="where">${whereText(r.info, r.trip)}</div>
    </div>`;
  }).join('') || '<div class="muted">Cap tren per a aquest trajecte.</div>';

  // map + diagnostics
  updateMap(nowMs);
  $('diag').textContent = [
    `Feed: ${state.lastOk ? 'ok ' + fmtHM(state.lastOk) : 'sense dades'} ${state.error ? '· error: ' + state.error : ''}`,
    `Trens del dia carregats: ${state.trips.length} · amb temps real: ${state.live.size} · vehicles amb GPS: ${state.vehicles.size}`,
    `Codis d'estació desconeguts: ${[...state.unknownStops].join(', ') || '—'}`,
    `Trens en directe no casats amb l'horari (${state.unmatched.length}):`,
    ...state.unmatched.slice(0, 40).map(u => `  ${u.tripId} línia ${u.line} tren ${u.train} retard ${u.delaySec}s parada ${u.stopId} ${u.predMs ? fmtHM(u.predMs) : ''}`),
  ].join('\n');
}

// ---------- map (Google Maps if key, else Leaflet/OSM) ----------
const map = { kind: null, obj: null, markers: new Map(), ready: false };
function relevantLines() {
  const o = settings.origin, d = settings.destination;
  return Object.keys(LINES).filter(k => LINES[k].stations.includes(o) && LINES[k].stations.includes(d));
}
function initMap() {
  const lines = relevantLines().length ? relevantLines() : ['R2S', 'R15'];
  const allSt = new Set(lines.flatMap(l => LINES[l].stations));
  $('legend').innerHTML = lines.map(l => `<span><i style="background:${LINES[l].color}"></i>${LINES[l].name}</span>`).join('') + '<span><i style="background:#333;height:10px;width:10px;border-radius:50%"></i>tren (GPS) </span><span><i style="background:#fff;border:2px solid #333;height:8px;width:8px;border-radius:50%"></i>tren (estimat per horari)</span>';
  if (settings.gmapsKey && window.google?.maps) initGoogle(lines, allSt);
  else if (settings.gmapsKey) loadGoogle().then(() => initGoogle(lines, allSt)).catch(() => initLeaflet(lines, allSt));
  else initLeaflet(lines, allSt);
}
function loadGoogle() {
  return new Promise((res, rej) => {
    if (window.google?.maps) return res();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(settings.gmapsKey)}&v=weekly`;
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}
function initGoogle(lines, allSt) {
  const g = google.maps;
  $('map').innerHTML = '';
  const m = new g.Map($('map'), { center: { lat: 41.28, lng: 1.75 }, zoom: 9, mapTypeControl: false, streetViewControl: false });
  for (const l of lines) new g.Polyline({ path: LINES[l].stations.filter(s => STATIONS[s]).map(s => ({ lat: STATIONS[s].lat, lng: STATIONS[s].lng })), strokeColor: LINES[l].color, strokeWeight: 4, strokeOpacity: .9, map: m });
  for (const s of allSt) if (STATIONS[s]) new g.Marker({ position: { lat: STATIONS[s].lat, lng: STATIONS[s].lng }, map: m, title: STATIONS[s].name, icon: { path: g.SymbolPath.CIRCLE, scale: 4, fillColor: '#fff', fillOpacity: 1, strokeColor: '#444', strokeWeight: 1.5 } });
  map.kind = 'google'; map.obj = m; map.ready = true; $('mapInfo').textContent = '(Google Maps)';
  updateMap(Date.now());
}
function initLeaflet(lines, allSt) {
  $('map').innerHTML = '';
  if (typeof L === 'undefined') { $('map').innerHTML = '<div class="muted" style="padding:12px">No s\'ha pogut carregar la llibreria de mapes (sense connexió?).</div>'; return; }
  const m = L.map('map').setView([41.28, 1.75], 9);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(m);
  for (const l of lines) L.polyline(LINES[l].stations.filter(s => STATIONS[s]).map(s => [STATIONS[s].lat, STATIONS[s].lng]), { color: LINES[l].color, weight: 4, opacity: .9 }).addTo(m);
  for (const s of allSt) if (STATIONS[s]) L.circleMarker([STATIONS[s].lat, STATIONS[s].lng], { radius: 4, color: '#444', fillColor: '#fff', fillOpacity: 1, weight: 1.5 }).addTo(m).bindTooltip(STATIONS[s].name);
  map.kind = 'leaflet'; map.obj = m; map.ready = true; $('mapInfo').textContent = '(OpenStreetMap — afegeix una clau de Google Maps a Configuració)';
  updateMap(Date.now());
}
function updateMap(nowMs) {
  if (!map.ready) return;
  const lines = new Set(relevantLines().length ? relevantLines() : ['R2S', 'R15']);
  const seen = new Set();
  for (const trip of state.trips) {
    if (!lines.has(trip.line)) continue;
    const info = tripInfo(trip, nowMs);
    if (info.status !== 'running' || !info.pos) continue;
    seen.add(trip.id);
    const label = `${LINES[trip.line]?.name || trip.line} ${trip.train || ''} → ${stationName(trip.stops[trip.stops.length - 1].sid)}\n${whereText(info, trip)}${info.rt ? ` · retard ${info.delayMin} min` : ' · sense dades en directe'}`;
    const color = LINES[trip.line]?.color || '#333';
    let mk = map.markers.get(trip.id);
    if (map.kind === 'google') {
      const icon = { path: google.maps.SymbolPath.CIRCLE, scale: info.pos.gps ? 7 : 6, fillColor: info.pos.gps ? color : '#fff', fillOpacity: 1, strokeColor: color, strokeWeight: 2.5 };
      if (!mk) { mk = new google.maps.Marker({ map: map.obj }); map.markers.set(trip.id, mk); }
      mk.setPosition(info.pos); mk.setIcon(icon); mk.setTitle(label);
    } else {
      const opt = { radius: info.pos.gps ? 8 : 7, color, fillColor: info.pos.gps ? color : '#fff', fillOpacity: 1, weight: 2.5 };
      if (!mk) { mk = L.circleMarker([info.pos.lat, info.pos.lng], opt).addTo(map.obj).bindTooltip(label); map.markers.set(trip.id, mk); }
      else { mk.setLatLng([info.pos.lat, info.pos.lng]); mk.setStyle(opt); mk.setTooltipContent(label); }
    }
  }
  for (const [id, mk] of map.markers) if (!seen.has(id)) { map.kind === 'google' ? mk.setMap(null) : mk.remove(); map.markers.delete(id); }
}

// ---------- refresh loop ----------
async function refresh() {
  const now = new Date();
  const sd = serviceDay(now);
  if (!state.sd || state.sd.y !== sd.y || state.sd.m !== sd.m || state.sd.d !== sd.d || state.sd.holiday !== settings.holiday) {
    state.sd = { ...sd, holiday: settings.holiday };
    state.trips = tripsForToday(sd);
  }
  setStatus('actualitzant…', 'warn');
  try {
    const feedUrl = settings.feedUrl || FEED_TU;
    const vpUrl = feedUrl === FEED_TU ? FEED_VP : feedUrl.replace(/trip_updates/, 'vehicle_positions');
    const [tu, vp] = await Promise.all([fetchJson(feedUrl), fetchJson(vpUrl).catch(() => null)]);
    matchRealtime(tu, vp);
    state.lastOk = Date.now(); state.error = null;
    const age = tu.header?.timestamp ? Math.round((Date.now() / 1000 - +tu.header.timestamp) / 60) : null;
    setStatus(`en directe · ${state.live.size} trens${age !== null && age > 5 ? ` · feed de fa ${age} min` : ''}`, age !== null && age > 10 ? 'warn' : 'ok');
  } catch (e) {
    state.error = e.message; setStatus('sense temps real (només horari)', 'err');
  }
  render();
}
function setStatus(t, cls) { const s = $('status'); s.textContent = t; s.className = 'status ' + (cls || ''); }

// ---------- settings / UI ----------
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('rodalies-live') || '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() { localStorage.setItem('rodalies-live', JSON.stringify(settings)); }
function fillStations() {
  const ids = [...new Set(Object.values(LINES).flatMap(l => l.stations))].filter(s => STATIONS[s]);
  ids.sort((a, b) => STATIONS[a].name.localeCompare(STATIONS[b].name, 'ca'));
  for (const sel of [$('origin'), $('destination')]) {
    sel.innerHTML = ids.map(s => `<option value="${s}">${STATIONS[s].name}</option>`).join('');
  }
  $('origin').value = settings.origin; $('destination').value = settings.destination;
}
function bind() {
  $('origin').onchange = e => { settings.origin = e.target.value; saveSettings(); onRouteChange(); };
  $('destination').onchange = e => { settings.destination = e.target.value; saveSettings(); onRouteChange(); };
  $('swap').onclick = () => { [settings.origin, settings.destination] = [settings.destination, settings.origin]; $('origin').value = settings.origin; $('destination').value = settings.destination; saveSettings(); onRouteChange(); };
  $('holiday').checked = settings.holiday; $('onlyLive').checked = settings.onlyLive;
  $('holiday').onchange = e => { settings.holiday = e.target.checked; saveSettings(); refresh(); };
  $('onlyLive').onchange = e => { settings.onlyLive = e.target.checked; saveSettings(); render(); };
  $('refresh').onclick = refresh;
  $('toggleSettings').onclick = () => { $('settings').hidden = !$('settings').hidden; };
  $('gmapsKey').value = settings.gmapsKey; $('proxy').value = settings.proxy; $('feedUrl').value = settings.feedUrl;
  $('saveSettings').onclick = () => {
    settings.gmapsKey = $('gmapsKey').value.trim(); settings.proxy = $('proxy').value.trim(); settings.feedUrl = $('feedUrl').value.trim() || FEED_TU;
    saveSettings(); $('settings').hidden = true; map.ready = false; map.markers.clear(); initMap(); refresh();
  };
  $('resetSettings').onclick = () => { localStorage.removeItem('rodalies-live'); location.reload(); };
  const qs = new URLSearchParams(location.search);
  if (qs.get('feed')) settings.feedUrl = qs.get('feed');
  if (qs.get('from') && STATIONS[qs.get('from')]) settings.origin = qs.get('from');
  if (qs.get('to') && STATIONS[qs.get('to')]) settings.destination = qs.get('to');
}
function onRouteChange() { map.ready = false; for (const mk of map.markers.values()) map.kind === 'google' ? mk.setMap(null) : mk.remove(); map.markers.clear(); initMap(); render(); }

fillStations(); bind(); $('origin').value = settings.origin; $('destination').value = settings.destination;
initMap(); refresh();
setInterval(refresh, REFRESH_MS);
setInterval(render, 15000); // keep countdowns fresh between fetches
})();
