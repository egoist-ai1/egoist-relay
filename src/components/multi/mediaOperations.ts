import { getGlobal } from '../../global';

import type { ApiAttachment } from '../../api/types';
import type { ThreadId } from '../../types';
import type {
  MediaOperation, MediaOperationAction, MediaOperationPatch, MediaOperationsSnapshot, NewMediaOperation,
} from './mediaOperations.types';
import type { ShareSendJob, SocialMediaProgress, SocialShareMode, SocialShareRequest,
  SocialShareTarget } from './socialShare';
import { MAIN_THREAD_ID } from '../../api/types';

import { parseInlineSocialMediaUrl } from '../../util/inlineSocialMedia';
import MediaOperationQueue from './mediaOperationQueue';
import { isMediaOperationActive } from './mediaOperations.types';
import {
  assertSocialShareTarget, createSocialShareJob, getSocialShareFingerprints, getSocialShareMediaCount,
  getSocialSharePrice, getSocialShareTextParts, releaseSocialShareMedia, resolveSocialShareMedia,
  saveSocialShareMedia, sendSocialShareJob,
} from './socialShare';

// Operation ownership lasts for the application lifetime, independently of dialogs or panels.
const queue = new MediaOperationQueue();
const subscribers = new Set<NoneToVoidFunction>();
const captures = new Map<string, SocialShareRequest>();
const tokens = new Map<string, { canceled: boolean }>();
const cancellationCleanup = new Map<string, Promise<void>>();
const removedIds = new Set<string>();
let snapshot: MediaOperationsSnapshot = { operations: [], isLocked: true };
let isLocked = true;
let snapshotEpoch = -1;
let initialization: Promise<void> | undefined;
let mutationQueue: Promise<unknown> = Promise.resolve();

export function getMediaOperationsSnapshot() {
  return snapshot;
}
export function subscribeMediaOperations(callback: NoneToVoidFunction) {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

function publish(next: MediaOperationsSnapshot) {
  if (next.epoch !== undefined) {
    if (next.epoch < snapshotEpoch) return;
    snapshotEpoch = next.epoch;
  }
  const previous = new Map(snapshot.operations.map((operation) => [operation.id, operation]));
  snapshot = {
    ...next, isLocked: isLocked || next.isLocked,
    operations: isLocked || next.isLocked ? []
      : next.operations.filter(({ id }) => !removedIds.has(id)).map((operation) => {
        const old = previous.get(operation.id);
        return old && (old.attempt > operation.attempt
          || (old.attempt === operation.attempt && old.revision > operation.revision)) ? old : operation;
      }),
  };
  subscribers.forEach((callback) => callback());
}

export function getMediaOperationErrorCode(error: unknown): string {
  const value = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return value.slice(0, 512).match(/\b(?:MEDIA|SOCIAL_SHARE)_[A-Z_]+\b/)?.[0] || 'MEDIA_OPERATION_FAILED';
}

async function invoke<T>(command: string, args?: Record<string, unknown>) {
  const native = await import('@tauri-apps/api/core');
  return native.invoke<T>(command, args);
}

function action(value: MediaOperationAction): Promise<MediaOperationsSnapshot> {
  const result = mutationQueue.catch(() => undefined).then(async () => {
    const next = await invoke<MediaOperationsSnapshot>('relay_media_operation_action', { action: value });
    publish(next);
    return next;
  });
  mutationQueue = result;
  return result;
}

export async function initializeMediaOperations(locked: boolean) {
  isLocked = locked;
  if (locked) queue.setLocked(true);
  if (!initialization) {
    initialization = (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      await listen<MediaOperationsSnapshot>('relay-media-operation', ({ payload }) => publish(payload));
      await listen<SocialMediaProgress>('multi-social-media-progress', ({ payload }) => {
        const token = tokens.get(payload.requestId);
        if (!token || token.canceled) return;
        // Native progress is memory-only. Coalesce callbacks to avoid IPC on every network chunk.
        scheduleProgress(payload.requestId, {
          loaded: payload.loaded, total: payload.total, index: payload.index,
          count: captures.has(payload.requestId)
            ? getSocialShareMediaCount(captures.get(payload.requestId)!) : undefined,
        });
      });
    })();
  }
  try {
    await initialization;
    if (locked !== isLocked) return;
    await action({ type: 'lock', isLocked: locked });
    if (locked !== isLocked) return;
    queue.setLocked(locked);
    publish(await invoke<MediaOperationsSnapshot>('relay_media_operations_list'));
  } catch (error) {
    publish({ operations: [], isLocked: locked, error: getMediaOperationErrorCode(error) });
  }
}

