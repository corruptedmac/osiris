import { cachedSource } from '@/lib/sourceCache';
import { parseWkt } from './ibi511';
import type { CctvCamera } from './types';

/**
 * OSIRIS — Texas CCTV Cameras, video layer (TxDOT DriveTexas / MapLarge)
 * Source: https://drivetexas.org — a React app backed by AppGeo's MapLarge
 * Data endpoint: GET https://dtx-e-cdn.maplarge.com/Api/ProcessDirect
 * ~3,410 statewide traffic cameras with HLS streams — NO API KEY NEEDED.
 *
 * The its.txdot.gov inventory in texas.ts knows where the cameras are but
 * carries no video field at all — snapshots only. DriveTexas is the separate
 * system that holds the streams: every cameraPoint record carries a direct
 * SkyVDN playlist in `httpsurl`. This fetcher is the video half of the Texas
 * region; route.ts concatenates the two.
 *
 * The endpoint's rules, reverse-engineered from drivetexas.org and PROVED
 * against the live endpoint (Oct 28, from the site's own production JS
 * bundle + live probe queries):
 *   • The query is one URL-encoded JSON object:
 *     {"action":"table/query","query":{"sqlselect":[...],"start":n,
 *      "table":"appgeo/cameraPoint","take":500}}.
 *   • Origin/Referer must be drivetexas.org or the request is rejected.
 *   • Server-side `where` filtering is NOT supported — any filter
 *     expression returns HTTP 500. Pages of 500 are fetched and filtered
 *     client-side, against `data.totals.Records`.
 *   • The response is columnar: data.data is one parallel array per field.
 *   • The current cameraPoint schema is NARROW — sqlselect may only name
 *     columns that exist, or MapLarge's SQL layer returns its generic
 *     HTTP 500 page. Proved valid: description, name, httpsurl, imageurl,
 *     XY. (An earlier field list naming jurisdiction/route/active/line
 *     500'd the whole query — bad columns, not an egress wall.)
 *   • Point geometry rides in the `XY` column as WKT —
 *     "POINT (-96.8077 32.8349)" — parsed with the same parseWkt the 511
 *     stack uses.
 *   • `httpsurl` is passed through VERBATIM: it may carry a token query
 *     parameter, so it is never stripped or rebuilt.
 *   • `imageurl` is an internal https://localhost/thumbs/<id>.flv.png
 *     address reachable only inside the TxDOT network, so it is NOT a
 *     snapshot feed a browser could load. It is carried into feed_url only
 *     if a real http(s) host ever shows up in it; until then these records
 *     have no snapshot behind the video.
 *   • The camera `name` is a device code, TX_<DISTRICT>_<n>
 *     (TX_DAL_…, TX_FTW_…, TX_ELP_…). With no jurisdiction column in the
 *     proved schema, district scoping is a prefix match on that code.
 *
 * Wiring scope is the Dallas district. Widening it is a one-line change:
 * add the district's city label and its device-code prefix to
 * DRIVETEXAS_PREFIXES below (Fort Worth is 'TX_FTW_').
 */

const MAPLARGE_URL = 'https://dtx-e-cdn.maplarge.com/Api/ProcessDirect';
const PAGE_SIZE = 500; // the endpoint caps a response at 500 rows
const MAX_PAGES = 10; // safety bound (~5000 rows) so a bad total can't fan out forever

/* Proved cameraPoint columns ONLY — naming a column that does not exist
   makes the whole query fail with HTTP 500. */
const CAMERA_FIELDS = ['description', 'name', 'httpsurl', 'imageurl', 'XY'];

/** YOMI city label → the TX_<DISTRICT>_ device-code prefix that scopes it. */
export const DRIVETEXAS_PREFIXES: Record<string, string> = {
  Dallas: 'TX_DAL_',
};

/** Texas bounding box — the same one texas.ts applies to its inventory. */
const TX_BOUNDS = { minLat: 25.8, maxLat: 36.6, minLng: -106.7, maxLng: -93.4 };

/** One cameraPoint row after the columnar response is transposed. */
export interface DriveTexasCameraRow {
  description?: unknown;
  name?: unknown;
  httpsurl?: unknown;
  imageurl?: unknown;
  XY?: unknown;
}

/** Transpose MapLarge's columnar data block into row objects. */
function columnarToRows(data: unknown): DriveTexasCameraRow[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const columns = Object.entries(data as Record<string, unknown>)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]));
  if (!columns.length) return [];
  const length = columns[0][1].length;
  const rows: DriveTexasCameraRow[] = [];
  for (let i = 0; i < length; i++) {
    const row: Record<string, unknown> = {};
    for (const [field, values] of columns) row[field] = values[i];
    rows.push(row);
  }
  return rows;
}

