/* CORS relay for Renfe's GTFS-RT feed (Cloudflare Worker).
   Renfe serves https://gtfsrt.renfe.com/*.json without Access-Control-Allow-Origin,
   so the browser refuses to read it. This worker fetches the feed server-side, caches it
   at the edge for one feed period (20 s) and returns it with the CORS header set.

   Usage from the app:  https://<worker-host>/?url=https%3A%2F%2Fgtfsrt.renfe.com%2Ftrip_updates.json
   Deploy:              cd worker && npx wrangler deploy
*/

const UPSTREAM = 'https://gtfsrt.renfe.com/';
const ALLOWED_ORIGINS = new Set([
  'https://blog.rafols.org',
  'https://rrafols.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
]);
const DEFAULT_ORIGIN = 'https://blog.rafols.org';
const CACHE_TTL_S = 20; // Renfe regenerates the feed every ~20 s

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : DEFAULT_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: cors });

    const target = new URL(request.url).searchParams.get('url') || '';
    if (!target.startsWith(UPSTREAM) || target.includes('..')) {
      return new Response('forbidden: only gtfsrt.renfe.com is relayed', { status: 403, headers: cors });
    }

    let upstream;
    try {
      upstream = await fetch(target, { cf: { cacheTtl: CACHE_TTL_S, cacheEverything: true } });
    } catch (e) {
      return new Response('upstream error: ' + e.message, { status: 502, headers: cors });
    }

    const headers = new Headers();
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    headers.set('Cache-Control', `public, max-age=${CACHE_TTL_S}`);
    const lm = upstream.headers.get('Last-Modified'); if (lm) headers.set('Last-Modified', lm);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