export async function setMediaOperationsLocked(locked: boolean) {
  isLocked = locked;
  if (locked) queue.setLocked(true);
  if (locked) publish({ operations: [], isLocked: true });
  await initializeMediaOperations(locked);
}

async function update(id: string, attempt: number, patch: MediaOperationPatch) {
  // This receipt exposes no source, recipient or file path when the journal is locked.
  for (let retry = 0; retry < 3; retry++) {
    const receipt = await invoke<Pick<MediaOperation, 'attempt' | 'revision' | 'stage'>>(
      'relay_media_operation_revision', { id },
    );
    if (receipt.attempt !== attempt) throw new Error('MEDIA_STALE_ATTEMPT');
    try {
      return await action({ type: 'update', id, attempt, revision: receipt.revision, patch });
    } catch (error) {
      if (!['MEDIA_OPERATION_STALE', 'MEDIA_STALE_REVISION'].includes(getMediaOperationErrorCode(error))) throw error;
    }
  }
  throw new Error('MEDIA_STALE_REVISION');
}

const progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
const progressValues = new Map<string, NonNullable<MediaOperation['progress']>>();
const activeAttempts = new Map<string, number>();
function scheduleProgress(id: string, progress: NonNullable<MediaOperation['progress']>) {
  progressValues.set(id, progress);
  if (progressTimers.has(id)) return;
  progressTimers.set(id, setTimeout(() => {
    progressTimers.delete(id);
    const value = progressValues.get(id);
    const attempt = activeAttempts.get(id);
    if (!value || !attempt || tokens.get(id)?.canceled) return;
    void update(id, attempt, { progress: value }).catch(() => undefined);
  }, 250));
}

export type EnqueueMediaOperation = {
  request: SocialShareRequest;
  kind: 'save' | 'send';
  mode?: SocialShareMode;
  target?: SocialShareTarget;
  recipientName?: string;
  price?: number;
};

export async function enqueueMediaOperation(input: EnqueueMediaOperation): Promise<string> {
  if (queue.size >= 9) throw new Error('MEDIA_QUEUE_FULL');
  const accountId = getGlobal().currentUserId;
  if (input.kind === 'send' && (isLocked || !accountId || !input.target)) throw new Error('MEDIA_ACCOUNT_UNAVAILABLE');
  const id = crypto.randomUUID();
  const canonical = parseInlineSocialMediaUrl(input.request.url)?.canonicalUrl;
  if (!canonical) throw new Error('MEDIA_SOURCE_DENIED');
  const request = { ...input.request, url: canonical };
  const operation: NewMediaOperation = {
    id, kind: input.kind, service: input.request.service, sourceUrl: canonical,
    mode: input.kind === 'send' ? input.mode || 'link' : undefined,
    itemCount: input.kind === 'save' || input.mode !== 'link' ? getSocialShareMediaCount(input.request)
    || undefined : undefined,
    send: input.kind === 'send' ? {
      accountId: accountId!, peerId: input.target!.peerId,
      threadId: input.target!.threadId === undefined || input.target!.threadId === MAIN_THREAD_ID
        ? undefined : String(input.target!.threadId),
      recipientName: input.recipientName || input.target!.peerId,
      confirmed: 0, total: getSocialShareTextParts(input.request).length
        + (input.mode !== 'link' ? getSocialShareMediaCount(input.request) : 0),
    } : undefined,
  };
  await action({ type: 'register', operation });
  try {
    await invoke('multi_social_detach', { requestId: input.request.requestId, operationId: id });
    const ownedRequest = { ...request, requestId: id };
    captures.set(id, ownedRequest);
    queue.add({ id, kind: input.kind, run: () => execute(operation, 1, ownedRequest, input.price || 0) });
  } catch (error) {
    await update(id, 1, { stage: 'failed', error: getMediaOperationErrorCode(error) }).catch(() => undefined);
    throw error;
  }
  return id;
}

