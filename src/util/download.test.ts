import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Download scheduling', () => {
  test('Schedules a download enqueued as the previous batch settles', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { default: download } = await import('./download');
    const downloaded: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloaded.push(this.download);
      if (this.download === 'first.png') void Promise.resolve().then(() => download('blob:second', 'second.png'));
    });
    download('blob:first', 'first.png');
    await vi.runAllTimersAsync();
    expect(downloaded).toEqual(['first.png', 'second.png']);
  });

  test('Limits each interval to ten save requests', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { default: download } = await import('./download');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    for (let index = 0; index < 12; index++) download(`blob:file-${index}`, `${index}.png`);
    await vi.advanceTimersByTimeAsync(1000);
    expect(click).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(click).toHaveBeenCalledTimes(12);
  });

  test('Skips a canceled request before its queued save starts', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { default: download } = await import('./download');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let isCanceled = false;
    const result = download('blob:canceled', 'canceled.png', () => isCanceled);
    isCanceled = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });

  test('Settles only when the save link is invoked', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { default: download } = await import('./download');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let didSettle = false;
    const result = download('blob:saved', 'saved.png').then((didStart) => {
      didSettle = true;
      return didStart;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(didSettle).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  });
});
