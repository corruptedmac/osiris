import { describe, expect, it } from 'vitest';
import { applyDriveTexasDelta, applyDriveTexasSnapshot, type DriveTexasSyncEntry } from './drivetexas-sync';

const entry = (n: number, name = `Camera ${n}`): DriveTexasSyncEntry => ({
  id: `drivetexas-TX_DAL_00${n}`,
  lat: 32.83,
  lng: -96.8,
  name,
  city: 'Dallas',
  country: 'US',
  source: 'TxDOT DriveTexas',
  stream_type: 'hls',
  external_url: 'https://drivetexas.org',
});

const onMap = (n: number, name = `Camera ${n}`) => ({
  ...entry(n, name),
  stream_url: `https://example.com/playlist-${n}.m3u8?token=baked`,
});

const streamUrlOf = (camera: unknown) => (camera as { stream_url?: string } | undefined)?.stream_url;

describe('applyDriveTexasDelta', () => {
  it('removes, changes and adds — and never strips the catalogue stream address an entry already has', () => {
    const previous = [onMap(1), onMap(2), { id: 'tfl-1', name: 'London', stream_url: 'https://example.com/london' }];
    const next = applyDriveTexasDelta(previous, {
      added: [entry(4)],
      changed: [entry(1, 'Camera 1 renamed')],
      removed: ['drivetexas-TX_DAL_002'],
    });
    expect(next.map(c => c.id)).toEqual(['drivetexas-TX_DAL_001', 'tfl-1', 'drivetexas-TX_DAL_004']);
    const changed = next.find(c => c.id === 'drivetexas-TX_DAL_001');
    expect(changed?.name).toBe('Camera 1 renamed');
    /* The viewer falls back to the catalogue address when a fresh resolve
       fails; a sync upsert must not erase it. */
    expect(streamUrlOf(changed)).toContain('token=baked');
  });

  it('is a no-op for an empty delta', () => {
    const previous = [onMap(1)];
    expect(applyDriveTexasDelta(previous, { added: [], changed: [], removed: [] })).toEqual(previous);
  });
});

describe('applyDriveTexasSnapshot', () => {
  it('replaces only the DriveTexas slice, preserving other regions and baked addresses', () => {
    const previous = [onMap(1), onMap(9), { id: 'tfl-1', name: 'London' }];
    const next = applyDriveTexasSnapshot(previous, [entry(1, 'Camera 1 fresh'), entry(2)]);
    expect(next.map(c => c.id)).toEqual(['tfl-1', 'drivetexas-TX_DAL_001', 'drivetexas-TX_DAL_002']);
    expect(streamUrlOf(next.find(c => c.id === 'drivetexas-TX_DAL_001'))).toContain('token=baked');
    expect(next.find(c => c.id === 'drivetexas-TX_DAL_001')?.name).toBe('Camera 1 fresh');
  });
});
