/**
 * OSIRIS — cameras whose stream address expires.
 *
 * Most stream addresses in the catalogue are stable: they name a playlist
 * and keep naming it. DriveTexas addresses are not — each carries a SkyVDN
 * token that expires minutes after MapLarge mints it (see
 * app/api/cctv/drivetexas.ts), so the baked address is dead by the time a
 * camera is opened. Those cameras resolve a fresh address at open time
 * through /api/cctv/resolve-stream instead, and a retry resolves again
 * rather than re-using the address that just failed.
 *
 * The test is the camera id. The DriveTexas fetcher mints ids as
 * `drivetexas-<device code>`, and that code is both the proof that the
 * address is a perishable one and the key the resolver looks up — no
 * second marker to keep in sync with the record.
 */

export interface FreshStreamCameraLike {
  id?: unknown;
  stream_type?: unknown;
}

const DRIVETEXAS_ID = /^drivetexas-TX_[A-Z]{3}_\d+$/;

/**
 * The camera's id when its stream address must be resolved fresh at open
 * time, or null when the catalogue address can be used as it stands.
 */
export function freshStreamCameraId(
  camera: FreshStreamCameraLike | null | undefined,
): string | null {
  if (!camera) return null;
  if (String(camera.stream_type ?? '').toLowerCase() !== 'hls') return null;
  const id = typeof camera.id === 'string' ? camera.id : '';
  return DRIVETEXAS_ID.test(id) ? id : null;
}
