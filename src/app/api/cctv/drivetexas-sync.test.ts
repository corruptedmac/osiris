import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDriveTexasSyncState, drivetexasCatalogHash, getDriveTexasSync } from './drivetexas-sync';
import { clearSourceCache } from '@/lib/sourceCache';

/* Same proved ProcessDirect fixture shape as drivetexas.test.ts:
   columnar data, five columns, synthetic values. */
const cam = (n: number, overrides: Record<string, string> = {}) => ({
  description: `IH35E @ Camera ${n}`,
  name: `TX_DAL_00${n}`,
  httpsurl: `https://s70.us-east-1.skyvdn.com:443/rtplive/TX_DAL_00${n}/playlist.m3u8?token=v1`,
  imageurl: 'https://localhost/thumbs/x.flv.png',
  XY: `POINT (-96.80${n} 32.83${n})`,
  ...overrides,
});
type Row = ReturnType<typeof cam>;

const response = (rows: Row[]) => ({
  success: true,
  data: {
    data: Object.fromEntries(
      (Object.keys(cam(0)) as (keyof Row)[]).map(k => [k, rows.map(r => r[k])]),
    ),
    totals: { Records: rows.length },
    tablename: 'appgeo/cameraPoint/1',
  },
});

/** Point the upstream stub at a new catalogue generation. */
function serve(rows: Row[]) {
  clearSourceCache(); // the fetcher is TTL-cached; a new generation must miss
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(response(rows)), { status: 200, headers: { 'Content-Type': 'application/json' } })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSourceCache();
  clearDriveTexasSyncState();
});

describe('DriveTexas catalogue sync', () => {
  it('serves a snapshot first: stable fields only, no stream address, watermark attached', async () => {
    serve([cam(1), cam(2)]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const sync = await getDriveTexasSync();
    expect(sync.mode).toBe('snapshot');
    if (sync.mode !== 'snapshot') return;
    expect(sync.total).toBe(2);
    expect(sync.watermark).toMatch(/^dt1\.[0-9a-f]{10}\.1\.[0-9a-f]{16}$/);
    expect(sync.cameras.map(c => c.id)).toEqual(['drivetexas-TX_DAL_001', 'drivetexas-TX_DAL_002']);
    /* The token-bearing playlist address is NOT catalogue state: it is
       resolved at open time, so it must not ride in the snapshot. */
    expect(sync.cameras[0]).not.toHaveProperty('stream_url');
    expect(sync.cameras[0]).toMatchObject({ stream_type: 'hls', source: 'TxDOT DriveTexas', city: 'Dallas' });
  });

  it('answers the current watermark with the no-change form', async () => {
    serve([cam(1)]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = await getDriveTexasSync();

    const again = await getDriveTexasSync(first.watermark);
    expect(again).toEqual({ mode: 'current', watermark: first.watermark, total: 1 });
  });

  it('does not move the watermark when only the stream tokens rotate', async () => {
    serve([cam(1)]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = await getDriveTexasSync();

    /* Next catalogue generation: identical cameras, freshly minted tokens.
       Token churn is not catalogue change — the cursor must not move. */
    serve([cam(1, { httpsurl: 'https://s70.us-east-1.skyvdn.com:443/rtplive/TX_DAL_001/playlist.m3u8?token=v2' })]);
    const after = await getDriveTexasSync(first.watermark);
    expect(after.mode).toBe('current');
    expect(after.watermark).toBe(first.watermark);
  });

  it('answers the previous watermark with a true delta: added, changed, removed', async () => {
    serve([cam(1), cam(2), cam(3)]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = await getDriveTexasSync();

    serve([
      cam(1, { description: 'IH35E @ Camera 1 — renamed' }), // changed
      cam(3), // unchanged
      cam(4), // added; camera 2 removed
    ]);
    const delta = await getDriveTexasSync(first.watermark);
    expect(delta.mode).toBe('delta');
    if (delta.mode !== 'delta') return;
    expect(delta.total).toBe(3);
    expect(delta.added.map(c => c.id)).toEqual(['drivetexas-TX_DAL_004']);
    expect(delta.changed.map(c => c.id)).toEqual(['drivetexas-TX_DAL_001']);
    expect(delta.changed[0].name).toBe('IH35E @ Camera 1 — renamed');
    expect(delta.removed).toEqual(['drivetexas-TX_DAL_002']);
    expect(delta.watermark).not.toBe(first.watermark);
  });

  it('answers a watermark older than the previous one with a labelled full snapshot, never a fabricated delta', async () => {
    serve([cam(1)]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const v1 = await getDriveTexasSync();
    serve([cam(1), cam(2)]);
    await getDriveTexasSync();
    serve([cam(1), cam(2), cam(3)]);
    const v3 = await getDriveTexasSync();

    const answer = await getDriveTexasSync(v1.watermark); // two generations old
    expect(answer.mode).toBe('snapshot');
    if (answer.mode === 'snapshot') {
      expect(answer.watermark).toBe(v3.watermark);
      expect(answer.cameras).toHaveLength(3);
    }
  });

  it('hash is order-insensitive and content-sensitive', () => {
    const a = { id: 'a', lat: 1, lng: 2, name: 'A', city: 'Dallas', country: 'US', source: 's', stream_type: 'hls' as const, external_url: 'u' };
    const b = { ...a, id: 'b' };
    expect(drivetexasCatalogHash([a, b])).toBe(drivetexasCatalogHash([b, a]));
    expect(drivetexasCatalogHash([a, b])).not.toBe(drivetexasCatalogHash([a, { ...b, name: 'B2' }]));
  });
});