async function execute(
  operation: NewMediaOperation | MediaOperation, attempt: number, request: SocialShareRequest, approvedPrice: number,
) {
  const { id } = operation;
  const token = { canceled: false };
  tokens.set(id, token);
  activeAttempts.set(id, attempt);
  let attachments: ApiAttachment[] = [];
  let job: ShareSendJob | undefined;
  let awaitingAcknowledgement = false;
  let failedToPersistConfirmation = false;
  const canceled = () => token.canceled || (operation.kind === 'send' && (isLocked
    || getGlobal().currentUserId !== operation.send?.accountId));
  try {
    if (canceled()) throw new Error('SOCIAL_SHARE_CANCELED');
    await update(id, attempt, { stage: 'resolving' });
    if (operation.kind === 'save') {
      await update(id, attempt, { stage: 'downloading' });
      await saveSocialShareMedia(request, canceled, (index) => {
        scheduleProgress(id, { index, count: getSocialShareMediaCount(request), loaded: 0 });
      });
      await update(id, attempt, { stage: 'completed' });
      return;
    }
    const send = operation.send!;
    if (getGlobal().currentUserId !== send.accountId) {
      throw new Error('MEDIA_ACCOUNT_CHANGED');
    }
    if (operation.mode !== 'link') {
      await update(id, attempt, { stage: 'preparing' });
      attachments = await resolveSocialShareMedia(request, canceled, (index) => {
        scheduleProgress(id, { index, count: getSocialShareMediaCount(request), loaded: 0 });
      });
    }
    const target = { peerId: send.peerId, threadId: send.threadId as ThreadId | undefined };
    job = createSocialShareJob(request, target, attachments, operation.mode);
    job.confirmed = send.confirmed;
    assertSocialShareTarget(target, job.items.flatMap((item) => item.attachment ? [item.attachment] : []));
    const fingerprints = await getSocialShareFingerprints(job);
    if (send.fingerprints?.length && (send.fingerprints.length !== fingerprints.length
      || send.fingerprints.some((value,
        index) => value !== fingerprints[index]))) throw new Error('MEDIA_SOURCE_CHANGED');
    if (send.randomIds?.length) {
      if (send.randomIds.length !== job.items.length) throw new Error('MEDIA_SOURCE_CHANGED');
      job.items.forEach((item, index) => {
        item.randomId = send.randomIds![index];
      });
    }
    const currentPrice = await getSocialSharePrice(target);
    if (currentPrice !== approvedPrice) throw new Error('MEDIA_PRICE_CHANGED');
    if (canceled()) throw new Error('SOCIAL_SHARE_CANCELED');
    await update(id, attempt, {
      total: job.items.length, randomIds: job.items.map((item) => item.randomId), fingerprints,
      media: attachments.map(({ filename, mimeType, size, quick }) => ({
        fileName: filename, mimeType, size, width: quick?.width, height: quick?.height,
      })),
    });
    await sendSocialShareJob(job, approvedPrice, (confirmed, fraction) => {
      // Percentage is meaningful only for a known file size; message count is shown otherwise.
      const item = job!.items[confirmed];
      if (fraction !== undefined && item?.attachment?.size) {
        scheduleProgress(id, { loaded: Math.round(fraction * item.attachment.size), total: item.attachment.size,
          index: confirmed, count: job!.items.length });
      }
    }, {
      isCanceled: canceled,
      onBeforeSend: async () => {
        await update(id, attempt, { stage: 'sending' });
      },
      onDispatch: () => { awaitingAcknowledgement = true; },
      onConfirmed: async (confirmed) => {
        awaitingAcknowledgement = false;
        try {
          await update(id, attempt, {
            confirmed,
          });
        } catch (error) {
          failedToPersistConfirmation = true;
          throw error;
        }
      },
    });
    await update(id, attempt, { stage: 'completed' });
  } catch (error) {
    const code = getMediaOperationErrorCode(error);
    const unknown = awaitingAcknowledgement || failedToPersistConfirmation;
    const stage = unknown ? 'uncertain' : canceled() ? token.canceled ? 'cancelled' : 'interrupted' : 'failed';
    await update(id, attempt, { stage, error: unknown ? 'MEDIA_OUTCOME_UNCERTAIN' : code,
      confirmed: job?.confirmed }).catch(() => undefined);
  } finally {
    const timer = progressTimers.get(id);
    if (timer) clearTimeout(timer);
    progressTimers.delete(id);
    progressValues.delete(id);
    activeAttempts.delete(id);
    tokens.delete(id);
    releaseSocialShareMedia(attachments);
    await invoke('multi_social_release', { requestId: id }).catch(() => undefined);
  }
}

