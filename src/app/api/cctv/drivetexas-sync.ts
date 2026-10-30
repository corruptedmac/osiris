import { createHash } from 'node:crypto';
import { fetchDriveTexasCameras } from './drivetexas';
import type { CctvCamera } from './types';

/**
 * OSIRIS — DriveTexas catalogue sync (Linear-style snapshot + watermark).
 *
 * The DriveTexas catalogue reaches the map today only as part of the
 * whole-world /api/cctv payload: a fresh visitor waits on forty-eight
 * regions before a single Dallas pin can render, and a returning one has
 * no way to ask "what changed?" — the answer is the entire catalogue,
 * again. Linear's client is the reference for the alternative (surveyed
 * statically in REA Campaign 2): render from a local snapshot first, then
 * refresh against a sync cursor — a watermark that moves only when the
 * state it names actually changed — and apply deltas instead of
 * re-downloading the world.
 *
 * This module is that pattern, scoped to the one catalogue that has a
 * single owner and a bounded size: the DriveTexas (Dallas) camera set.
 *
 *   • Snapshot — the full camera catalogue, materialised from the same
 *     source cache the region route serves (fetchDriveTexasCameras is
 *     already cachedSource-backed), so this layer adds no second store
 *     and no second upstream sweep.
 *   • Watermark — `dt1.<boot>.<seq>.<hash>`: the process boot id, a
 *     sequence that increments only when the catalogue's stable content
 *     changes, and a short digest of that content. A deploy restarts the
 *     boot id, so a watermark from a previous process can never be
 *     mistaken for a current one — it earns a fresh snapshot instead.
 *   • Delta — when the client presents the *previous* watermark, the
 *     added / changed / removed entries are computed by diffing the two
 *     retained snapshots. Anything older (or foreign) is answered with a
 *     full snapshot, labelled as such. There is no fabricated delta.
 *
 * What is deliberately NOT in the catalogue state: `stream_url`. A
 * DriveTexas playlist address carries a SkyVDN token minted at fetch
 * time and dead within minutes (see drivetexas.ts), so it was never
 * catalogue state to begin with — it is resolved at open time through
 * /api/cctv/resolve-stream, exactly as before. Diffing on it would move
 * the watermark on every refresh while the cameras themselves stood
 * still, and the cursor would name token churn instead of change.
 */

export interface DriveTexasCatalogEntry {
  id: string;
  lat: number;
  lng: number;
  name: string;
  city: string;
  country: string;
  source: string;
  stream_type: 'hls';
  external_url: string;
  feed_url?: string;
}

export type DriveTexasSyncResponse =
  | { mode: 'snapshot'; watermark: string; total: number; cameras: DriveTexasCatalogEntry[] }
  | { mode: 'current'; watermark: string; total: number }
  | {
      mode: 'delta';
      watermark: string;
      total: number;
      added: DriveTexasCatalogEntry[];
      changed: DriveTexasCatalogEntry[];
      removed: string[];
    };

interface Snapshot {
  watermark: string;
  seq: number;
  hash: string;
  entries: Map<string, DriveTexasCatalogEntry>;
}

/* Random per process: a deploy (or a restart) mints a new boot id, which
   retires every watermark the old process issued. */
const BOOT_ID = createHash('sha256')
  .update(`${Date.now()}:${Math.random()}:${process.pid}`)
  .digest('hex')
  .slice(0, 10);

let current: Snapshot | null = null;
let previous: Snapshot | null = null;

/** The catalogue form of one camera: identity, geometry and labels only. */
export function drivetexasCatalogEntry(camera: CctvCamera): DriveTexasCatalogEntry {
  return {
    id: camera.id,
    lat: camera.lat,
    lng: camera.lng,
    name: camera.name,
    city: camera.city,
    country: camera.country,
    source: camera.source,
    stream_type: 'hls',
    external_url: camera.external_url ?? 'https://drivetexas.org',
    ...(camera.feed_url ? { feed_url: camera.feed_url } : {}),
  };
}

/** Digest of the stable content, entries in id order, keys in fixed order. */
export function drivetexasCatalogHash(entries: readonly DriveTexasCatalogEntry[]): string {
  const canonical = [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(e => [e.id, e.lat, e.lng, e.name, e.city, e.country, e.source, e.stream_type, e.external_url, e.feed_url ?? ''].join('|'))
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function watermarkFor(seq: number, hash: string): string {
  return `dt1.${BOOT_ID}.${seq}.${hash}`;
}

/**
 * Bring the retained snapshots up to date with the source cache and
 * return the current one. Materialising is idempotent: the sequence
 * moves only when the content hash moves.
 */
async function materialise(): Promise<Snapshot> {
  const cameras = await fetchDriveTexasCameras();
  const entries = new Map<string, DriveTexasCatalogEntry>();
  for (const camera of cameras) {
    const entry = drivetexasCatalogEntry(camera);
    entries.set(entry.id, entry);
  }

  /* An empty read is the upstream's failure, not a catalogue of zero:
     never let it rotate the watermark or diff the map down to nothing.
     fetchDriveTexasCameras already serves stale-on-error, so an empty
     result here means there was never a good read to begin with. */
  if (entries.size === 0 && current) return current;

  const hash = drivetexasCatalogHash([...entries.values()]);
  if (current && current.hash === hash) return current;

  const seq = (current?.seq ?? 0) + 1;
  const next: Snapshot = { watermark: watermarkFor(seq, hash), seq, hash, entries };
  previous = current;
  current = next;
  return next;
}

/** Diff two snapshots by camera id; `changed` compares the served fields. */
export function diffDriveTexasSnapshots(
  from: Snapshot,
  to: Snapshot,
): { added: DriveTexasCatalogEntry[]; changed: DriveTexasCatalogEntry[]; removed: string[] } {
  const added: DriveTexasCatalogEntry[] = [];
  const changed: DriveTexasCatalogEntry[] = [];
  const removed: string[] = [];
  for (const [id, entry] of to.entries) {
    const before = from.entries.get(id);
    if (!before) added.push(entry);
    else if (JSON.stringify(before) !== JSON.stringify(entry)) changed.push(entry);
  }
  for (const id of from.entries.keys()) {
    if (!to.entries.has(id)) removed.push(id);
  }
  return { added, changed, removed };
}

/**
 * Answer a sync request. No `since` (or an unusable one) is a snapshot;
 * the current watermark is a no-change answer; the previous watermark
 * earns a true delta; anything older gets a snapshot, labelled.
 */
export async function getDriveTexasSync(since?: string | null): Promise<DriveTexasSyncResponse> {
  const snapshot = await materialise();
  const total = snapshot.entries.size;

  if (since && since === snapshot.watermark) {
    return { mode: 'current', watermark: snapshot.watermark, total };
  }
  if (since && previous && since === previous.watermark) {
    const { added, changed, removed } = diffDriveTexasSnapshots(previous, snapshot);
    return { mode: 'delta', watermark: snapshot.watermark, total, added, changed, removed };
  }
  return {
    mode: 'snapshot',
    watermark: snapshot.watermark,
    total,
    cameras: [...snapshot.entries.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

/** The current watermark without a sync round-trip (undefined until the first materialise). */
export function currentDriveTexasWatermark(): string | undefined {
  return current?.watermark;
}

/** Test seam, in the spirit of clearSourceCache: forget both snapshots. */
export function clearDriveTexasSyncState(): void {
  current = null;
  previous = null;
}
