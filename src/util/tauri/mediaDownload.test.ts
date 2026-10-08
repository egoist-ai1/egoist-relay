import { beforeEach, describe, expect, test, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, callback: (event: { payload: unknown }) => void) => {
    bridge.listeners.set(name, callback);
    return Promise.resolve(() => {});
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  bridge.listeners.clear();
  bridge.invoke.mockReset();
});
const emit = (name: string, payload: unknown) => bridge.listeners.get(name)?.({ payload });

describe('Native download result bridge', () => {
  test('Anchor startup is pending until an exact native operation finishes', async () => {
    bridge.invoke.mockResolvedValue('id-a');
    const { prepareNativeMediaDownload } = await import('./mediaDownload');
    const task = await prepareNativeMediaDownload('blob:a', 'a.mp4');
    let completed = false;
    void task.completed.then(() => {
      completed = true;
    });
    emit('download-finished', { operationId: 'other', success: true });
    await Promise.resolve();
    expect(completed).toBe(false);
    emit('relay-media-download-started', { operationId: 'id-a' });
    await vi.advanceTimersByTimeAsync(180000);
    expect(completed).toBe(false);
    emit('download-finished', { operationId: 'id-a', success: true, path: 'C:/Downloads/a.mp4' });
    await expect(task.completed).resolves.toMatchObject({ success: true, path: 'C:/Downloads/a.mp4' });
    expect(bridge.invoke.mock.calls.filter(([command]) => command === 'relay_media_operation_action')).toHaveLength(0);
    vi.useRealTimers();
  });

  test('Native failure resolves as failure and missing start expires without claiming a saved file', async () => {
    bridge.invoke.mockResolvedValue('id-b');
    const { prepareNativeMediaDownload } = await import('./mediaDownload');
    const task = await prepareNativeMediaDownload('blob:b', 'b.jpg');
    await vi.advanceTimersByTimeAsync(125001);
    await expect(task.completed).resolves.toMatchObject({ success: false, error: 'MEDIA_DOWNLOAD_NOT_STARTED' });
    expect(bridge.invoke).toHaveBeenCalledWith(
      'relay_media_operation_action', { action: { type: 'cancel', id: 'id-b' } },
    );
    vi.useRealTimers();
  });

  test('Cancel releases a waiter even when the journal write fails', async () => {
    bridge.invoke.mockImplementation((command: string) => command === 'relay_media_download_prepare'
      ? Promise.resolve('id-c') : Promise.reject(new Error('MEDIA_JOURNAL_WRITE_FAILED')));
    const { prepareNativeMediaDownload } = await import('./mediaDownload');
    const task = await prepareNativeMediaDownload('blob:c', 'c.jpg');
    await expect(task.cancel()).rejects.toThrow('MEDIA_JOURNAL_WRITE_FAILED');
    await expect(task.completed).resolves.toMatchObject({ success: false, error: 'MEDIA_CANCELLED' });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