export async function cancelMediaOperation(id: string) {
  const existing = cancellationCleanup.get(id);
  if (existing) return existing;
  const token = tokens.get(id);
  if (token) token.canceled = true;
  const wasWaiting = queue.cancel(id);
  const cleanup = (async () => {
    try {
      await action({
        type: 'cancel', id,
      });
    } finally {
      await invoke('multi_social_cancel_media', { requestId: id }).catch(() => undefined);
      if (wasWaiting) await invoke('multi_social_release', { requestId: id }).catch(() => undefined);
    }
  })();
  cancellationCleanup.set(id, cleanup);
  try {
    await cleanup;
  } finally {
    if (cancellationCleanup.get(id) === cleanup) cancellationCleanup.delete(id);
  }
}

export async function retryMediaOperation(id: string) {
  await cancellationCleanup.get(id);
  await queue.whenIdle(id);
  const operation = snapshot.operations.find((value) => value.id === id);
  if (!operation || isMediaOperationActive(operation)
    || operation.kind === 'download') throw new Error('MEDIA_RECAPTURE_REQUIRED');
  if (operation.stage === 'uncertain') throw new Error('MEDIA_OUTCOME_UNCERTAIN');
  if (operation.send && operation.send.accountId !== getGlobal().currentUserId) {
    throw new Error('MEDIA_ACCOUNT_CHANGED');
  }
  // A real fresh capture supports photos/albums and rechecks text as well as media.
  // The old attempt remains terminal until the user confirms the refreshed dialog.
  window.dispatchEvent(new CustomEvent('relay-media-recapture', { detail: { id } }));
}

export async function resumeMediaOperation(id: string, input: EnqueueMediaOperation): Promise<string> {
  await cancellationCleanup.get(id);
  await queue.whenIdle(id);
  const original = snapshot.operations.find((operation) => operation.id === id);
  if (!original || original.kind !== input.kind
    || isMediaOperationActive(original)) throw new Error('MEDIA_STAGE_DENIED');
  if (original.stage === 'uncertain') throw new Error('MEDIA_OUTCOME_UNCERTAIN');
  if (isLocked) throw new Error('MEDIA_JOURNAL_LOCKED');
  if (queue.size >= 9) throw new Error('MEDIA_QUEUE_FULL');
  const source = parseInlineSocialMediaUrl(input.request.url)?.canonicalUrl;
  if (source !== original.sourceUrl
    || input.request.service !== original.service) throw new Error('MEDIA_SOURCE_CHANGED');
  if (original.itemCount !== undefined && getSocialShareMediaCount(input.request) !== original.itemCount) {
    throw new Error('MEDIA_SOURCE_CHANGED');
  }
  if (original.send && (original.send.accountId !== getGlobal().currentUserId
    || input.target?.peerId !== original.send.peerId || input.mode !== original.mode
    || String(input.target?.threadId === MAIN_THREAD_ID ? '' : input.target?.threadId || '')
    !== String(original.send.threadId || ''))) throw new Error('MEDIA_ACCOUNT_CHANGED');
  if (original.kind === 'save' && original.files.length) {
    // Preserve a partial result. A fresh whole-set save gets its own journal entry and file budget.
    return enqueueMediaOperation(input);
  }
  const next = await action({ type: 'retry', id, accountId: getGlobal().currentUserId });
  const operation = next.operations.find((value) => value.id === id)!;
  try {
    await invoke('multi_social_detach', { requestId: input.request.requestId, operationId: id });
    const request = { ...input.request, requestId: id, url: source! };
    captures.set(id, request);
    queue.add({ id, kind: input.kind, run: () => execute(operation, operation.attempt, request, input.price || 0) });
  } catch (error) {
    await update(id, operation.attempt, { stage: 'failed', error: getMediaOperationErrorCode(error) });
    throw error;
  }
  return id;
}

export async function mediaOperationFileAction(id: string, type: 'open' | 'reveal', index = 0) {
  await action({ type, id, index });
}
export async function clearMediaOperationHistory() {
  const ids = snapshot.operations.filter((operation) => !isMediaOperationActive(operation)).map(({ id }) => id);
  await action({ type: 'clear' });
  ids.forEach((id) => {
    removedIds.add(id);
    captures.delete(id);
  });
}
