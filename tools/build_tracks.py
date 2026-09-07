#!/usr/bin/env python3
"""Build src/tracks.js: real track geometry for each line, from OpenStreetMap route relations.

For every line in src/data.js (window.LINES) that has an OSM relation id in RELATIONS below:
  1. fetch the relation's member ways with geometry from the Overpass API,
  2. stitch the ways into one continuous polyline (greedy endpoint matching; fails on gaps > MAX_GAP_M),
  3. project each of the line's stations onto the polyline to get its chainage (metres from the start),
     making sure the chainages increase in the line's station order (reversing the polyline if needed),
  4. clip the polyline to the span covered by the line's stations (+ a small margin) and simplify it
     with Douglas-Peucker at SIMPLIFY_M tolerance,
  5. write everything to src/tracks.js as window.TRACKS = { line: { pts: [[lat,lng],...], st: { stop_id: chainage_m } } }.

Run:  python3 tools/build_tracks.py            (needs network access; no third-party packages)
Data © OpenStreetMap contributors, ODbL.
"""
import json
import math
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA_JS = os.path.join(ROOT, 'src', 'data.js')
OUT_JS = os.path.join(ROOT, 'src', 'tracks.js')
OVERPASS = 'https://overpass-api.de/api/interpreter'

# OSM route relations (type=route, route=train, network=Rodalies de Catalunya), one direction each.
RELATIONS = {
    'R2S': 5757328,   # Barcelona-Estació de França => Sant Vicenç de Calders (via Vilanova)
    'R2':  197521,    # Castelldefels => Granollers Centre
    'R2N': 5837974,   # Aeroport => Maçanet-Massanes
    'R15': 6028431,   # Barcelona-Estació de França => Riba-roja d'Ebre (via Reus)
    'R17': 10578983,  # Barcelona-Estació de França => Salou-Port Aventura
    'R14': 1964024,   # Barcelona-Estació de França => Lleida-Pirineus
    'R16': 5913126,   # Barcelona-Estació de França => Ulldecona-Alcanar-La Sénia
    'MD':  6028431,   # same track as the R15
}
MAX_GAP_M = 250        # a jump between consecutive ways larger than this is a broken relation
MAX_STATION_OFF_M = 400  # station coordinate farther than this from the track = wrong code/coords
SIMPLIFY_M = 8
CLIP_MARGIN_M = 300


# ---------- geometry (local equirectangular projection in metres) ----------
def proj(lat, lng, lat0):
    k = math.cos(math.radians(lat0))
    return (math.radians(lng) * 6371000 * k, math.radians(lat) * 6371000)


def d2(a, b):
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def dist(a, b):
    return math.sqrt(d2(a, b))


def project_point_to_segment(p, a, b):
    """Return (t, point) where t in [0,1] is the position along a->b of the closest point to p."""
    ab = (b[0] - a[0], b[1] - a[1])
    l2 = ab[0] ** 2 + ab[1] ** 2
    if l2 == 0:
        return 0.0, a
    t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2
    t = max(0.0, min(1.0, t))
    return t, (a[0] + ab[0] * t, a[1] + ab[1] * t)


