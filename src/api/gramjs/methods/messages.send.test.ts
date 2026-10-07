import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api as GramJs } from '../../../lib/gramjs';

import type { SendMessageParams } from '../../../types';
import type { ApiAttachment, ApiChat, ApiMessage, ApiOnProgress } from '../../types';

import { sendApiUpdate } from '../updates/apiUpdateEmitter';
import { invokeRequest, uploadFile } from './client';
import { sendApiMessage } from './messages';

vi.mock('./client', () => ({
  invokeRequest: vi.fn(),
  uploadFile: vi.fn(),
  handleGramJsUpdate: vi.fn(),
}));

vi.mock('../updates/apiUpdateEmitter', () => ({
  sendApiUpdate: vi.fn(),
}));

vi.mock('../../../util/files', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../util/files')>(),
  fetchFile: vi.fn((_url: string, filename: string) => Promise.resolve(new File(['x'], filename))),
}));

const FAST_SEND_TIMEOUT = 1000;
const onProgress = (() => {}) as unknown as ApiOnProgress;
const FAILING_FILE = 'broken.jpg';

const chat = { id: '100', accessHash: '1', type: 'chatTypePrivate' } as unknown as ApiChat;
const mockedInvokeRequest = vi.mocked(invokeRequest) as unknown as ReturnType<typeof vi.fn>;
const mockedUploadFile = vi.mocked(uploadFile) as unknown as ReturnType<typeof vi.fn>;
const mockedSendApiUpdate = vi.mocked(sendApiUpdate);

let nextLocalId = 0;
let nextGroupId = 0;

function buildLocalMessage(): ApiMessage {
  nextLocalId += 1;
  return { id: nextLocalId, chatId: chat.id, date: 1, content: {}, isOutgoing: true };
}

function buildAttachment(filename: string): ApiAttachment {
  return {
    filename, blobUrl: `blob:${filename}`, mimeType: 'image/jpeg', size: 1, quick: { width: 1, height: 1 },
  };
}

function buildParams(attachment: ApiAttachment, groupedId?: string): SendMessageParams {
  return { chat, attachment, groupedId, text: '' };
}

function buildPhotoResponse() {
  return new GramJs.MessageMediaPhoto({
    photo: new GramJs.Photo({
      id: BigInt(1), accessHash: BigInt(2), fileReference: new Uint8Array(1), date: 1, sizes: [], dcId: 2,
    }),
  });
}

function getRequests(className: string) {
  return mockedInvokeRequest.mock.calls
    .map(([request]) => request as { className: string; multiMedia?: unknown[] })
    .filter((request) => request.className === className);
}

function getUpdates(type: string) {
  return mockedSendApiUpdate.mock.calls
    .map(([update]) => update as unknown as { '@type': string; localId?: number; error?: string })
    .filter((update) => update['@type'] === type);
}

