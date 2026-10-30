import { NextResponse } from 'next/server';
import { getDriveTexasSync } from '../drivetexas-sync';

export const runtime = 'nodejs';

/**
 * GET /api/cctv/drivetexas-sync — the DriveTexas (Dallas) camera catalogue
 * as a snapshot + watermark protocol (see drivetexas-sync.ts):
 *
 *   no `since`            → { mode: 'snapshot', watermark, total, cameras }
 *   `since` = current     → { mode: 'current',  watermark, total }
 *   `since` = previous    → { mode: 'delta',    watermark, total, added, changed, removed }
 *   `since` = anything else (older, foreign, a previous deploy's)
 *                         → a full snapshot, labelled mode: 'snapshot'
 *
 * Entries carry identity, geometry and labels — never a stream address.
 * Stream URLs are resolved at open time via /api/cctv/resolve-stream,
 * because a DriveTexas playlist address expires minutes after it is
 * minted; baking one into catalogue state would hand the viewer a dead
 * token and move the watermark on token churn alone.
 *
 * Never HTTP-cached: the whole point of the endpoint is that its answer
 * is the current truth about the watermark, and a cached 'current' would
 * be a lie with a TTL.
 */
export async function GET(request: Request) {
  try {
    const since = new URL(request.url).searchParams.get('since');
    const sync = await getDriveTexasSync(since);
    return NextResponse.json(sync, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('DriveTexas sync error:', error);
    return NextResponse.json({ mode: 'snapshot', cameras: [], error: 'Failed' }, { status: 500 });
  }
}
