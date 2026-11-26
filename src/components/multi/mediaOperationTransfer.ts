import type { MediaOperation, MediaOperationStage } from './mediaOperations.types';

const MIN_TOTAL_BYTES = 1024;
const SAMPLE_INTERVAL_MS = 500;
const SAMPLE_WINDOW_MS = 8000;
const STALL_TIMEOUT_MS = 10000;
const MIN_SAMPLE_SPAN_MS = 1000;
const MIN_SAMPLE_COUNT = 3;
const MAX_SAMPLE_COUNT = 17;

export type MediaOperationTransferState = {
  attempt: number;
  stage: MediaOperationStage;
  index?: number;
  total: number;
  loaded: number;
  lastActivityAt: number;
  samples: { at: number; loaded: number }[];
};

export function sampleMediaOperationTransfer(
  previous: MediaOperationTransferState | undefined, operation: MediaOperation, now: number,
): MediaOperationTransferState | undefined {
  const progress = getByteProgress(operation);
  if (!progress || !Number.isFinite(now)) return undefined;
  const { loaded, total, index } = progress;
  const sample = { at: now, loaded };
  if (!previous || !isSameTransfer(previous, operation, progress)
    || loaded < previous.loaded || now < previous.lastActivityAt
    || now - previous.lastActivityAt > STALL_TIMEOUT_MS) {
    return {
      attempt: operation.attempt, stage: operation.stage, index, total, loaded,
      lastActivityAt: now, samples: [sample],
    };
  }
  if (loaded === previous.loaded) return previous;
  const last = previous.samples[previous.samples.length - 1];
  const samples = now - last.at >= SAMPLE_INTERVAL_MS
    ? [...previous.samples.filter((value) => now - value.at <= SAMPLE_WINDOW_MS), sample].slice(-MAX_SAMPLE_COUNT)
    : previous.samples;
  return { ...previous, loaded, lastActivityAt: now, samples };
}

export function getMediaOperationTransferEstimate(
  state: MediaOperationTransferState | undefined, operation: MediaOperation, now: number,
): { bytesPerSecond: number; remainingSeconds: number } | undefined {
  const progress = getByteProgress(operation);
  if (!state || !progress || !isSameTransfer(state, operation, progress)
    || progress.loaded < state.loaded || now - state.lastActivityAt > STALL_TIMEOUT_MS
    || state.samples.length < MIN_SAMPLE_COUNT) return undefined;
  const first = state.samples[0];
  const last = state.samples[state.samples.length - 1];
  const duration = last.at - first.at;
  if (duration < MIN_SAMPLE_SPAN_MS || now < last.at) return undefined;
  const bytesPerSecond = (last.loaded - first.loaded) / duration * 1000;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return undefined;
  return { bytesPerSecond, remainingSeconds: Math.ceil((progress.total - progress.loaded) / bytesPerSecond) };
}

function getByteProgress(operation: MediaOperation) {
  const { stage, progress } = operation;
  const total = progress?.total;
  if (!['downloading', 'writing', 'preparing', 'sending'].includes(stage) || !progress || total === undefined
    || !Number.isSafeInteger(total) || total < MIN_TOTAL_BYTES
    || !Number.isSafeInteger(progress.loaded) || progress.loaded < 0 || progress.loaded >= total) return undefined;
  return { loaded: progress.loaded, total, index: progress.index };
}

function isSameTransfer(
  state: MediaOperationTransferState, operation: MediaOperation, progress: { total: number; index?: number },
) {
  return state.attempt === operation.attempt && state.stage === operation.stage
    && state.index === progress.index && state.total === progress.total;
}