beforeEach(() => {
  vi.useFakeTimers();
  mockedInvokeRequest.mockReset();
  mockedUploadFile.mockReset();
  mockedSendApiUpdate.mockReset();
  mockedUploadFile.mockImplementation((file: File) => (
    file.name === FAILING_FILE
      ? Promise.reject(new Error('Network down'))
      : Promise.resolve(new GramJs.InputFile({ id: BigInt(1), parts: 1, name: file.name, md5Checksum: '' }))
  ));
  mockedInvokeRequest.mockImplementation((request: { className: string }) => {
    if (request.className === 'messages.UploadMedia') return Promise.resolve(buildPhotoResponse());
    if (request.className === 'messages.SendMultiMedia') return Promise.resolve(new GramJs.UpdatesTooLong());
    return Promise.resolve(new GramJs.UpdatesTooLong());
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('album sending', () => {
  it('sends the uploaded items when the last file of the album fails', async () => {
    nextGroupId += 1;
    const groupedId = `album-${nextGroupId}`;
    const first = buildLocalMessage();
    const last = buildLocalMessage();

    await Promise.all([
      sendApiMessage(buildParams(buildAttachment('first.jpg'), groupedId), first, onProgress),
      sendApiMessage(buildParams(buildAttachment(FAILING_FILE), groupedId), last, onProgress),
    ]);

    const albumRequests = getRequests('messages.SendMultiMedia');
    expect(albumRequests).toHaveLength(1);
    expect(albumRequests[0].multiMedia).toHaveLength(1);
    expect(getUpdates('updateMessageSendFailed').map((update) => update.localId)).toEqual([last.id]);

    await vi.advanceTimersByTimeAsync(FAST_SEND_TIMEOUT * 2);
    const pendingIds = getUpdates('updateMessage').map((update) => update.localId);
    expect(pendingIds).not.toContain(first.id);
    expect(pendingIds).not.toContain(last.id);
  });

  it('marks every item failed and sends nothing when all files of the album fail', async () => {
    nextGroupId += 1;
    const groupedId = `album-${nextGroupId}`;
    const first = buildLocalMessage();
    const second = buildLocalMessage();

    await Promise.all([
      sendApiMessage(buildParams(buildAttachment(FAILING_FILE), groupedId), first, onProgress),
      sendApiMessage(buildParams(buildAttachment(FAILING_FILE), groupedId), second, onProgress),
    ]);

    expect(getRequests('messages.SendMultiMedia')).toHaveLength(0);
    expect(getUpdates('updateMessageSendFailed').map((update) => update.localId).sort())
      .toEqual([first.id, second.id].sort());
  });

  it('marks every item failed when the album request is rejected by the server', async () => {
    nextGroupId += 1;
    const groupedId = `album-${nextGroupId}`;
    const first = buildLocalMessage();
    const second = buildLocalMessage();
    mockedInvokeRequest.mockImplementation((request: { className: string }) => (
      Promise.resolve(request.className === 'messages.UploadMedia' ? buildPhotoResponse() : undefined)
    ));

    await Promise.all([
      sendApiMessage(buildParams(buildAttachment('a.jpg'), groupedId), first, onProgress),
      sendApiMessage(buildParams(buildAttachment('b.jpg'), groupedId), second, onProgress),
    ]);

    expect(getUpdates('updateMessageSendFailed').map((update) => update.localId).sort())
      .toEqual([first.id, second.id].sort());
    await vi.advanceTimersByTimeAsync(FAST_SEND_TIMEOUT * 2);
    expect(getUpdates('updateMessage')).toHaveLength(0);
  });
});

describe('single message failures', () => {
  it('reports an attachment upload failure and stops the pending-state timer', async () => {
    const local = buildLocalMessage();

    await sendApiMessage(buildParams(buildAttachment(FAILING_FILE)), local, onProgress);

    expect(getUpdates('updateMessageSendFailed').map((update) => update.localId)).toEqual([local.id]);
    await vi.advanceTimersByTimeAsync(FAST_SEND_TIMEOUT * 2);
    expect(getUpdates('updateMessage')).toHaveLength(0);
  });

  it('reports a poll media upload failure and stops the pending-state timer', async () => {
    const local = buildLocalMessage();
    const params = {
      chat,
      poll: {
        summary: { question: { text: 'Question' }, answers: [] },
        attachedMedia: buildAttachment(FAILING_FILE),
      },
    } as unknown as SendMessageParams;

    await sendApiMessage(params, local, onProgress);

    expect(getUpdates('updateMessageSendFailed').map((update) => update.localId)).toEqual([local.id]);
    await vi.advanceTimersByTimeAsync(FAST_SEND_TIMEOUT * 2);
    expect(getUpdates('updateMessage')).toHaveLength(0);
  });

  it('keeps a string error for failures that have no RPC error message', async () => {
    const local = buildLocalMessage();
    mockedInvokeRequest.mockRejectedValue(new Error('Request was unsuccessful 5 time(s)'));

    await sendApiMessage({ chat, text: 'hello' }, local, onProgress);

    const failed = getUpdates('updateMessageSendFailed');
    expect(failed).toHaveLength(1);
    expect(typeof failed[0].error).toBe('string');
    expect(failed[0].error).toContain('Request was unsuccessful');
  });
});
