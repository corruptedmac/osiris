import { NextResponse } from 'next/server';
import { resolveDriveTexasStreamUrl } from '../drivetexas';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Resolves a camera's stream address at the moment it is opened.
 *
 * DriveTexas playlists carry a SkyVDN token that expires minutes after
 * MapLarge mints it, so the address baked into the camera catalogue is
 * dead by the time anyone clicks — the viewer burned its whole recovery
 * budget on a token that could never work, and a retry re-used the same
 * dead address. This route returns an address minted moments ago; the
 * token mechanics live in ../drivetexas.ts (resolveDriveTexasStreamUrl).
 *
 * The vocabulary mirrors /api/cctv/resolve: 'missing' is a durable answer
 * about the camera, 'unreachable' is a failure of ours or upstream's and
 * says nothing about the camera — the viewer still tries the catalogue
 * address in that case.
 */

/** The only ids this route resolves: drivetexas-<device code>. */
const CAMERA_ID = /^drivetexas-(TX_[A-Z]{3}_\d+)$/;

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('camera') ?? '';
  const match = CAMERA_ID.exec(id);

  if (!match) {
    return NextResponse.json(
      { streamable: false, kind: 'unknown', reason: 'not_resolvable' },
      { status: 400 },
    );
  }

  try {
    const streamUrl = await resolveDriveTexasStreamUrl(match[1]);
    if (!streamUrl) {
      return NextResponse.json({ streamable: false, kind: 'missing' });
    }
    // The address is perishable by design; nothing downstream may cache it.
    return NextResponse.json(
      { streamable: true, kind: 'hls', streamUrl },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    // A resolver failure must not look like "this camera is broken" — the
    // viewer still has the catalogue address to fall back to. Log it,
    // though: a silent catch here is how a wholly broken resolver looks
    // identical to a camera that genuinely has no stream.
    console.error('cctv resolve-stream failed:', id, err instanceof Error ? err.message : err);
    return NextResponse.json({ streamable: false, kind: 'unreachable' });
  }
}