def douglas_peucker(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        a, b = pts[i], pts[j]
        best, bi = -1.0, -1
        for k in range(i + 1, j):
            _, q = project_point_to_segment(pts[k], a, b)
            dd = d2(pts[k], q)
            if dd > best:
                best, bi = dd, k
        if bi >= 0 and best > tol * tol:
            keep[bi] = True
            stack.append((i, bi))
            stack.append((bi, j))
    return [p for p, k in zip(pts, keep) if k]


# ---------- data.js ----------
def load_data_js():
    src = open(DATA_JS, encoding='utf-8').read()
    def grab(name):
        m = re.search(r'window\.%s\s*=\s*(\{.*?\});?\s*$' % name, src, re.M | re.S)
        if not m:
            sys.exit('cannot find window.%s in data.js' % name)
        # the object ends at the first "};" that ends a line; be robust to nested braces
        text = m.group(1)
        depth, end = 0, None
        for i, ch in enumerate(text):
            if ch == '{': depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        return json.loads(text[:end])
    return grab('STATIONS'), grab('LINES')


# ---------- Overpass ----------
def overpass(query, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(OVERPASS, data=query.encode('utf-8'),
                                         headers={'User-Agent': 'rodalies-live build_tracks.py'})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            print('  overpass error (%s), retrying…' % e)
            time.sleep(5 * (attempt + 1))
    sys.exit('overpass failed')


def fetch_relation_ways(rel_id):
    """Return list of (way_id, [(lat,lng),...]) in relation member order, excluding platforms/stops."""
    q = '[out:json][timeout:180];rel(%d);out body;way(r);out geom;' % rel_id
    data = overpass(q)
    rel = next(e for e in data['elements'] if e['type'] == 'relation')
    ways = {e['id']: e for e in data['elements'] if e['type'] == 'way'}
    out = []
    for m in rel['members']:
        if m['type'] != 'way' or m['ref'] not in ways:
            continue
        w = ways[m['ref']]
        tags = w.get('tags', {})
        role = m.get('role', '')
        if role.startswith('platform') or role.startswith('stop') or tags.get('railway') == 'platform':
            continue
        if 'geometry' not in w:
            continue
        out.append((w['id'], [(p['lat'], p['lon']) for p in w['geometry']]))
    return rel.get('tags', {}).get('name', str(rel_id)), out


# ---------- stitching ----------
def stitch(ways, lat0):
    """Greedy chain: start with the first way, repeatedly append the unused way whose endpoint is nearest
    to the current end (reversing it if needed). Returns list of (lat,lng) and the largest gap seen."""
    if not ways:
        sys.exit('relation has no ways')
    remaining = [list(pts) for _, pts in ways]
    chain = remaining.pop(0)
    max_gap = 0.0
    # try to grow at the end; if nothing close, try to grow at the start
    while remaining:
        best = None
        for idx, w in enumerate(remaining):
            for rev in (False, True):
                cand = w[::-1] if rev else w
                g_end = dist(proj(*chain[-1], lat0), proj(*cand[0], lat0))
                g_start = dist(proj(*chain[0], lat0), proj(*cand[-1], lat0))
                for where, g in (('end', g_end), ('start', g_start)):
                    if best is None or g < best[0]:
                        best = (g, idx, rev, where)
        g, idx, rev, where = best
        w = remaining.pop(idx)
        if rev:
            w = w[::-1]
        if g > MAX_GAP_M:
            print('  WARNING: gap of %.0f m when attaching way (%d ways left); stopping here' % (g, len(remaining)))
            break
        max_gap = max(max_gap, g)
        if where == 'end':
            chain.extend(w[1:] if g == 0 else w)
        else:
            chain = (w[:-1] if g == 0 else w) + chain
    return chain, max_gap


def build_line(line, rel_id, stations_all, lines):
    name, ways = fetch_relation_ways(rel_id)
    stations = [s for s in lines[line]['stations'] if s in stations_all]
    if len(stations) < 2:
        print('  skip %s: fewer than 2 known stations' % line)
        return None
    lat0 = stations_all[stations[0]]['lat']
    print('  %s: relation %d "%s", %d ways' % (line, rel_id, name, len(ways)))
    chain, max_gap = stitch(ways, lat0)
    # drop consecutive duplicates
    pts = [chain[0]]
    for p in chain[1:]:
        if p != pts[-1]:
            pts.append(p)
    xy = [proj(la, ln, lat0) for la, ln in pts]
    cum = [0.0]
    for i in range(1, len(xy)):
        cum.append(cum[-1] + dist(xy[i - 1], xy[i]))
    print('    stitched %d points, %.1f km, max gap %.0f m' % (len(pts), cum[-1] / 1000, max_gap))

    # station chainages
    chain_of = {}
    for sid in stations:
        st = stations_all[sid]
        p = proj(st['lat'], st['lng'], lat0)
        best = None
        for i in range(len(xy) - 1):
            t, q = project_point_to_segment(p, xy[i], xy[i + 1])
            dd = d2(p, q)
            if best is None or dd < best[0]:
                best = (dd, cum[i] + t * dist(xy[i], xy[i + 1]))
        off = math.sqrt(best[0])
        if off > MAX_STATION_OFF_M:
            # not on this relation (line continues beyond the OSM route, or bad coordinates): leave it out so the
            # app falls back to station-to-station geometry for segments touching it
            print('    WARNING: %s %s is %.0f m from the track, excluded (line continues past the OSM route, or bad coordinates?)' % (sid, st['name'], off))
            continue
        chain_of[sid] = best[1]
    stations = [s for s in stations if s in chain_of]
    if len(stations) < 2:
        print('    skip: fewer than 2 stations on the track')
        return None
    # orient in station order
    seq = [chain_of[s] for s in stations]
    if seq[0] > seq[-1]:
        pts.reverse(); xy.reverse()
        total = cum[-1]
        cum = [total - c for c in reversed(cum)]
        chain_of = {s: total - c for s, c in chain_of.items()}
        seq = [chain_of[s] for s in stations]
    bad = [(stations[i], stations[i + 1]) for i in range(len(seq) - 1) if seq[i + 1] <= seq[i]]
    if bad:
        print('    WARNING: station order not monotonic along track for %s' % bad)

    # clip to the span of the line's stations
    lo = max(0.0, min(seq) - CLIP_MARGIN_M)
    hi = min(cum[-1], max(seq) + CLIP_MARGIN_M)
    clipped = [xy[i] for i in range(len(xy)) if lo <= cum[i] <= hi]
    # add exact cut points at lo/hi
    def point_at(c):
        for i in range(1, len(cum)):
            if cum[i] >= c:
                seg = cum[i] - cum[i - 1]
                t = (c - cum[i - 1]) / seg if seg else 0
                return (xy[i - 1][0] + (xy[i][0] - xy[i - 1][0]) * t, xy[i - 1][1] + (xy[i][1] - xy[i - 1][1]) * t)
        return xy[-1]
    clipped = [point_at(lo)] + clipped + [point_at(hi)]
    simplified = douglas_peucker(clipped, SIMPLIFY_M)
    # back to lat/lng
    k = math.cos(math.radians(lat0))
    out_pts = [[round(math.degrees(y / 6371000), 5), round(math.degrees(x / (6371000 * k)), 5)] for x, y in simplified]
    st_out = {s: round(c - lo, 1) for s, c in chain_of.items()}
    print('    clipped to %.1f km, simplified to %d points' % ((hi - lo) / 1000, len(out_pts)))
    return {'pts': out_pts, 'st': st_out, 'osm': rel_id}


def main():
    stations, lines = load_data_js()
    tracks = {}
    cache = {}
    for line in lines:
        rel = RELATIONS.get(line)
        if not rel:
            print('  %s: no OSM relation configured, will fall back to station-to-station' % line)
            continue
        key = (rel, tuple(lines[line]['stations']))
        if key in cache:
            tracks[line] = cache[key]
            continue
        t = build_line(line, rel, stations, lines)
        if t:
            tracks[line] = t
            cache[key] = t
        time.sleep(6)  # be nice to Overpass (429 otherwise)
    body = json.dumps(tracks, separators=(',', ':'), ensure_ascii=False)
    with open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write('// Generated by tools/build_tracks.py from OpenStreetMap route relations. Do not edit by hand.\n')
        f.write('// Track geometry © OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright).\n')
        f.write('// pts: [lat,lng] polyline along the line; st: chainage in metres of each stop_id along pts.\n')
        f.write('window.TRACKS=' + body + ';\n')
    print('wrote %s (%.0f KB)' % (OUT_JS, os.path.getsize(OUT_JS) / 1024))


if __name__ == '__main__':
    main()
