import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDriveTexasStreamUrlCache, fetchDriveTexasCameras, mapDriveTexasResponse, resolveDriveTexasStreamUrl } from './drivetexas';
import { clearSourceCache } from '@/lib/sourceCache';

/* Fixture built from the PROVED ProcessDirect response shape (Oct 28):
   columnar data block carrying only the five columns the current
   cameraPoint schema answers for — description / name / httpsurl /
   imageurl / XY — plus totals. Values are synthetic. */
const dallasCam = {
  description: 'IH35E @ Mockingbird Ln',
  name: 'TX_DAL_001',
  httpsurl: 'https://s70.us-east-1.skyvdn.com:443/rtplive/TX_DAL_001/playlist.m3u8?token=abc123',
  imageurl: 'https://localhost/thumbs/TX_DAL_001.flv.png',
  XY: 'POINT (-96.8077 32.8349)',
};
type Row = typeof dallasCam;

const columnar = (rows: Row[]): Record<string, unknown[]> => {
  const cols: Record<string, unknown[]> = {};
  for (const row of rows) {
    for (const key of Object.keys(dallasCam) as (keyof Row)[]) {
      (cols[key] ??= []).push(row[key]);
    }
  }
  return cols;
};
const response = (rows: Row[], total = rows.length) => ({
  success: true,
  data: { data: columnar(rows), totals: { Records: total }, tablename: 'appgeo/cameraPoint/1' },
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearSourceCache(); clearDriveTexasStreamUrlCache(); });

describe('DriveTexas MapLarge inventory', () => {
  it('maps a Dallas camera into an HLS record with WKT coordinates', () => {
    const [result] = mapDriveTexasResponse(response([dallasCam]));
    expect(result).toMatchObject({
      id: 'drivetexas-TX_DAL_001', lat: 32.8349, lng: -96.8077,
      name: 'IH35E @ Mockingbird Ln', city: 'Dallas', country: 'US',
      source: 'TxDOT DriveTexas', stream_type: 'hls',
    });
    /* httpsurl is passed through verbatim — token query included. */
    expect(result.stream_url).toBe(dallasCam.httpsurl);
    /* The upstream imageurl is a localhost address inside the TxDOT
       network — it must NOT be passed through as a snapshot feed. */
    expect(result.feed_url).toBeUndefined();
  });

  it('carries a snapshot in feed_url when the image address is publicly loadable', () => {
    const row = { ...dallasCam, imageurl: 'https://images.example.com/thumbs/TX_DAL_001.png' };
    const [result] = mapDriveTexasResponse(response([row]));
    expect(result.feed_url).toBe('https://images.example.com/thumbs/TX_DAL_001.png');
    expect(result.stream_url).toBe(dallasCam.httpsurl);
  });

  it('scopes by TX_DAL_ device-code prefix and drops unusable rows', () => {
    const rows: Row[] = [
      dallasCam, dallasCam, // duplicate code — dedupes to one
      { ...dallasCam, name: 'TX_FTW_001' }, // Fort Worth: not wired this phase
      { ...dallasCam, name: 'TX_ELP_209' }, // El Paso: out of scope
      { ...dallasCam, name: 'TX_DAL_002', httpsurl: 'https://example.com/not-a-playlist.mp4' },
      { ...dallasCam, name: 'TX_DAL_003', httpsurl: '' },
      { ...dallasCam, name: 'TX_DAL_004', XY: 'not-a-point' },
      { ...dallasCam, name: 'TX_DAL_005', XY: null as unknown as string },
      { ...dallasCam, name: 'TX_DAL_006', XY: 'POINT (0 0)' }, // outside the Texas bbox
      { ...dallasCam, name: '' },
    ];
    expect(mapDriveTexasResponse(response(rows)).map(c => c.id)).toEqual(['drivetexas-TX_DAL_001']);
  });

  it('throws on a failed or malformed response', () => {
    expect(() => mapDriveTexasResponse({ success: false, errors: ['boom'] })).toThrow('DriveTexas query failed');
    expect(() => mapDriveTexasResponse({ success: true, data: {} })).toThrow('missing its data block');
    expect(() => mapDriveTexasResponse(null)).toThrow('DriveTexas query failed');
  });

  it('pages through the full inventory with the proved request shape', async () => {
    const second = { ...dallasCam, name: 'TX_DAL_002', description: 'US75 @ Walnut Hill Ln', XY: 'POINT (-96.7699 32.8799)' };
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const request = JSON.parse(new URL(url).searchParams.get('request')!);
      if (request.query.start === 0) return Response.json(response([dallasCam], 600));
      if (request.query.start === 500) return Response.json(response([second], 600));
      return new Response('', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const cameras = await fetchDriveTexasCameras();
    expect(cameras.map(c => c.id)).toEqual(['drivetexas-TX_DAL_001', 'drivetexas-TX_DAL_002']);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://dtx-e-cdn.maplarge.com/Api/ProcessDirect');
    const request = JSON.parse(new URL(url).searchParams.get('request')!);
    expect(request.action).toBe('table/query');
    expect(request.query.table).toBe('appgeo/cameraPoint');
    expect(request.query.take).toBe(500);
    /* Exactly the proved five columns — any extra column 500s upstream. */
    expect(request.query.sqlselect).toEqual(['description', 'name', 'httpsurl', 'imageurl', 'XY']);
    expect(request.query.where).toBeUndefined(); // server-side filters return HTTP 500 upstream
    expect((init as RequestInit).headers).toMatchObject({
      Origin: 'https://drivetexas.org',
      Referer: 'https://drivetexas.org/',
    });
  });

  it('resolves to an empty layer when the upstream fails, leaving other sources untouched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await fetchDriveTexasCameras()).toEqual([]);
  });
});

