/**
 * OSIRIS — what the camera viewer does when an HLS stream errors.
 *
 * The viewer used to treat ANY fatal hls.js error as the end: one hiccup —
 * a dropped manifest request, a stalled buffer — and the camera sat on a
 * permanent FEED UNAVAILABLE until a human pressed RETRY. Most of those
 * errors are recoverable, and hls.js already knows how: reload the stream
 * for network failures, reset the media pipeline for decode failures. This
 * module is the decision about which remedy to try, kept pure so the bounds
 * are under test rather than buried in the component.
 *
 * The bounds matter as much as the remedies. A camera that is genuinely
 * gone must not be retried forever: network loads get MAX_NETWORK_RETRIES
 * attempts, media errors get MAX_MEDIA_RECOVERIES, and then the viewer
 * falls back to the camera's snapshot still if it has one — labelled as a
 * snapshot, because a still is not live video — or gives up.
 */

import { ErrorDetails, ErrorTypes } from 'hls.js';

/** What the viewer should do with a fatal HLS error. */
export type HlsRecoveryAction =
  | 'none' // Not fatal — hls.js is handling it, or it is only a warning.
  | 'retry-load' // hls.startLoad(): the network path failed, try loading again.
  | 'recover-media' // hls.recoverMediaError(): the media pipeline failed.
  | 'fallback-snapshot' // Give up on video; show the still, labelled SNAPSHOT.
  | 'give-up'; // No remedy left and no still to show.

/** The slice of an hls.js error event this decision reads. */
export interface HlsErrorLike {
  type: ErrorTypes;
  details: ErrorDetails;
  fatal: boolean;
}

/** Attempts already spent on this camera, and whether a still exists. */
export interface HlsRecoveryState {
  networkRetries: number;
  mediaRecoveries: number;
  hasSnapshot: boolean;
}

export const MAX_NETWORK_RETRIES = 3;
export const MAX_MEDIA_RECOVERIES = 2;

/**
 * Most fatal media errors are exactly what recoverMediaError() exists for
 * (the append/stall family). The buffer-codec pair is the exception: the
 * stream's codecs do not fit this pipeline, and resetting the media source
 * cannot change the codecs — recovery would repeat the same failure until
 * the budget ran out. Those go straight to the fallback.
 */
function isUnrecoverableBufferError(details: ErrorDetails): boolean {
  return details === ErrorDetails.BUFFER_ADD_CODEC_ERROR
    || details === ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR;
}

export function decideHlsRecovery(error: HlsErrorLike, state: HlsRecoveryState): HlsRecoveryAction {
  if (!error.fatal) return 'none';

  const exhausted = state.hasSnapshot ? 'fallback-snapshot' : 'give-up';

  if (error.type === ErrorTypes.NETWORK_ERROR) {
    return state.networkRetries < MAX_NETWORK_RETRIES ? 'retry-load' : exhausted;
  }

  if (error.type === ErrorTypes.MEDIA_ERROR) {
    if (isUnrecoverableBufferError(error.details)) return exhausted;
    return state.mediaRecoveries < MAX_MEDIA_RECOVERIES ? 'recover-media' : exhausted;
  }

  // Mux, key-system, and anything unclassified: no targeted remedy exists,
  // so the honest outcomes are the still or the unavailable panel.
  return exhausted;
}

/**
 * Delay before a startLoad retry: exponential backoff from 1s, capped at
 * 8s. `retry` is the attempt about to be made (1-based).
 */
export function networkRetryDelayMs(retry: number): number {
  const attempt = Math.max(1, retry);
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}
