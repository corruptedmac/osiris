import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDriveTexasCameras, mapDriveTexasResponse } from './drivetexas';
import { clearSourceCache } from '@/lib/sourceCache';

/* Fixture built from the documented ProcessDirect response shape
   (columnar data block + totals), with synthetic values. */
const dallasCam = {
  id: 101, name: 'TX_DAL_001', description: 'IH35E @ Mockingbird Ln',
  jurisdiction: 'Dallas', route: 'IH0035E', direction: 'North', mrm: 12.4,
  active: 1, problemstream: 0, lastUpdated: 1793200000000,
  imageurl: 'https://localhost/thumbs/TX_DAL_001.flv.png',
  httpsurl: 'https://s70.us-east-1.skyvdn.com:443/rtplive/TX_DAL_001/playlist.m3u8',
  iosurl: 'https://s70.us-east-1.skyvdn.com:443/rtplive/TX_DAL_001/playlist.m3u8',
  line: 'POINT(-96.8077 32.8349)',
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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearSourceCache(); });

describe('DriveTexas MapLarge inventory', () => {
  it('maps a Dallas camera into an HLS record with WKT coordinates', () => {
    const [result] = mapDriveTexasResponse(response([dallasCam]));
    expect(result).toMatchObject({
      id: 'drivetexas-101', lat: 32.8349, lng: -96.8077,
      name: 'IH35E @ Mockingbird Ln', city: 'Dallas', country: 'US',
      source: 'TxDOT DriveTexas', stream_type: 'hls',
      stream_url: dallasCam.httpsurl,
    });
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

  it('deduplicates by id and drops out-of-scope and unusable rows', () => {
    const rows: Row[] = [
      dallasCam, dallasCam,
      { ...dallasCam, id: 102, jurisdiction: 'Ft Worth' }, // not wired this phase
      { ...dallasCam, id: 103, active: 0 },
      { ...dallasCam, id: 104, problemstream: 1 },
      { ...dallasCam, id: 105, httpsurl: '', iosurl: 'rtsp://s70.us-east-1.skyvdn.com:554/rtplive/TX_DAL_005' },
      { ...dallasCam, id: 106, line: null as unknown as string },
      { ...dallasCam, id: 107, line: 'POINT(0 0)' }, // outside the Texas bbox
      { ...dallasCam, id: null as unknown as number },
    ];
    expect(mapDriveTexasResponse(response(rows)).map(c => c.id)).toEqual(['drivetexas-101']);
  });

  it('throws on a failed or malformed response', () => {
    expect(() => mapDriveTexasResponse({ success: false, errors: ['boom'] })).toThrow('DriveTexas query failed');
    expect(() => mapDriveTexasResponse({ success: true, data: {} })).toThrow('missing its data block');
    expect(() => mapDriveTexasResponse(null)).toThrow('DriveTexas query failed');
  });

  it('pages through the full inventory with the documented request shape', async () => {
    const second = { ...dallasCam, id: 102, description: 'US75 @ Walnut Hill Ln', line: 'POINT(-96.7699 32.8799)' };
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const request = JSON.parse(new URL(url).searchParams.get('request')!);
      if (request.query.start === 0) return Response.json(response([dallasCam], 600));
      if (request.query.start === 500) return Response.json(response([second], 600));
      return new Response('', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const cameras = await fetchDriveTexasCameras();
    expect(cameras.map(c => c.id)).toEqual(['drivetexas-101', 'drivetexas-102']);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://dtx-e-cdn.maplarge.com/Api/ProcessDirect');
    const request = JSON.parse(new URL(url).searchParams.get('request')!);
    expect(request.action).toBe('table/query');
    expect(request.query.table).toBe('appgeo/cameraPoint');
    expect(request.query.take).toBe(500);
    expect(request.query.sqlselect).toEqual(expect.arrayContaining(['httpsurl', 'line', 'jurisdiction']));
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
