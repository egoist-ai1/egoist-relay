import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ApiAttachment } from '../../api/types';

const { callApi, invoke, buildAttachment, state } = vi.hoisted(() => ({
  callApi: vi.fn(), invoke: vi.fn(), buildAttachment: vi.fn(), state: { config: { maxMessageLength: 4096 } },
}));
vi.mock('../../global', () => ({ getGlobal: () => state }));
vi.mock('../../lib/teact/teactn', () => ({ addCallback: vi.fn(), removeCallback: vi.fn() }));
vi.mock('../../global/actions/api/messages', () => ({ getPeerStarsForMessage: vi.fn() }));
vi.mock('../../global/helpers', () => ({
  getAllowedAttachmentOptions: () => ({
    canSendPlainText: true, canAttachMedia: true, canSendDocuments: true, canSendPhotos: true, canSendVideos: true,
  }),
  getCanPostInChat: () => true, isDeletedUser: () => false, isSystemBot: () => false,
}));
vi.mock('../../global/selectors', () => ({
  selectChat: () => ({ id: '123' }), selectChatFullInfo: () => undefined, selectIsChatRestricted: () => false,
  selectTopic: () => undefined, selectUser: () => undefined,
}));
vi.mock('../../api/gramjs', () => ({ callApi }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../middle/composer/helpers/buildAttachment', () => ({ default: buildAttachment }));

import {
  createSocialShareJob, getSocialShareTextParts, isSocialShareRequest, parseSocialMediaPacket,
  resolveSocialShareMedia, sendSocialShareJob,
} from './socialShare';

const request = {
  requestId: '11111111-1111-4111-8111-111111111111', service: 'x' as const,
  url: 'https://x.com/i/status/1234567890123456789', text: 'Test post',
};

function buildPacket(overrides: Record<string, unknown> = {}): ArrayBuffer {
  const header = new TextEncoder().encode(JSON.stringify({
    index: 0, size: 3, name: 'relay-x-1.jpg', mimeType: 'image/jpeg', ...overrides,
  }));
  const packet = new Uint8Array(8 + header.length + 3);
  packet.set([69, 82, 77, 83]);
  new DataView(packet.buffer).setUint32(4, header.length, true);
  packet.set(header, 8);
  packet.set([1, 2, 3], 8 + header.length);
  return packet.buffer;
}

function buildTestAttachment(): ApiAttachment {
  return {
    blob: new Blob(['test']), blobUrl: 'blob:test-original', compressedBlobUrl: 'blob:test-compressed',
    previewBlobUrl: 'blob:test-preview', filename: 'test.jpg', mimeType: 'image/jpeg', size: 4, uniqueId: 'test',
  };
}

beforeEach(() => {
  callApi.mockReset();
  invoke.mockReset();
  buildAttachment.mockReset();
  state.config.maxMessageLength = 4096;
  URL.revokeObjectURL = vi.fn();
});

describe('Social share payloads', () => {
  test('Accepts native share requests from www.x.com and rejects unrelated paths', () => {
    expect(isSocialShareRequest({ ...request, url: 'https://www.x.com/name/status/1234567890123456789' })).toBe(true);
    expect(isSocialShareRequest({ ...request, url: 'https://x.com/settings' })).toBe(false);
  });

  test.each([
    { mimeType: 'image/svg+xml' }, { name: '../../test.jpg' }, { name: '' }, { size: 4 }, { index: 1 },
  ])('Rejects untrusted media header %o', (header) => {
    expect(() => parseSocialMediaPacket(buildPacket(header), 0)).toThrow('SOCIAL_SHARE_INVALID_MEDIA');
  });

  test('Releases all attachment URLs when preparation is canceled after decoding', async () => {
    let isCanceled = false;
    invoke.mockResolvedValue(buildPacket());
    buildAttachment.mockImplementation(() => {
      isCanceled = true;
      return Promise.resolve(buildTestAttachment());
    });
    const resolution = resolveSocialShareMedia(
      { ...request, media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/test.jpg' }] },
      () => isCanceled, () => {},
    );
    await expect(resolution).rejects.toThrow('SOCIAL_SHARE_CANCELED');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-original');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-compressed');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-preview');
  });

  test('Splits long Unicode text without breaking a surrogate pair', () => {
    state.config.maxMessageLength = 3;
    const parts = getSocialShareTextParts({ ...request, text: 'a😀b' });
    expect(parts.join('')).toBe(`a😀b\n\n${request.url}`);
    expect(parts.every((part) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part))).toBe(true);
  });
});

describe('Social share retries', () => {
  test('Reuses the failed item identity and skips already confirmed messages', async () => {
    const job = createSocialShareJob(request, { peerId: '123' }, [buildTestAttachment()]);
    let sends = 0;
    const identities: string[] = [];
    callApi.mockImplementation((method: string, parameters: { socialShareRandomId: string }) => {
      if (method === 'sendMessageLocal') return Promise.resolve({ id: -1 });
      sends++;
      identities.push(parameters.socialShareRandomId);
      if (sends === 2) return Promise.reject(new Error('SYNTHETIC_FAILURE'));
      return Promise.resolve(true);
    });
    await expect(sendSocialShareJob(job, 0, () => {})).rejects.toThrow('SYNTHETIC_FAILURE');
    expect(job.confirmed).toBe(1);
    expect(job.busy).toBe(false);
    await sendSocialShareJob(job, 0, () => {});
    expect(job.confirmed).toBe(2);
    expect(identities).toEqual([job.items[0].randomId, job.items[1].randomId, job.items[1].randomId]);
    expect(callApi.mock.calls.filter(([method]) => method === 'sendMessageLocal')).toHaveLength(2);
  });

  test('Rejects a second send while the same job is already in progress', async () => {
    const job = createSocialShareJob(request, { peerId: '123' }, []);
    job.busy = true;
    await expect(sendSocialShareJob(job, 0, () => {})).rejects.toThrow('SOCIAL_SHARE_BUSY');
    expect(callApi).not.toHaveBeenCalled();
  });
});
