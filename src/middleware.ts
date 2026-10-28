import { NextResponse } from 'next/server';
import type { NextRequest, NextFetchEvent } from 'next/server';

/* Access gate (hinoki/build-out): HTTP Basic Auth in front of the whole app
   when OSIRIS_GATE_USER and OSIRIS_GATE_PASSWORD are set in the environment
   (the Railway deployment sets them; RALPH chooses the values at deploy time
   — no credential ever lives in this repo). When either variable is unset
   (local development), the gate is off and behavior is upstream's.
   /api/health is exempt so Railway healthchecks and uptime probes pass
   without credentials. Static build assets (_next/static, vendor files) are
   outside the matcher below: they are content-hashed chunks that carry no
   feed data, while every page and API route — the surfaces that do — is
   gated. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

function gateCheck(request: NextRequest): NextResponse | null {
  const user = process.env.OSIRIS_GATE_USER;
  const pass = process.env.OSIRIS_GATE_PASSWORD;
  if (!user || !pass) return null; // gate not configured — local dev
  if (request.nextUrl.pathname === '/api/health') return null; // healthchecks stay open

  const header = request.headers.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    try {
      const decoded = atob(encoded);
      const sep = decoded.indexOf(':');
      if (sep >= 0) {
        const okUser = timingSafeEqual(decoded.slice(0, sep), user);
        const okPass = timingSafeEqual(decoded.slice(sep + 1), pass);
        if (okUser && okPass) return null;
      }
    } catch {
      /* malformed credentials fall through to the 401 */
    }
  }
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="OSIRIS", charset="UTF-8"' },
  });
}

export function middleware(request: NextRequest, event: NextFetchEvent) {
  const url = request.nextUrl.pathname;

  const denied = gateCheck(request);
  if (denied) return denied;

  /* API routes are admitted by the second matcher entry for the gate only.
     Analytics never fires for them (that was the original matcher's intent),
     so pass them straight through once the gate is satisfied. */
  if (url.startsWith('/api/')) {
    return NextResponse.next();
  }

  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '127.0.0.1';
  const userAgent = request.headers.get('user-agent') || 'Unknown OSIRIS Client';
  
  const basePayload = {
    hostname: request.nextUrl.hostname,
    language: "en-US",
    referrer: request.headers.get('referer') || "",
    screen: "1920x1080",
    title: "OSIRIS",
    url: url,
    website: process.env.UMAMI_WEBSITE_ID || "cd8f216c-fc3f-45f5-ba1a-e10309a61d18"
  };

  /* Bounded, because these are fire-and-forget analytics on the critical path.
     `umami-umami-1` only resolves inside the production compose network; on a
     developer's machine it is ENOTFOUND, and two unbounded requests per page
     view accumulated against the shared connection pool until the app's own
     API routes could not get a socket. The CCTV route would then time out
     region after region and the map came up half empty — the analytics were
     starving the thing they were measuring. */
  const pageView = fetch('http://umami-umami-1:3000/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent, 'x-forwarded-for': ip },
    body: JSON.stringify({ payload: basePayload, type: "event" }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});

  const ipEvent = fetch('http://umami-umami-1:3000/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent, 'x-forwarded-for': ip },
    body: JSON.stringify({
      payload: { ...basePayload, name: "Network Log", data: { IP: ip } },
      type: "event"
    }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});

  event.waitUntil(Promise.all([pageView, ipEvent]));

  return NextResponse.next();
}

/* Assets are excluded, not just pages. MapLibre 6 loads its worker from
   /vendor/maplibre/<version>/ at runtime, and the basemap style from
   /dark-matter-style.json — neither is under _next/static, so both used to
   match here and pay two umami round trips before the map could start. That is
   the same starvation that 2f375dd fixed for the CCTV routes, moved onto the
   map's critical path. Analytics wants page views; asset fetches are not one. */
export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|vendor|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mjs|js|css|json|pbf|mvt|woff|woff2|ico|txt)$).*)',
    /* hinoki/build-out: API routes are matched so the access gate above can
       run for them; the middleware function passes them through without
       analytics once the gate is satisfied. /api/health is exempted inside
       the gate itself. */
    '/api/:path*',
  ],
}
