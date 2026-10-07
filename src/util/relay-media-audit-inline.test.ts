// Fixtures model immediate promises at external API boundaries
/* eslint-disable @typescript-eslint/require-await */
import { beforeEach, describe, expect, test, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke,
}));
vi.mock('./browser/globalEnvironment', () => ({
  IS_TAURI: true,
}));
const source = {
  provider: 'x' as const, id: '1234567890123456789',
  canonicalUrl: 'https://x.com/i/status/1234567890123456789', isVertical: false,
};
function createPacket() {
  const header = new TextEncoder().encode(JSON.stringify({
    index: 0, size: 3, mimeType: 'video/mp4',
  }));
  const packet = new Uint8Array(8 + header.length + 3);
  packet.set([69, 82, 77, 83]);
  new DataView(packet.buffer).setUint32(4, header.length, true);
  packet.set(header, 8);
  packet.set([1, 2, 3], 8 + header.length);
  return packet.buffer;
}
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise, resolve,
  };
}
beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
});
describe('Relay inline original-file and preview queue stress', () => {
  test('100 mixed preview/save operations share one native lane and recover without dropped work', async () => {
    let active = 0;
    let peak = 0;
    const requestIds = new Set<string>();
    invoke.mockImplementation(async (command: string, input: {
      requestId: string;
    }) => {
      active++;
      peak = Math.max(peak, active);
      requestIds.add(input.requestId);
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
      active--;
      return command === 'relay_inline_resolve_media' ? createPacket() : {
        path: 'synthetic-original.mp4',
      };
    });
    const { default: resolveInlineMedia, saveInlineMedia } = await import('./resolveInlineMedia');
    const pending = Array.from({
      length: 100,
    }, (_, index) => index % 2
      ? saveInlineMedia(source, new AbortController().signal)
      : resolveInlineMedia(source, new AbortController().signal));
    const results = await Promise.all(pending);
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(requestIds.size).toBe(100);
    expect(invoke).toHaveBeenCalledTimes(100);
    expect(results.filter((result) => result instanceof Blob)).toHaveLength(50);
  });
  test('200 canceled queued saves never reach native IPC and do not block the next selected save', async () => {
    const firstNative = createDeferred<unknown>();
    let nativeCalls = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === 'relay_inline_cancel_media') {
        return undefined;
      }
      nativeCalls++;
      return nativeCalls === 1 ? firstNative.promise : {};
    });
    const { saveInlineMedia } = await import('./resolveInlineMedia');
    const first = saveInlineMedia(source, new AbortController().signal);
    await vi.waitFor(() => expect(nativeCalls).toBe(1));
    const controllers = Array.from({
      length: 200,
    }, () => new AbortController());
    const queued = controllers.map((controller) => saveInlineMedia(source, controller.signal));
    const rejected = Promise.allSettled(queued);
    for (const controller of controllers) {
      controller.abort();
    }
    const results = await rejected;
    expect(results.every((result) => result.status === 'rejected' && result.reason.name === 'AbortError')).toBe(true);
    expect(nativeCalls).toBe(1);
    const next = saveInlineMedia(source, new AbortController().signal);
    firstNative.resolve({});
    await first;
    await next;
    expect(nativeCalls).toBe(2);
  });
  test('A canceled native save keeps its lane until settlement even when cancel IPC fails', async () => {
    const firstNative = createDeferred<unknown>();
    let saves = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === 'relay_inline_cancel_media') {
        throw new Error('NATIVE_CANCEL_CHANNEL_CLOSED');
      }
      saves++;
      return saves === 1 ? firstNative.promise : {};
    });
    const { saveInlineMedia } = await import('./resolveInlineMedia');
    const controller = new AbortController();
    const first = saveInlineMedia(source, controller.signal);
    await vi.waitFor(() => expect(saves).toBe(1));
    const rejection = expect(first).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    await rejection;
    const next = saveInlineMedia(source, new AbortController().signal);
    await Promise.resolve();
    expect(saves).toBe(1);
    firstNative.resolve({});
    await next;
    expect(saves).toBe(2);
  });
  test('Disk failure is preserved and does not poison later original saves or previews', async () => {
    const diskError = new Error('MEDIA_DISK_FULL');
    invoke.mockRejectedValueOnce(diskError).mockImplementation(async (command: string) => (
      command === 'relay_inline_resolve_media' ? createPacket() : {}
    ));
    const { default: resolveInlineMedia, saveInlineMedia } = await import('./resolveInlineMedia');
    const save = saveInlineMedia(source, new AbortController().signal);
    const rejection = expect(save).rejects.toBe(diskError);
    const preview = resolveInlineMedia(source, new AbortController().signal);
    await rejection;
    expect((await preview).type).toBe('video/mp4');
    await saveInlineMedia(source, new AbortController().signal);
    expect(invoke).toHaveBeenCalledTimes(3);
  });
  test('Completed save detaches cancellation and leaves an active sibling request untouched', async () => {
    const pending = createDeferred<unknown>();
    invoke.mockResolvedValueOnce({}).mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const { saveInlineMedia } = await import('./resolveInlineMedia');
    const firstController = new AbortController();
    await saveInlineMedia(source, firstController.signal);
    const secondController = new AbortController();
    const second = saveInlineMedia(source, secondController.signal);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    firstController.abort();
    expect(invoke).toHaveBeenCalledTimes(2);
    const rejection = expect(second).rejects.toMatchObject({
      name: 'AbortError',
    });
    secondController.abort();
    await rejection;
    const secondRequest = invoke.mock.calls[1][1];
    expect(invoke).toHaveBeenLastCalledWith('relay_inline_cancel_media', {
      requestId: secondRequest.requestId,
    });
    pending.resolve({});
    await Promise.resolve();
  });
  test('1000 corrupted packet headers fail before creating media', async () => {
    const { parseInlineMediaPacket } = await import('./resolveInlineMedia');
    for (let index = 0; index < 1000; index++) {
      const packet = createPacket();
      const bytes = new Uint8Array(packet);
      if (index % 2) {
        bytes[index % 4] ^= 0xff;
      } else {
        new DataView(packet).setUint32(4, 1025 + index, true);
      }
      expect(() => parseInlineMediaPacket(packet)).toThrow('INLINE_MEDIA_INVALID_PACKET');
    }
  });
});