const asTrimmedString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/** The video address, but only when it is actually an HLS playlist. */
function hlsUrl(url: unknown): string | undefined {
  const trimmed = asTrimmedString(url);
  return trimmed && /\.m3u8(\?|$)/i.test(trimmed) ? trimmed : undefined;
}

/**
 * The snapshot address, but only when a browser could actually load it —
 * DriveTexas's own imageurl points at a localhost host inside the TxDOT
 * network, and handing that to the viewer as a fallback still would be a
 * broken promise, so it is withheld rather than passed through.
 */
function publicSnapshotUrl(url: unknown): string | undefined {
  const trimmed = asTrimmedString(url);
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost')) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

/** Map one row to a CctvCamera for the given city, or null to skip it. */
function mapRow(row: DriveTexasCameraRow, code: string, city: string): CctvCamera | null {
  const video = hlsUrl(row.httpsurl);
  if (!video) return null; // this source exists to add video; a row without any adds nothing

  const coords = parseWkt(typeof row.XY === 'string' ? row.XY : null);
  if (!coords) return null;
  const { lat, lng } = coords;
  if (lat < TX_BOUNDS.minLat || lat > TX_BOUNDS.maxLat) return null;
  if (lng < TX_BOUNDS.minLng || lng > TX_BOUNDS.maxLng) return null;

  const snapshot = publicSnapshotUrl(row.imageurl);
  const name = asTrimmedString(row.description) || code;

  return {
    id: `drivetexas-${code}`,
    lat,
    lng,
    name,
    city,
    country: 'US',
    ...(snapshot ? { feed_url: snapshot } : {}),
    stream_url: video,
    stream_type: 'hls' as const,
    external_url: 'https://drivetexas.org',
    source: 'TxDOT DriveTexas',
  };
}

/**
 * Map a full ProcessDirect response to cameras in the scoped districts.
 * Throws on a failed or malformed response, in the style of
 * mapTexasInventory, so the loader treats it as an upstream failure.
 */
export function mapDriveTexasResponse(
  data: unknown,
  prefixes: Record<string, string> = DRIVETEXAS_PREFIXES,
): CctvCamera[] {
  const response = data as { success?: unknown; data?: { data?: unknown } } | null;
  if (!response || response.success !== true) {
    throw new Error('DriveTexas query failed');
  }
  const block = response.data?.data;
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error('DriveTexas response is missing its data block');
  }
  const scopes = Object.entries(prefixes)
    .map(([city, prefix]) => ({ city, prefix: prefix.toUpperCase() }));
  const cameras = new Map<string, CctvCamera>();
  for (const row of columnarToRows(block)) {
    const code = asTrimmedString(row.name);
    if (!code) continue;
    const scope = scopes.find(s => code.toUpperCase().startsWith(s.prefix));
    if (!scope) continue;
    const camera = mapRow(row, code, scope.city);
    if (camera) cameras.set(camera.id, camera);
  }
  return [...cameras.values()];
}

function pageUrl(start: number): string {
  const request = {
    action: 'table/query',
    query: {
      sqlselect: CAMERA_FIELDS,
      start,
      table: 'appgeo/cameraPoint',
      take: PAGE_SIZE,
    },
  };
  return `${MAPLARGE_URL}?${new URLSearchParams({ request: JSON.stringify(request) })}`;
}

async function fetchPage(start: number): Promise<unknown> {
  const response = await fetch(pageUrl(start), {
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://drivetexas.org',
      Referer: 'https://drivetexas.org/',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!response.ok) throw new Error(`DriveTexas: HTTP ${response.status}`);
  return response.json();
}

function totalRecords(data: unknown): number {
  const total = Number(
    (data as { data?: { totals?: { Records?: unknown } } } | null)?.data?.totals?.Records,
  );
  return Number.isFinite(total) && total > 0 ? total : 0;
}

async function loadDriveTexasCameras(): Promise<CctvCamera[]> {
  // The first page also tells us how many records there are in total.
  const first = await fetchPage(0);
  const starts: number[] = [];
  for (let s = PAGE_SIZE; s < totalRecords(first) && s < PAGE_SIZE * MAX_PAGES; s += PAGE_SIZE) {
    starts.push(s);
  }
  const results = await Promise.allSettled(starts.map(s => fetchPage(s)));

  const seen = new Map<string, CctvCamera>();
  const ingest = (page: unknown) => {
    for (const camera of mapDriveTexasResponse(page)) seen.set(camera.id, camera);
  };
  ingest(first);
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    try {
      ingest(result.value);
    } catch {
      // One malformed page must not discard the pages that parsed.
    }
  }

  const cameras = [...seen.values()];
  console.log(`[OSIRIS] Texas cameras — TxDOT DriveTexas: ${cameras.length}`);
  return cameras;
}

export const fetchDriveTexasCameras = cachedSource('drivetexas', loadDriveTexasCameras);
