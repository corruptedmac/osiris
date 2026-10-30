/**
 * OSIRIS — DriveTexas catalogue sync, client half (see
 * app/api/cctv/drivetexas-sync.ts for the protocol).
 *
 * The whole-world catalogue load is the slow path to a Dallas pin: it
 * waits on forty-eight regions. This loader asks only for the DriveTexas
 * snapshot — one bounded, single-owner catalogue — so those cameras
 * render as soon as it lands, and afterwards it keeps them current the
 * way Linear's client keeps its workspace current: present the watermark,
 * receive either "nothing moved" (a few hundred bytes) or the delta, and
 * apply the delta to local state. The full snapshot is re-served only
 * when the watermark is too old to diff — after a deploy, for instance.
 *
 * Stream addresses are not part of this state, by design: a DriveTexas
 * playlist URL expires minutes after minting and is resolved at open
 * time through /api/cctv/resolve-stream. Entries already on the map keep
 * whatever catalogue address they arrived with (the viewer's fallback
 * when a fresh resolve fails); sync never strips one.
 */

export interface DriveTexasSyncEntry {
  id: string;
  lat: number;
  lng: number;
  name: string;
  city: string;
  country: string;
  source: string;
  stream_type: string;
  external_url: string;
  feed_url?: string;
  [key: string]: unknown;
}

export interface DriveTexasDelta {
  added: DriveTexasSyncEntry[];
  changed: DriveTexasSyncEntry[];
  removed: string[];
}

type SyncResponse =
  | { mode: 'snapshot'; watermark: string; cameras: DriveTexasSyncEntry[] }
  | { mode: 'current'; watermark: string }
  | ({ mode: 'delta'; watermark: string } & DriveTexasDelta);

/**
 * Apply one delta to the map's camera list. Upserts win on every field
 * except stream_url, which a sync entry never carries: an entry already
 * on the map keeps the catalogue address it had, because that address is
 * the viewer's fallback when a fresh open-time resolve fails.
 */
export function applyDriveTexasDelta<T extends { id: string | number; stream_url?: unknown }>(
  previous: T[],
  delta: DriveTexasDelta,
): T[] {
  const removed = new Set(delta.removed);
  const upserts = new Map<string, DriveTexasSyncEntry>();
  for (const entry of [...delta.added, ...delta.changed]) upserts.set(entry.id, entry);

  const next: T[] = [];
  const seen = new Set<string>();
  for (const camera of previous) {
    const id = String(camera.id);
    if (removed.has(id)) continue;
    const upsert = upserts.get(id);
    if (upsert) {
      next.push({ ...camera, ...upsert, stream_url: camera.stream_url } as T);
      seen.add(id);
    } else {
      next.push(camera);
    }
  }
  for (const entry of delta.added) {
    if (!seen.has(entry.id) && !removed.has(entry.id)) next.push(entry as unknown as T);
  }
  return next;
}

/** Replace the DriveTexas slice of the map with a fresh snapshot, same stream_url rule. */
export function applyDriveTexasSnapshot<T extends { id: string | number; stream_url?: unknown }>(
  previous: T[],
  cameras: DriveTexasSyncEntry[],
): T[] {
  const priorById = new Map(previous.map(c => [String(c.id), c]));
  const rest = previous.filter(c => !String(c.id).startsWith('drivetexas-'));
  const merged = cameras.map(entry => {
    const prior = priorById.get(entry.id);
    return (prior ? { ...prior, ...entry, stream_url: prior.stream_url } : entry) as unknown as T;
  });
  return [...rest, ...merged];
}

const POLL_MS = 120_000; // the server catalogue refreshes on a 30-minute TTL; this is cheap because "current" is tiny

export interface DriveTexasSyncHandlers {
  onSnapshot: (cameras: DriveTexasSyncEntry[]) => void;
  onDelta: (delta: DriveTexasDelta) => void;
  onError?: () => void;
}

/**
 * Load the DriveTexas snapshot, then keep it current by watermark poll
 * (every POLL_MS) and on window focus / tab visibility return. Returns
 * the cleanup function, in the loadCameraCatalog pattern.
 */
export function loadDriveTexasSync(handlers: DriveTexasSyncHandlers) {
  const controller = new AbortController();
  let watermark: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void sync(), POLL_MS);
  };

  const sync = async () => {
    if (stopped) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      schedule();
      return;
    }
    try {
      const query = watermark ? `?since=${encodeURIComponent(watermark)}` : '';
      const response = await fetch(`/api/cctv/drivetexas-sync${query}`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`DriveTexas sync HTTP ${response.status}`);
      const data = (await response.json()) as SyncResponse;
      if (controller.signal.aborted) return;
      watermark = data.watermark;
      if (data.mode === 'snapshot') handlers.onSnapshot(data.cameras);
      else if (data.mode === 'delta') handlers.onDelta(data);
      // mode 'current': the watermark is the whole answer; nothing moved.
    } catch {
      if (controller.signal.aborted) return;
      handlers.onError?.();
    }
    schedule();
  };

  const onFocus = () => { void sync(); };
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
  }

  void sync();
  return () => {
    stopped = true;
    controller.abort();
    clearTimeout(timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    }
  };
}
