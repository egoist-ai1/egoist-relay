import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ApiAttachment } from '../../api/types';
import type { MediaOperation, MediaOperationAction, MediaOperationsSnapshot } from './mediaOperations.types';
import type { ShareSendJob, SocialShareMode, SocialShareRequest, SocialShareTarget } from './socialShare';
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), save: vi.fn(), resolve: vi.fn(), send: vi.fn(), release: vi.fn(),
  dispatch: vi.fn(), assertTarget: vi.fn(), price: vi.fn(), fingerprints: vi.fn(),
  global: { currentUserId: '100' },
}));
vi.mock('../../global', () => ({ getGlobal: () => mocks.global }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('./socialShare', () => ({
  saveSocialShareMedia: mocks.save,
  resolveSocialShareMedia: mocks.resolve,
  sendSocialShareJob: mocks.send,
  releaseSocialShareMedia: mocks.release,
  assertSocialShareTarget: mocks.assertTarget,
  getSocialSharePrice: mocks.price,
  getSocialShareFingerprints: mocks.fingerprints,
  getSocialShareMediaCount: (request: SocialShareRequest) => request.unavailableMedia ? 1 : request.media?.length || 0,
  getSocialShareTextParts: (request: SocialShareRequest) => [`${request.text || ''}\n\n${request.url}`],
  createSocialShareJob: (request: SocialShareRequest, target: SocialShareTarget,
    attachments: ApiAttachment[], mode: SocialShareMode) => ({
    target, confirmed: 0, busy: false,
    items: [
      { randomId: String(++identity), text: `${request.text || ''}\n\n${request.url}` },
      ...attachments.map((attachment) => ({
        randomId: String(++identity),
        attachment: mode === 'file' ? { ...attachment, shouldSendAsFile: true } : attachment,
      })),
    ],
  }),
}));
type Controller = typeof import('./mediaOperations');
type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};
type Lifecycle = {
  isCanceled: () => boolean;
  onBeforeSend: (index: number) => Promise<void>;
  onDispatch: (index: number) => void;
  onConfirmed: (confirmed: number) => Promise<void>;
};
const source = 'https://x.com/i/status/1234567890123456789';
const request: SocialShareRequest = {
  requestId: '11111111-1111-4111-8111-111111111111', service: 'x', url: source, text: 'Test post',
  media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/private-test.jpg?token=temporary' }],
};
const target = { peerId: '100' };
const savedFile = { path: 'C:/Downloads/test.jpg', fileName: 'test.jpg', mimeType: 'image/jpeg', size: 4 };
const textFingerprint = 'a'.repeat(64);
let identity = 1000;
let controller: Controller;
let registry: MediaOperation[];
let locked: boolean;
let epoch: number;
let staleUpdates: number;
let receiptAttemptOffset: number;
let failAction: ((action: MediaOperationAction) => boolean) | undefined;
let failBeforeDispatch: number | undefined;
let failAfterDispatch: boolean;
let failConfirmation: boolean;
let mediaFingerprint: string;
let releaseGate: Deferred | undefined;
let listeners: Map<string, (event: {
  payload: MediaOperationsSnapshot;
}) => void>;
let gates: Deferred[];
let events: string[];
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  const gate = { promise, resolve };
  gates.push(gate);
  return gate;
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function nativeSnapshot(): MediaOperationsSnapshot {
  return { epoch, operations: locked ? [] : clone(registry), isLocked: locked };
}
function operation(id: string) {
  return registry.find((value) => value.id === id)!;
}
function nativeActions() {
  return mocks.invoke.mock.calls.filter(([command]) => command === 'relay_media_operation_action')
    .map(([, args]) => (args as {
      action: MediaOperationAction;
    }).action);
}
function emit(snapshot: MediaOperationsSnapshot) {
  listeners.get('relay-media-operation')!({ payload: clone(snapshot) });
}
function buildTestAttachment(): ApiAttachment {
  return {
    blob: new Blob(['test']), blobUrl: 'blob:original', compressedBlobUrl: 'blob:compressed',
    previewBlobUrl: 'blob:preview', filename: 'test.jpg', mimeType: 'image/jpeg', size: 4, uniqueId: 'test',
  };
}
function freshRequest(): SocialShareRequest {
  return { ...request, requestId: crypto.randomUUID() };
}
async function settled(id: string, stage = 'completed') {
  await vi.waitFor(() => {
    expect(operation(id).stage).toBe(stage);
    expect(mocks.invoke).toHaveBeenCalledWith('multi_social_release', { requestId: id });
  });
}
async function nativeInvoke(command: string, args?: Record<string, unknown>) {
  if (command === 'relay_media_operations_list') {
    return nativeSnapshot();
  }
  if (command === 'relay_media_operation_revision') {
    const value = operation(args!.id as string);
    return { attempt: value.attempt + receiptAttemptOffset, revision: value.revision, stage: value.stage };
  }
  if (command === 'multi_social_release') {
    if (releaseGate) {
      await releaseGate.promise;
    }
    return undefined;
  }
  if (['multi_social_detach', 'multi_social_cancel_media'].includes(command)) {
    return undefined;
  }
  if (command !== 'relay_media_operation_action') {
    throw new Error(`Unexpected native command: ${command}`);
  }
  const action = args!.action as MediaOperationAction;
  events.push(`native:${action.type}`);
  if (failAction?.(action)) {
    throw new Error('MEDIA_JOURNAL_WRITE_FAILED');
  }
  if (action.type === 'lock') {
    locked = action.isLocked;
  }
  if (action.type === 'register') {
    registry.push({ ...clone(action.operation), attempt: 1, revision: 1, stage: 'queued',
      createdAt: 1, updatedAt: 1, files: [] });
  }
  if (action.type === 'update') {
    const value = operation(action.id);
    if (staleUpdates > 0) {
      staleUpdates--;
      value.revision++;
      epoch++;
      throw new Error('MEDIA_OPERATION_STALE');
    }
    if (value.attempt !== action.attempt || value.revision !== action.revision) {
      throw new Error('MEDIA_OPERATION_STALE');
    }
    if (action.patch.confirmed !== undefined && failConfirmation) {
      failConfirmation = false;
      throw new Error('MEDIA_JOURNAL_WRITE_FAILED');
    }
    if (action.patch.confirmed !== undefined && action.patch.confirmed < (value.send?.confirmed || 0)) {
      throw new Error('MEDIA_STAGE_DENIED');
    }
    const { confirmed, total, randomIds, fingerprints, ...fields } = action.patch;
    Object.assign(value, fields);
    if (value.send) {
      if (confirmed !== undefined) {
        value.send.confirmed = confirmed;
      }
      if (total !== undefined) {
        value.send.total = total;
      }
      if (randomIds !== undefined) {
        value.send.randomIds = randomIds;
      }
      if (fingerprints !== undefined) {
        value.send.fingerprints = fingerprints;
      }
    }
    value.revision++;
    events.push(`stage:${action.patch.stage || 'unchanged'}`);
  }
  if (action.type === 'cancel') {
    const value = operation(action.id);
    value.stage = value.stage === 'queued' ? 'cancelled' : 'cancelling';
    value.revision++;
  }
  if (action.type === 'retry') {
    const value = operation(action.id);
    if (!['failed', 'interrupted', 'cancelled'].includes(value.stage)) {
      throw new Error('MEDIA_STAGE_DENIED');
    }
    value.attempt++;
    value.revision++;
    value.stage = 'queued';
    value.error = undefined;
  }
  if (action.type === 'clear') {
    registry = registry.filter((value) => [
      'queued', 'resolving', 'downloading', 'writing', 'preparing', 'sending', 'cancelling',
    ].includes(value.stage));
  }
  epoch++;
  return nativeSnapshot();
}
async function sendJob(job: ShareSendJob, price: number,
  onProgress: (confirmed: number, fraction?: number) => void, lifecycle: Lifecycle) {
  for (let index = job.confirmed; index < job.items.length; index++) {
    if (lifecycle.isCanceled()) {
      throw new Error('SOCIAL_SHARE_CANCELED');
    }
    if (failBeforeDispatch === index) {
      throw new Error('MEDIA_NETWORK_FAILED');
    }
    await lifecycle.onBeforeSend(index);
    if (lifecycle.isCanceled()) {
      throw new Error('SOCIAL_SHARE_CANCELED');
    }
    lifecycle.onDispatch(index);
    events.push(`dispatch:${job.items[index].randomId}`);
    mocks.dispatch(job.items[index], job.target, price);
    if (failAfterDispatch) {
      throw new Error('SOCIAL_SHARE_UNCONFIRMED');
    }
    job.confirmed++;
    await lifecycle.onConfirmed(job.confirmed);
    onProgress(job.confirmed);
  }
}
beforeEach(async () => {
  vi.resetModules();
  Object.values(mocks).forEach((value) => {
    if (vi.isMockFunction(value)) {
      value.mockReset();
    }
  });
  mocks.global.currentUserId = '100';
  identity = 1000;
  registry = [];
  locked = true;
  epoch = 0;
  staleUpdates = 0;
  receiptAttemptOffset = 0;
  failAction = undefined;
  failBeforeDispatch = undefined;
  failAfterDispatch = false;
  failConfirmation = false;
  mediaFingerprint = 'b'.repeat(64);
  releaseGate = undefined;
  gates = [];
  events = [];
  listeners = new Map();
  mocks.invoke.mockImplementation(nativeInvoke);
  // Tauri also forwards through this bridge when Vitest resolves a concurrent dynamic import without its factory.
  // Both import paths remain the same strictly checked IPC fake; no native command leaves the test process.
  vi.stubGlobal('__TAURI_INTERNALS__', {
    invoke: (command: string, args?: Record<string, unknown>) => mocks.invoke(command, args),
  });
  mocks.listen.mockImplementation((event: string, callback: (value: {
    payload: MediaOperationsSnapshot;
  }) => void) => {
    listeners.set(event, callback);
    return Promise.resolve(() => {
      listeners.delete(event);
    });
  });
  mocks.save.mockResolvedValue([savedFile]);
  mocks.resolve.mockImplementation(() => Promise.resolve([buildTestAttachment()]));
  mocks.send.mockImplementation(sendJob);
  mocks.price.mockResolvedValue(0);
  mocks.fingerprints.mockImplementation((job: ShareSendJob) => Promise.resolve(
    job.items.map((item) => item.attachment ? mediaFingerprint : textFingerprint),
  ));
  controller = await import('./mediaOperations');
  await controller.initializeMediaOperations(false);
});
afterEach(async () => {
  failAction = undefined;
  receiptAttemptOffset = 0;
  gates.forEach((gate) => gate.resolve());
  await controller.setMediaOperationsLocked(false);
  const ownedIds = new Set(mocks.invoke.mock.calls.filter(([command]) => command === 'multi_social_detach')
    .map(([, args]) => (args as {
      operationId: string;
    }).operationId));
  await vi.waitFor(() => ownedIds.forEach((id) => {
    expect(mocks.invoke).toHaveBeenCalledWith('multi_social_release', { requestId: id });
  }));
});
describe('Application-owned operations', () => {
  test('Transfers the original capture UUID and keeps work alive after panel closure and service switching',
    async () => {
      const gate = deferred();
      mocks.save.mockImplementationOnce(async () => {
        await gate.promise;
        return [savedFile];
      });
      const observer = vi.fn();
      const closePanel = controller.subscribeMediaOperations(observer);
      const id = await controller.enqueueMediaOperation({ kind: 'save', request: {
        ...request, url: 'https://www.twitter.com/person/status/1234567890123456789?tracking=1',
      } });
      expect(id).not.toBe(request.requestId);
      expect(mocks.invoke).toHaveBeenCalledWith(
        'multi_social_detach', { requestId: request.requestId, operationId: id },
      );
      await vi.waitFor(() => expect(mocks.save).toHaveBeenCalled());
      closePanel();
      const countBeforeClosing = observer.mock.calls.length;
      window.dispatchEvent(new CustomEvent('egoist-relay-service-change', { detail: { service: 'instagram' } }));
      gate.resolve();
      await settled(id);
      expect(mocks.save.mock.calls[0][0]).toMatchObject({ requestId: id, url: source });
      expect(observer).toHaveBeenCalledTimes(countBeforeClosing);
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'multi_social_cancel_media')).toHaveLength(0);
      const registered = nativeActions().find((action) => action.type === 'register');
      expect(JSON.stringify(registered)).not.toContain('private-test.jpg');
      expect(JSON.stringify(registered)).not.toContain('Test post');
    });
  test('A locked journal pauses the next send while an active local save can finish', async () => {
    const gate = deferred();
    mocks.save.mockImplementationOnce(async () => {
      await gate.promise;
      return [savedFile];
    });
    const active = await controller.enqueueMediaOperation({ kind: 'save', request });
    const waiting = await controller.enqueueMediaOperation({
      kind: 'send', request: freshRequest(), target, mode: 'link',
    });
    await controller.setMediaOperationsLocked(true);
    gate.resolve();
    await settled(active);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(controller.getMediaOperationsSnapshot()).toMatchObject({ isLocked: true, operations: [] });
    await controller.setMediaOperationsLocked(false);
    await settled(waiting);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
  test('Keeps the safe Link default and omits the main Telegram thread sentinel from the journal',
    async () => {
      const id = await controller.enqueueMediaOperation({
        kind: 'send', request, target: { peerId: '100', threadId: -1 },
      });
      await settled(id);
      expect(operation(id)).toMatchObject({ mode: 'link', send: { accountId: '100', peerId: '100', confirmed: 1 } });
      expect(operation(id).send?.threadId).toBeUndefined();
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);
      expect(mocks.dispatch.mock.calls[0][0].text).toContain(source);
    });
  test('Limits ownership to one worker and eight waiting operations, and releases a canceled waiting capture',
    async () => {
      const gate = deferred();
      mocks.save.mockImplementationOnce(async () => {
        await gate.promise;
        return [savedFile];
      });
      const active = await controller.enqueueMediaOperation({ kind: 'save', request });
      const waiting: string[] = [];
      for (let index = 0; index < 8; index++) {
        waiting.push(await controller.enqueueMediaOperation({
          kind: 'send', request: freshRequest(), target, mode: 'link',
        }));
      }
      await expect(controller.enqueueMediaOperation({ kind: 'save', request: freshRequest() }))
        .rejects.toThrow('MEDIA_QUEUE_FULL');
      expect(nativeActions().filter((action) => action.type === 'register')).toHaveLength(9);
      await controller.cancelMediaOperation(waiting[0]);
      expect(mocks.invoke).toHaveBeenCalledWith('multi_social_cancel_media', { requestId: waiting[0] });
      expect(mocks.invoke).toHaveBeenCalledWith('multi_social_release', { requestId: waiting[0] });
      expect(operation(waiting[0]).stage).toBe('cancelled');
      expect(mocks.dispatch).not.toHaveBeenCalled();
      gate.resolve();
      await settled(active);
      await settled(waiting[7]);
      expect(mocks.dispatch).toHaveBeenCalledTimes(7);
      expect(operation(waiting[0]).send?.confirmed).toBe(0);
    });
  test('Releases a waiting capture even if persisting its cancellation fails',
    async () => {
      const gate = deferred();
      mocks.save.mockImplementationOnce(async () => {
        await gate.promise;
        return [savedFile];
      });
      const active = await controller.enqueueMediaOperation({ kind: 'save', request });
      const waiting = await controller.enqueueMediaOperation({
        kind: 'send', request: freshRequest(), target, mode: 'link',
      });
      failAction = (action) => action.type === 'cancel';
      await expect(controller.cancelMediaOperation(waiting)).rejects.toThrow('MEDIA_JOURNAL_WRITE_FAILED');
      expect(mocks.invoke).toHaveBeenCalledWith('multi_social_cancel_media', { requestId: waiting });
      expect(mocks.invoke).toHaveBeenCalledWith('multi_social_release', { requestId: waiting });
      gate.resolve();
      await settled(active);
      expect(mocks.dispatch).not.toHaveBeenCalled();
    });
  test('Cancels native workers even when the journal cancel transaction fails',
    async () => {
      const gate = deferred();
      mocks.save.mockImplementationOnce(async (_request, isCanceled: () => boolean) => {
        await gate.promise;
        if (isCanceled()) {
          throw new Error('SOCIAL_SHARE_CANCELED');
        }
        return [savedFile];
      });
      const id = await controller.enqueueMediaOperation({ kind: 'save', request });
      await vi.waitFor(() => expect(mocks.save).toHaveBeenCalled());
      failAction = (action) => action.type === 'cancel';
      await expect(controller.cancelMediaOperation(id)).rejects.toThrow('MEDIA_JOURNAL_WRITE_FAILED');
      expect(mocks.invoke).toHaveBeenCalledWith('multi_social_cancel_media', { requestId: id });
      gate.resolve();
      await settled(id, 'cancelled');
    });
});
describe('Native snapshot and receipt ordering', () => {
  test('Rejects an old full snapshot that would erase a newly registered queued operation',
    async () => {
      const gate = deferred();
      mocks.save.mockImplementationOnce(async () => {
        await gate.promise;
        return [savedFile];
      });
      const old = nativeSnapshot();
      const id = await controller.enqueueMediaOperation({ kind: 'save', request });
      emit(old);
      expect(controller.getMediaOperationsSnapshot().operations.map((value) => value.id)).toContain(id);
      gate.resolve();
      await settled(id);
    });
  test('Does not resurrect a completed record first seen only in a stale snapshot after history was cleared',
    async () => {
      const oldEpoch = epoch;
      await controller.clearMediaOperationHistory();
      emit({ epoch: oldEpoch, isLocked: false, operations: [{
        id: crypto.randomUUID(), attempt: 1, revision: 1, kind: 'save', service: 'x', sourceUrl: source,
        stage: 'completed', createdAt: 1, updatedAt: 1, files: [savedFile],
      }] });
      expect(controller.getMediaOperationsSnapshot().operations).toEqual([]);
    });
  test('Hides paths and recipients when a delayed unlocked payload arrives after local lock',
    async () => {
      const id = await controller.enqueueMediaOperation({ kind: 'send', request, target, mode: 'link' });
      await settled(id);
      const old = nativeSnapshot();
      await controller.setMediaOperationsLocked(true);
      emit({ ...old, epoch: epoch + 1 });
      expect(controller.getMediaOperationsSnapshot()).toMatchObject({ isLocked: true, operations: [] });
    });
  test('Retries a stale CAS revision with a fresh receipt before executing transport',
    async () => {
      staleUpdates = 1;
      const id = await controller.enqueueMediaOperation({ kind: 'send', request, target, mode: 'link' });
      await settled(id);
      const resolutionUpdates = nativeActions().filter((action) => action.type === 'update'
        && action.patch.stage === 'resolving');
      expect(resolutionUpdates).toHaveLength(2);
      expect(resolutionUpdates).toMatchObject([{ revision: 1 }, { revision: 2 }]);
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    });
  test('Stops an old attempt when the native receipt belongs to a newer attempt',
    async () => {
      receiptAttemptOffset = 1;
      const id = await controller.enqueueMediaOperation({ kind: 'send', request, target, mode: 'link' });
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('multi_social_release', { requestId: id }));
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(nativeActions().filter((action) => action.type === 'update')).toHaveLength(0);
    });
});
describe('Durable send boundaries', () => {
  test('Persists Sending before each dispatch and a receipt before Completed',
    async () => {
      const id = await controller.enqueueMediaOperation({ kind: 'send', request, target, mode: 'file' });
      await settled(id);
      const sendStages = events.map((event, index) => event === 'stage:sending' ? index : -1)
        .filter((index) => index >= 0);
      const dispatches = events.map((event, index) => event.startsWith('dispatch:') ? index : -1)
        .filter((index) => index >= 0);
      expect(sendStages).toHaveLength(2);
      expect(dispatches).toHaveLength(2);
      expect(sendStages[0]).toBeLessThan(dispatches[0]);
      expect(sendStages[1]).toBeLessThan(dispatches[1]);
      expect(operation(id).send).toMatchObject({ confirmed: 2, total: 2,
        randomIds: ['1001', '1002'], fingerprints: [textFingerprint, 'b'.repeat(64)] });
      expect(mocks.assertTarget.mock.calls[0][1][0].shouldSendAsFile).toBe(true);
      expect(mocks.release).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ blobUrl: 'blob:original' }),
      ]));
    });
  test('A journal failure before Sending prevents dispatch',
    async () => {
      failAction = (action) => action.type === 'update' && action.patch.stage === 'sending';
      const id = await controller.enqueueMediaOperation({ kind: 'send', request, target, mode: 'link' });
      await settled(id, 'failed');
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(operation(id).error).toBe('MEDIA_JOURNAL_WRITE_FAILED');
    });
  test.each(['dispatch', 'confirmation'] as const)(
    'Marks an unknown outcome after %s failure without automatic retry', async (failure) => {
      failAfterDispatch = failure === 'dispatch';
      failConfirmation = failure === 'confirmation';
      const id = await controller.enqueueMediaOperation({ kind: 'send', request, target, mode: 'link' });
      await settled(id, 'uncertain');
      expect(operation(id).error).toBe('MEDIA_OUTCOME_UNCERTAIN');
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);
      await expect(controller.retryMediaOperation(id)).rejects.toThrow('MEDIA_OUTCOME_UNCERTAIN');
      expect(nativeActions().filter((action) => action.type === 'retry')).toHaveLength(0);
    });
  test('Account change during preparation interrupts the operation before any dispatch',
    async () => {
      const gate = deferred();
      mocks.resolve.mockImplementationOnce(async () => {
        await gate.promise;
        return [buildTestAttachment()];
      });
      const id = await controller.enqueueMediaOperation({ kind: 'send', request, target, mode: 'media' });
      await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalled());
      mocks.global.currentUserId = '200';
      gate.resolve();
      await settled(id, 'interrupted');
      expect(mocks.dispatch).not.toHaveBeenCalled();
      await expect(controller.retryMediaOperation(id)).rejects.toThrow('MEDIA_ACCOUNT_CHANGED');
      expect(mocks.release).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ filename: 'test.jpg' }),
      ]));
    });
  test('A changed Telegram price blocks dispatch until new approval',
    async () => {
      mocks.price.mockResolvedValue(5);
      const id = await controller.enqueueMediaOperation({ kind: 'send', request, target, mode: 'link', price: 0 });
      await settled(id, 'failed');
      expect(operation(id).error).toBe('MEDIA_PRICE_CHANGED');
      expect(mocks.dispatch).not.toHaveBeenCalled();
    });
});
describe('Fresh capture retries', () => {
  async function partialSend() {
    failBeforeDispatch = 1;
    const id = await controller.enqueueMediaOperation({ kind: 'send', request, target, mode: 'media' });
    await settled(id, 'failed');
    expect(operation(id).send?.confirmed).toBe(1);
    failBeforeDispatch = undefined;
    return id;
  }
  test('Retry requests a fresh capture without changing attempt or replaying media',
    async () => {
      const id = await partialSend();
      const event = vi.fn();
      window.addEventListener('relay-media-recapture', event);
      await controller.retryMediaOperation(id);
      window.removeEventListener('relay-media-recapture', event);
      expect(event).toHaveBeenCalledTimes(1);
      expect((event.mock.calls[0][0] as CustomEvent).detail).toEqual({ id });
      expect(operation(id).attempt).toBe(1);
      expect(nativeActions().filter((action) => action.type === 'retry')).toHaveLength(0);
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    });
  test('Fresh retry preserves identities and fingerprints, skips confirmed items, and detaches the new capture',
    async () => {
      const id = await partialSend();
      const fresh = freshRequest();
      await controller.resumeMediaOperation(id, { kind: 'send', request: fresh, target, mode: 'media' });
      await settled(id);
      expect(operation(id).attempt).toBe(2);
      expect(operation(id).send).toMatchObject({ confirmed: 2, randomIds: ['1001', '1002'],
        fingerprints: [textFingerprint, 'b'.repeat(64)] });
      expect(mocks.dispatch.mock.calls.map(([item]) => item.randomId)).toEqual(['1001', '1002']);
      expect(mocks.invoke).toHaveBeenCalledWith('multi_social_detach', { requestId: fresh.requestId, operationId: id });
      expect(mocks.resolve.mock.calls[1][0].requestId).toBe(id);
    });
  test('Retries a partial save as a new operation while preserving the old files and result', async () => {
    const album: SocialShareRequest = { ...request, media: [
      ...request.media!, { type: 'photo', url: 'https://pbs.twimg.com/media/second.jpg' },
    ] };
    const repeatedFiles = [
      { ...savedFile, path: 'C:/Downloads/test-2.jpg', fileName: 'test-2.jpg' },
      { ...savedFile, path: 'C:/Downloads/second.jpg', fileName: 'second.jpg' },
    ];
    mocks.save.mockImplementation((owned: SocialShareRequest) => {
      const isFirstAttempt = mocks.save.mock.calls.length === 1;
      const published = isFirstAttempt ? [savedFile] : repeatedFiles;
      const current = operation(owned.requestId);
      current.files.push(...published);
      current.revision++;
      epoch++;
      emit(nativeSnapshot());
      if (isFirstAttempt) throw new Error('SOCIAL_SHARE_MEDIA_FETCH_FAILED');
      return Promise.resolve(published);
    });
    const id = await controller.enqueueMediaOperation({ kind: 'save', request: album });
    await settled(id, 'failed');
    const previous = clone(operation(id));
    const fresh = { ...album, requestId: crypto.randomUUID() };
    const resumedId = await controller.resumeMediaOperation(id, { kind: 'save', request: fresh });
    await settled(resumedId);
    expect(resumedId).not.toBe(id);
    expect(operation(id)).toEqual(previous);
    expect(operation(id)).toMatchObject({ stage: 'failed', attempt: 1, files: [savedFile] });
    expect(operation(resumedId)).toMatchObject({
      stage: 'completed', attempt: 1, itemCount: 2, files: repeatedFiles,
    });
    expect(controller.getMediaOperationsSnapshot().operations.map((value) => value.id))
      .toEqual(expect.arrayContaining([id, resumedId]));
    expect(nativeActions().filter((action) => action.type === 'retry')).toHaveLength(0);
    expect(mocks.invoke).toHaveBeenCalledWith('multi_social_detach', {
      requestId: fresh.requestId, operationId: resumedId,
    });
    expect(mocks.save.mock.calls.map(([owned]) => owned.requestId)).toEqual([id, resumedId]);
  });
  test('Waits for the old worker release before incrementing attempt and acquiring a fresh capture',
    async () => {
      releaseGate = deferred();
      mocks.save.mockRejectedValueOnce(new Error('MEDIA_NETWORK_FAILED'));
      const id = await controller.enqueueMediaOperation({ kind: 'save', request });
      await settled(id, 'failed');
      const fresh = freshRequest();
      const resumed = controller.resumeMediaOperation(id, { kind: 'save', request: fresh });
      await vi.dynamicImportSettled();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(operation(id).attempt).toBe(1);
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'multi_social_detach')).toHaveLength(1);
      releaseGate.resolve();
      await resumed;
      await settled(id);
      expect(operation(id).attempt).toBe(2);
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'multi_social_detach')).toHaveLength(2);
    });
  test('Waits for cancellation cleanup of a queued capture before native retry and detach',
    async () => {
      const gate = deferred();
      mocks.save.mockImplementationOnce(async () => {
        await gate.promise;
        return [savedFile];
      });
      const active = await controller.enqueueMediaOperation({ kind: 'save', request });
      const id = await controller.enqueueMediaOperation({
        kind: 'send', request: freshRequest(), target, mode: 'link',
      });
      releaseGate = deferred();
      const cleanup = controller.cancelMediaOperation(id);
      await vi.waitFor(() => expect(operation(id).stage).toBe('cancelled'));
      const fresh = freshRequest();
      const resumed = controller.resumeMediaOperation(id, { kind: 'send', request: fresh, target, mode: 'link' });
      await vi.dynamicImportSettled();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(operation(id).attempt).toBe(1);
      releaseGate.resolve();
      await cleanup;
      await resumed;
      expect(operation(id).attempt).toBe(2);
      gate.resolve();
      await settled(active);
      await settled(id);
    });
  test.each(['source', 'kind', 'account', 'mode', 'target', 'count'] as const)(
    'Rejects a changed %s before mutating a failed attempt', async (changed) => {
      const id = await partialSend();
      const input = {
        kind: 'send' as 'save' | 'send', request: freshRequest(), target, mode: 'media' as SocialShareMode,
      };
      if (changed === 'source') {
        input.request.url = 'https://x.com/i/status/9999999999999999999';
      }
      if (changed === 'kind') {
        input.kind = 'save';
      }
      if (changed === 'account') {
        mocks.global.currentUserId = '200';
      }
      if (changed === 'mode') {
        input.mode = 'file';
      }
      if (changed === 'target') {
        input.target = { peerId: '200' };
      }
      if (changed === 'count') {
        input.request.media = [];
      }
      await expect(controller.resumeMediaOperation(id, input))
        .rejects.toThrow(/MEDIA_(SOURCE_CHANGED|ACCOUNT_CHANGED|STAGE_DENIED)/);
      expect(operation(id).attempt).toBe(1);
      expect(nativeActions().filter((action) => action.type === 'retry')).toHaveLength(0);
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    });
  test('Rejects changed media bytes before replaying any Telegram item',
    async () => {
      const id = await partialSend();
      mediaFingerprint = 'c'.repeat(64);
      await controller.resumeMediaOperation(id, {
        kind: 'send', request: freshRequest(), target, mode: 'media',
      });
      await settled(id, 'failed');
      expect(operation(id).attempt).toBe(2);
      expect(operation(id).error).toBe('MEDIA_SOURCE_CHANGED');
      expect(operation(id).send?.confirmed).toBe(1);
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    });
  test('Normalizes MAIN_THREAD_ID on a fresh retry of an ordinary Telegram chat',
    async () => {
      failBeforeDispatch = 0;
      const id = await controller.enqueueMediaOperation({
        kind: 'send', request, target: { peerId: '100', threadId: -1 },
        mode: 'link' });
      await settled(id, 'failed');
      failBeforeDispatch = undefined;
      await controller.resumeMediaOperation(id, { kind: 'send', request: freshRequest(),
        target: { peerId: '100', threadId: -1 }, mode: 'link' });
      await settled(id);
      expect(operation(id).attempt).toBe(2);
      expect(operation(id).send?.threadId).toBeUndefined();
    });
});
