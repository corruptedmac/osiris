import { describe, it, expect } from 'vitest';
import { ErrorDetails, ErrorTypes } from 'hls.js';
import {
  decideHlsRecovery,
  networkRetryDelayMs,
  MAX_NETWORK_RETRIES,
  MAX_MEDIA_RECOVERIES,
  type HlsRecoveryState,
} from './hls-recovery';

const fresh: HlsRecoveryState = { networkRetries: 0, mediaRecoveries: 0, hasSnapshot: true };
const noStill: HlsRecoveryState = { networkRetries: 0, mediaRecoveries: 0, hasSnapshot: false };

describe('decideHlsRecovery', () => {
  it('leaves non-fatal errors alone — hls.js recovers from those itself', () => {
    expect(decideHlsRecovery(
      { type: ErrorTypes.NETWORK_ERROR, details: ErrorDetails.FRAG_LOAD_ERROR, fatal: false },
      fresh,
    )).toBe('none');
    expect(decideHlsRecovery(
      { type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_STALLED_ERROR, fatal: false },
      fresh,
    )).toBe('none');
  });

  it('retries a fatal network error by reloading, up to the bound', () => {
    const err = { type: ErrorTypes.NETWORK_ERROR, details: ErrorDetails.MANIFEST_LOAD_ERROR, fatal: true };
    expect(decideHlsRecovery(err, fresh)).toBe('retry-load');
    expect(decideHlsRecovery(err, { ...fresh, networkRetries: MAX_NETWORK_RETRIES - 1 })).toBe('retry-load');
  });

  it('stops reloading once the network bound is spent', () => {
    const err = { type: ErrorTypes.NETWORK_ERROR, details: ErrorDetails.MANIFEST_LOAD_ERROR, fatal: true };
    const spent = { ...fresh, networkRetries: MAX_NETWORK_RETRIES };
    expect(decideHlsRecovery(err, spent)).toBe('fallback-snapshot');
    expect(decideHlsRecovery(err, { ...spent, hasSnapshot: false })).toBe('give-up');
  });

  it('recovers a fatal media error, up to the bound', () => {
    const err = { type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_APPENDING_ERROR, fatal: true };
    expect(decideHlsRecovery(err, fresh)).toBe('recover-media');
    expect(decideHlsRecovery(err, { ...fresh, mediaRecoveries: MAX_MEDIA_RECOVERIES - 1 })).toBe('recover-media');
  });

  it('falls back once the media bound is spent', () => {
    const err = { type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_APPENDING_ERROR, fatal: true };
    const spent = { ...fresh, mediaRecoveries: MAX_MEDIA_RECOVERIES };
    expect(decideHlsRecovery(err, spent)).toBe('fallback-snapshot');
    expect(decideHlsRecovery(err, { ...spent, hasSnapshot: false })).toBe('give-up');
  });

  it('sends fatal buffer-codec errors straight to the fallback, without spending media recoveries', () => {
    // The stream's codecs do not fit the pipeline; recoverMediaError()
    // resets the media source but cannot change the codecs.
    const err = { type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR, fatal: true };
    expect(decideHlsRecovery(err, fresh)).toBe('fallback-snapshot');
    expect(decideHlsRecovery(err, noStill)).toBe('give-up');
    const addCodec = { type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_ADD_CODEC_ERROR, fatal: true };
    expect(decideHlsRecovery(addCodec, fresh)).toBe('fallback-snapshot');
  });

  it('sends other fatal errors (mux, unclassified) to the fallback', () => {
    const mux = { type: ErrorTypes.MUX_ERROR, details: ErrorDetails.FRAG_PARSING_ERROR, fatal: true };
    expect(decideHlsRecovery(mux, fresh)).toBe('fallback-snapshot');
    expect(decideHlsRecovery(mux, noStill)).toBe('give-up');
    const other = { type: ErrorTypes.OTHER_ERROR, details: ErrorDetails.INTERNAL_EXCEPTION, fatal: true };
    expect(decideHlsRecovery(other, fresh)).toBe('fallback-snapshot');
  });

  it('keeps the two budgets independent — network retries do not spend media recoveries', () => {
    const media = { type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_APPENDING_ERROR, fatal: true };
    expect(decideHlsRecovery(media, { ...fresh, networkRetries: MAX_NETWORK_RETRIES })).toBe('recover-media');
    const net = { type: ErrorTypes.NETWORK_ERROR, details: ErrorDetails.LEVEL_LOAD_ERROR, fatal: true };
    expect(decideHlsRecovery(net, { ...fresh, mediaRecoveries: MAX_MEDIA_RECOVERIES })).toBe('retry-load');
  });
});

describe('networkRetryDelayMs', () => {
  it('backs off exponentially and caps', () => {
    expect(networkRetryDelayMs(1)).toBe(1000);
    expect(networkRetryDelayMs(2)).toBe(2000);
    expect(networkRetryDelayMs(3)).toBe(4000);
    expect(networkRetryDelayMs(10)).toBe(8000);
  });
});
