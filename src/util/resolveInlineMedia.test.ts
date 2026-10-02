import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('./browser/globalEnvironment', () => ({ IS_TAURI: true }));

function buildPacket(mimeType = 'video/mp4'): ArrayBuffer {
  const header = new TextEncoder().encode(JSON.stringify({ index: 0, size: 3, mimeType }));
  const packet = new Uint8Array(8 + header.length + 3);
  packet.set([69, 82, 77, 83]);
  new DataView(packet.buffer).setUint32(4, header.length, true);
  packet.set(header, 8);
  packet.set([1, 2, 3], 8 + header.length);
  return packet.buffer;
}

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('Inline media cancellation', () => {
  test('Rejects the canceled caller immediately and waits for its IPC before starting another', async () => {
    let settleFirst: (packet: ArrayBuffer) => void = () => {};
    const firstPacket = new Promise<ArrayBuffer>((resolve) => {
      settleFirst = resolve;
    });
    let reads = 0;
    invoke.mockImplementation((command: string) => {
      if (command === 'relay_inline_cancel_media') return Promise.resolve();
      reads++;
      return reads === 1 ? firstPacket : Promise.resolve(buildPacket());
    });
    const { default: resolveInlineMedia } = await import('./resolveInlineMedia');
    const source = {
      provider: 'x' as const, id: '1234567890123456789',
      canonicalUrl: 'https://x.com/i/status/1234567890123456789', isVertical: false,
    };
    const controller = new AbortController();
    const first = resolveInlineMedia(source, controller.signal);
    await vi.waitFor(() => expect(reads).toBe(1));
    const canceled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await canceled;
    expect(invoke).toHaveBeenCalledWith('relay_inline_cancel_media', { requestId: expect.any(String) });
    const second = resolveInlineMedia(source, new AbortController().signal);
    await Promise.resolve();
    expect(reads).toBe(1);
    settleFirst(buildPacket());
    expect((await second).type).toBe('video/mp4');
    expect(reads).toBe(2);
  });

  test('Does not start native work for an already canceled request', async () => {
    const { default: resolveInlineMedia } = await import('./resolveInlineMedia');
    const source = {
      provider: 'youtube' as const, id: 'abcdefghijk',
      canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk', isVertical: false,
    };
    const controller = new AbortController();
    controller.abort();
    await expect(resolveInlineMedia(source, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('Rejects image packets and truncated packet headers', async () => {
    const { parseInlineMediaPacket } = await import('./resolveInlineMedia');
    expect(() => parseInlineMediaPacket(buildPacket('image/jpeg'))).toThrow('INLINE_MEDIA_INVALID_PACKET');
    expect(() => parseInlineMediaPacket(buildPacket().slice(0, 8))).toThrow('INLINE_MEDIA_INVALID_PACKET');
  });
});
