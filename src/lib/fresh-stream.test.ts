import { describe, expect, it } from 'vitest';
import { freshStreamCameraId } from './fresh-stream';

describe('freshStreamCameraId', () => {
  it('returns the id for a DriveTexas HLS camera', () => {
    expect(freshStreamCameraId({ id: 'drivetexas-TX_DAL_001', stream_type: 'hls' }))
      .toBe('drivetexas-TX_DAL_001');
    expect(freshStreamCameraId({ id: 'drivetexas-TX_FTW_042', stream_type: 'HLS' }))
      .toBe('drivetexas-TX_FTW_042');
  });

  it('leaves other HLS cameras on their catalogue address', () => {
    // Louisiana DOTD and friends publish stable playlist addresses.
    expect(freshStreamCameraId({ id: 'ladotd-123', stream_type: 'hls' })).toBeNull();
    expect(freshStreamCameraId({ id: 'drivetexas-CAM-001', stream_type: 'hls' })).toBeNull();
  });

  it('ignores non-HLS DriveTexas-shaped records and empty input', () => {
    expect(freshStreamCameraId({ id: 'drivetexas-TX_DAL_001', stream_type: 'jpg' })).toBeNull();
    expect(freshStreamCameraId({ id: 'drivetexas-TX_DAL_001' })).toBeNull();
    expect(freshStreamCameraId({ stream_type: 'hls' })).toBeNull();
    expect(freshStreamCameraId(null)).toBeNull();
    expect(freshStreamCameraId(undefined)).toBeNull();
  });
});