describe('DriveTexas click-time stream resolution', () => {
  /* The resolve sweep asks for only the two stream columns; the response
     block is columnar in the same shape as the catalogue query's. */
  const streamPage = (rows: { name: string; httpsurl: string }[], total = rows.length) => ({
    success: true,
    data: {
      data: { name: rows.map(r => r.name), httpsurl: rows.map(r => r.httpsurl) },
      totals: { Records: total },
    },
  });
  const fresh = (code: string) =>
    `https://s70.us-east-1.skyvdn.com/rtplive/${code}/playlist.m3u8?token=<redacted>`;

  it('pages the table and returns the address for the asked device', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const request = JSON.parse(new URL(url).searchParams.get('request')!);
      expect(request.query.sqlselect).toEqual(['name', 'httpsurl']);
      expect(request.query.where).toBeUndefined();
      if (request.query.start === 0) return Response.json(streamPage([{ name: 'TX_DAL_002', httpsurl: fresh('TX_DAL_002') }], 600));
      if (request.query.start === 500) return Response.json(streamPage([{ name: 'TX_DAL_001', httpsurl: fresh('TX_DAL_001') }], 600));
      return new Response('', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveDriveTexasStreamUrl('TX_DAL_001')).resolves.toBe(fresh('TX_DAL_001'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves repeat resolutions from the sweep cache instead of re-asking upstream', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(streamPage([{ name: 'TX_DAL_001', httpsurl: fresh('TX_DAL_001') }])));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveDriveTexasStreamUrl('tx_dal_001')).resolves.toBe(fresh('TX_DAL_001'));
    await expect(resolveDriveTexasStreamUrl('TX_DAL_001')).resolves.toBe(fresh('TX_DAL_001'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers null for a device the table does not carry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json(streamPage([{ name: 'TX_DAL_001', httpsurl: fresh('TX_DAL_001') }]))));
    await expect(resolveDriveTexasStreamUrl('TX_DAL_999')).resolves.toBeNull();
    await expect(resolveDriveTexasStreamUrl('')).resolves.toBeNull();
  });

  it('rejects when the sweep itself fails, so the route can say unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await expect(resolveDriveTexasStreamUrl('TX_DAL_001')).rejects.toThrow('DriveTexas: HTTP 500');
    /* A failed sweep is not cached: the next call asks upstream again. */
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json(streamPage([{ name: 'TX_DAL_001', httpsurl: fresh('TX_DAL_001') }]))));
    await expect(resolveDriveTexasStreamUrl('TX_DAL_001')).resolves.toBe(fresh('TX_DAL_001'));
  });
});
