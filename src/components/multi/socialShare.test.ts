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
  resolveSocialShareMedia, saveSocialShareMedia, sendSocialShareJob,
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

  test('Rejects Instagram share requests in every form', () => {
    const reel = 'https://www.instagram.com/reel/AbCdE12345/';
    expect(isSocialShareRequest({ ...request, service: 'instagram', url: reel })).toBe(false);
    expect(isSocialShareRequest({ ...request, service: 'instagram', url: 'https://www.instagram.com/p/AbCdE12345/' }))
      .toBe(false);
    expect(isSocialShareRequest({ ...request, url: reel })).toBe(false);
    expect(isSocialShareRequest({ ...request, service: 'instagram' })).toBe(false);
    expect(isSocialShareRequest(request)).toBe(true);
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

describe('Application-owned media operations', () => {
  test('Returns every published file for later access', async () => {
    const files = [
      { path: 'C:/Downloads/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg', size: 3 },
      { path: 'C:/Downloads/b.jpg', fileName: 'b.jpg', mimeType: 'image/jpeg', size: 4 },
    ];
    invoke.mockResolvedValueOnce(files[0]).mockResolvedValueOnce(files[1]);
    await expect(saveSocialShareMedia({ ...request, media: [
      { type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' },
      { type: 'photo', url: 'https://pbs.twimg.com/media/b.jpg' },
    ] }, () => false, () => {})).resolves.toEqual(files);
  });

  test('File mode keeps the fetched blob and selects document transport', () => {
    const original = buildTestAttachment();
    const job = createSocialShareJob(request, { peerId: '123' }, [original], 'file');
    expect(job.items[1].attachment?.shouldSendAsFile).toBe(true);
    expect(job.items[1].attachment?.blob).toBe(original.blob);
    expect(job.items[1].attachment?.blobUrl).toBe('blob:test-original');
    expect(original.shouldSendAsFile).toBeUndefined();
  });

  test('Cancel stops remaining messages without undoing a confirmed one', async () => {
    const job = createSocialShareJob(request, { peerId: '123' }, [buildTestAttachment()]);
    let canceled = false;
    const confirmed = vi.fn(() => {
      canceled = true;
      return Promise.resolve();
    });
    callApi.mockImplementation((method: string) => Promise.resolve(method === 'sendMessageLocal' ? { id: -1 } : true));
    await expect(sendSocialShareJob(job, 0, () => {}, {
      isCanceled: () => canceled, onConfirmed: confirmed,
    })).rejects.toThrow('SOCIAL_SHARE_CANCELED');
    expect(job.confirmed).toBe(1);
    expect(callApi.mock.calls.filter(([method]) => method === 'sendMessage')).toHaveLength(1);
  });

  test('Persists intent before dispatch and confirmation after acknowledgement', async () => {
    const events: string[] = [];
    const job = createSocialShareJob(request, { peerId: '123' }, []);
    callApi.mockImplementation((method: string) => {
      events.push(method);
      return Promise.resolve(method === 'sendMessageLocal' ? { id: -1 } : true);
    });
    await sendSocialShareJob(job, 0, () => {}, {
      onBeforeSend: () => {
        events.push('intent');
        return Promise.resolve();
      },
      onConfirmed: () => {
        events.push('confirmed');
        return Promise.resolve();
      },
    });
    expect(events).toEqual(['intent', 'sendMessageLocal', 'sendMessage', 'confirmed']);
  });
});

test('Lock or account change while local preparation is pending prevents network dispatch', async () => {
  const job = createSocialShareJob(request, { peerId: '123' }, []);
  let canceled = false;
  callApi.mockImplementation((method: string) => {
    if (method === 'sendMessageLocal') {
      canceled = true;
      return Promise.resolve({ id: -1 });
    }
    return Promise.resolve(true);
  });
  await expect(sendSocialShareJob(job, 0, () => {}, { isCanceled: () => canceled }))
    .rejects.toThrow('SOCIAL_SHARE_CANCELED');
  expect(callApi.mock.calls.filter(([method]) => method === 'sendMessage')).toHaveLength(0);
});
