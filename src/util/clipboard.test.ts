import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const writeClipboard = vi.fn();
const drawImage = vi.fn();
let imageResult = 'load';
let shouldEncode = true;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  imageResult = 'load';
  shouldEncode = true;
  writeClipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: writeClipboard } });
  vi.stubGlobal('ClipboardItem', class {
    constructor(public data: Record<string, Blob | Promise<Blob>>) {}
  });
  vi.stubGlobal('Image', class {
    naturalWidth = 12;
    naturalHeight = 8;
    width = 12;
    height = 8;
    onload?: (event: { currentTarget: unknown }) => void;
    onerror?: () => void;

    removeAttribute() {}

    set src(value: string) {
      if (!value || imageResult === 'pending') return;
      queueMicrotask(() => {
        if (imageResult === 'error') this.onerror?.();
        else this.onload?.({ currentTarget: this });
      });
    }
  });
  const context = { drawImage } satisfies Pick<CanvasRenderingContext2D, 'drawImage'>;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    // eslint-disable-next-line no-null/no-null
    callback(shouldEncode ? new Blob(['png'], { type: 'image/png' }) : null);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Image clipboard result', () => {
  test('Waits for the PNG write before reporting success', async () => {
    let finishWrite: () => void = () => {};
    writeClipboard.mockReturnValue(new Promise<void>((resolve) => {
      finishWrite = resolve;
    }));
    const { copyImageToClipboard } = await import('./clipboard');
    const result = copyImageToClipboard('blob:test-image');
    expect(result).toBeInstanceOf(Promise);
    let hasSettled = false;
    void Promise.resolve(result).then(() => {
      hasSettled = true;
    });
    await vi.waitFor(() => expect(writeClipboard).toHaveBeenCalledOnce());
    expect(hasSettled).toBe(false);
    finishWrite();
    expect(await result).toBe(true);
  });

  test.each(['error', 'encode', 'denied', 'unsupported'])('Returns failure for %s', async (failure) => {
    if (failure === 'error') imageResult = 'error';
    if (failure === 'encode') shouldEncode = false;
    if (failure === 'denied') writeClipboard.mockRejectedValue(new Error('Permission denied'));
    if (failure === 'unsupported') Object.defineProperty(navigator, 'clipboard', { value: undefined });
    const { copyImageToClipboard } = await import('./clipboard');
    expect(await copyImageToClipboard('blob:test-image')).toBe(false);
  });

  test('Returns failure for missing media', async () => {
    const { copyImageToClipboard } = await import('./clipboard');
    expect(await copyImageToClipboard()).toBe(false);
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  test('Starts the clipboard write before awaiting downloaded image data', async () => {
    let finishDownload: (url: string) => void = () => {};
    const source = new Promise<string>((resolve) => {
      finishDownload = resolve;
    });
    const { copyImageToClipboard } = await import('./clipboard');
    const result = copyImageToClipboard(source);
    expect(writeClipboard).toHaveBeenCalledOnce();
    finishDownload('blob:test-image');
    expect(await result).toBe(true);
  });

  test('Bounds a stalled image request', async () => {
    vi.useFakeTimers();
    imageResult = 'pending';
    const { copyImageToClipboard } = await import('./clipboard');
    const result = copyImageToClipboard(new Promise<string>(() => {}));
    await vi.advanceTimersByTimeAsync(15000);
    expect(await result).toBe(false);
  });
});
