import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { resolveDriveTexasStreamUrl } from '../drivetexas';

vi.mock('../drivetexas', () => ({ resolveDriveTexasStreamUrl: vi.fn() }));

const resolve = vi.mocked(resolveDriveTexasStreamUrl);
const ask = (qs: string) => GET(new Request(`http://localhost/api/cctv/resolve-stream?${qs}`));

beforeEach(() => { vi.resetAllMocks(); });

describe('GET /api/cctv/resolve-stream', () => {
  it('returns the freshly resolved address for a DriveTexas camera', async () => {
    resolve.mockResolvedValue('https://s70.us-east-1.skyvdn.com/rtplive/TX_DAL_001/playlist.m3u8?token=<redacted>');
    const response = await ask('camera=drivetexas-TX_DAL_001');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      streamable: true,
      kind: 'hls',
      streamUrl: 'https://s70.us-east-1.skyvdn.com/rtplive/TX_DAL_001/playlist.m3u8?token=<redacted>',
    });
    expect(resolve).toHaveBeenCalledWith('TX_DAL_001');
  });

  it('answers missing when the table carries no such device', async () => {
    resolve.mockResolvedValue(null);
    const response = await ask('camera=drivetexas-TX_DAL_999');
    await expect(response.json()).resolves.toEqual({ streamable: false, kind: 'missing' });
  });

  it('answers unreachable — not missing — when the resolver itself fails', async () => {
    resolve.mockRejectedValue(new Error('DriveTexas: HTTP 500'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await ask('camera=drivetexas-TX_DAL_001');
    await expect(response.json()).resolves.toEqual({ streamable: false, kind: 'unreachable' });
  });

  it('refuses anything that is not a DriveTexas camera id', async () => {
    for (const bad of ['', 'camera=ladotd-1', 'camera=drivetexas-foo', 'camera=drivetexas-TX_DAL_001/extra']) {
      const response = await ask(bad);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ streamable: false, reason: 'not_resolvable' });
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});
