import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from '../../../lib/teact/teact';
import TeactDOM from '../../../lib/teact/teact-dom';

import type { InlineSocialMediaSource } from '../../../util/inlineSocialMedia';

import { requestMutation } from '../../../lib/fasterdom/fasterdom';
import resolveInlineMedia from '../../../util/resolveInlineMedia';

import InlineSocialMedia, { stopInlineSocialMedia } from './InlineSocialMedia';

vi.mock('../../../util/resolveInlineMedia', () => ({ default: vi.fn() }));
vi.mock('../../../hooks/useLang', async () => {
  const { default: fallback } = await import('../../../assets/localization/fallback.strings?raw');
  const strings: Record<string, string> = {};
  for (const match of fallback.matchAll(/^"([^"\n]+)"\s*=\s*("(?:[^"\\]|\\.)*");/gm)) {
    try {
      strings[match[1]] = JSON.parse(match[2]);
    } catch { /* Unused non-JSON Telegram entries */ }
  }
  return {
    default: () => (key: string, values: Record<string, string> = {}) => (strings[key] || key)
      .replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? name),
  };
});

const YOUTUBE_SOURCE: InlineSocialMediaSource = {
  provider: 'youtube', id: 'M7lc1UVf-VE', canonicalUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE', isVertical: true,
};
const YOUTUBE_ORIGIN = 'https://www.youtube-nocookie.com';
const resolveMedia = vi.mocked(resolveInlineMedia);
const visibilityObservers = new Map<Element, IntersectionObserverCallback>();
const DENIAL_MESSAGES = {
  MEDIA_AUTH_REQUIRED: 'Видео требует входа в YouTube или недоступно публично.',
  MEDIA_BOT_CHECK: 'Сервис запрашивает проверку. Откройте видео на его сайте и пройдите её.',
  MEDIA_GEO_BLOCKED: 'Видео недоступно в вашем регионе.',
  MEDIA_RATE_LIMITED: 'Сервис временно ограничил запросы. Повторите позже.',
  MEDIA_HTTP_FORBIDDEN: 'Сервис отклонил запрос. Попробуйте открыть видео на его сайте.',
};

let container: HTMLElement;
let extraContainer: HTMLElement | undefined;

function renderPlayer(props: Partial<Parameters<typeof InlineSocialMedia>[0]> = {}, target = container) {
  return new Promise<void>((resolve) => {
    requestMutation(() => {
      TeactDOM.render(createElement(InlineSocialMedia, {
        source: YOUTUBE_SOURCE, canAutoLoad: true, ...props,
      }), target);
      resolve();
    });
  });
}

function getPlayer(target = container) {
  return target.querySelector<HTMLElement>('[data-inline-media-provider]')!;
}

async function setVisible(isVisible: boolean, target = container) {
  await vi.waitFor(() => expect(visibilityObservers.has(getPlayer(target))).toBe(true));
  visibilityObservers.get(getPlayer(target))!([{
    isIntersecting: isVisible, intersectionRatio: isVisible ? 1 : 0,
  } as IntersectionObserverEntry], {} as IntersectionObserver);
}

async function startEmbed(props: Partial<Parameters<typeof InlineSocialMedia>[0]> = {}, target = container) {
  await renderPlayer(props, target);
  await setVisible(true, target);
  await vi.waitFor(() => expect(getPlayer(target).dataset.inlineMediaMode).toBe('embed'));
  return target.querySelector<HTMLIFrameElement>('iframe')!;
}

async function sendProviderMessage(frame: HTMLIFrameElement, event: string, info?: number) {
  await new Promise<void>((resolve) => requestMutation(resolve));
  window.dispatchEvent(new MessageEvent('message', {
    origin: YOUTUBE_ORIGIN, source: frame.contentWindow!, data: JSON.stringify({ event, info }),
  }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  document.documentElement.dataset.relayActiveApp = 'telegram';
  resolveMedia.mockReset();
  resolveMedia.mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal('IntersectionObserver', class {
    callback: IntersectionObserverCallback;

    targets = new Set<Element>();

    constructor(callback: IntersectionObserverCallback) { this.callback = callback; }

    observe(target: Element) {
      this.targets.add(target);
      visibilityObservers.set(target, this.callback);
    }

    disconnect() {
      this.targets.forEach((target) => visibilityObservers.delete(target));
    }
  });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:relay-test');

    static revokeObjectURL = vi.fn();
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    requestMutation(() => {
      TeactDOM.render(undefined, container);
      container.remove();
      if (extraContainer) {
        TeactDOM.render(undefined, extraContainer);
        extraContainer.remove();
        extraContainer = undefined;
      }
      resolve();
    });
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.relayActiveApp;
});

describe('InlineSocialMedia YouTube recovery', () => {
  test.each([5, 153])('Automatically tries native playback once after recoverable embed error %s', async (code) => {
    const frame = await startEmbed();
    await sendProviderMessage(frame, 'onError', code);
    await vi.waitFor(() => expect(resolveMedia).toHaveBeenCalledTimes(1));
    expect(getPlayer().dataset.inlineMediaMode).toBe('native');
    expect(getPlayer().dataset.inlineMediaState).toBe('loading');
    await sendProviderMessage(frame, 'onError', code);
    await sendProviderMessage(frame, 'onReady');
    await renderPlayer();
    expect(resolveMedia).toHaveBeenCalledTimes(1);
    expect(getPlayer().dataset.inlineMediaState).toBe('loading');
  });

  test('Falls back after an iframe network error', async () => {
    const frame = await startEmbed();
    frame.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(resolveMedia).toHaveBeenCalledTimes(1));
    expect(getPlayer().dataset.inlineMediaMode).toBe('native');
  });

  test('Falls back on the load timeout without enabling autoplay', async () => {
    let handleTimeout: (() => void) | undefined;
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
      if (timeout === 20000 && typeof handler === 'function') handleTimeout = () => handler();
      return originalSetTimeout(handler, timeout, ...args);
    });
    resolveMedia.mockResolvedValue(new Blob(['video'], { type: 'video/mp4' }));
    await startEmbed();
    await vi.waitFor(() => expect(handleTimeout).toBeDefined());
    handleTimeout!();
    await vi.waitFor(() => expect(container.querySelector('video')).toBeInstanceOf(HTMLVideoElement));
    container.querySelector('video')!.dispatchEvent(new Event('canplay'));
    await vi.waitFor(() => expect(getPlayer().dataset.inlineMediaState).toBe('ready'));
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(resolveMedia).toHaveBeenCalledTimes(1);
  });

  test.each([
    [100, 'MEDIA_UNAVAILABLE', 'Видео пока недоступно.'],
    [101, 'MEDIA_EMBED_DENIED', 'Автор запретил воспроизведение в чате. Откройте видео в YouTube.'],
    [150, 'MEDIA_EMBED_DENIED', 'Автор запретил воспроизведение в чате. Откройте видео в YouTube.'],
  ])('Preserves provider restriction %s without trying native playback', async (code, error, message) => {
    const frame = await startEmbed();
    await sendProviderMessage(frame, 'onError', Number(code));
    await vi.waitFor(() => expect(getPlayer().dataset.inlineMediaState).toBe('error'));
    expect(getPlayer().dataset.inlineMediaError).toBe(error);
    expect(container.querySelector('[role="status"]')!.textContent).toBe(message);
    expect(resolveMedia).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('button[aria-label="Повторить"]')!.click();
    await vi.waitFor(() => expect(container.querySelector('iframe')).toBeInstanceOf(HTMLIFrameElement));
    expect(getPlayer().dataset.inlineMediaMode).toBe('embed');
    expect(resolveMedia).not.toHaveBeenCalled();
  });

  test.each(Object.entries(DENIAL_MESSAGES))(
    'Displays native denial %s and retries the official embed', async (code, message) => {
      resolveMedia.mockRejectedValue(new Error(code));
      const frame = await startEmbed();
      await sendProviderMessage(frame, 'onError', 5);
      await vi.waitFor(() => expect(getPlayer().dataset.inlineMediaError).toBe(code));
      expect(container.querySelector('[role="status"]')!.textContent).toBe(message);
      expect(resolveMedia).toHaveBeenCalledTimes(1);
      container.querySelector<HTMLButtonElement>('button[aria-label="Повторить"]')!.click();
      await vi.waitFor(() => expect(getPlayer().dataset.inlineMediaMode).toBe('embed'));
      expect(getPlayer().dataset.inlineMediaState).toBe('loading');
      expect(getPlayer().dataset.inlineMediaError).toBeUndefined();
      expect(resolveMedia).toHaveBeenCalledTimes(1);
      const nextFrame = container.querySelector<HTMLIFrameElement>('iframe')!;
      await sendProviderMessage(nextFrame, 'onError', 153);
      await vi.waitFor(() => expect(resolveMedia).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(getPlayer().dataset.inlineMediaError).toBe(code));
      expect(resolveMedia).toHaveBeenCalledTimes(2);
    },
  );

  test('Ends recovery when native video playback fails without cycling back to the embed', async () => {
    resolveMedia.mockResolvedValue(new Blob(['video'], { type: 'video/mp4' }));
    const frame = await startEmbed();
    await sendProviderMessage(frame, 'onError', 5);
    await vi.waitFor(() => expect(container.querySelector('video')).toBeInstanceOf(HTMLVideoElement));
    container.querySelector('video')!.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(getPlayer().dataset.inlineMediaState).toBe('error'));
    expect(getPlayer().dataset.inlineMediaError).toBe('MEDIA_PLAYBACK_FAILED');
    expect(container.querySelector('[role="status"]')!.textContent)
      .toBe('Плеер не смог воспроизвести видео. Повторите загрузку.');
    expect(resolveMedia).toHaveBeenCalledTimes(1);
    expect(container.querySelector('iframe')).toBeNull();
  });

  test('Keeps reduced motion through native recovery', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    resolveMedia.mockResolvedValue(new Blob(['video'], { type: 'video/mp4' }));
    const frame = await startEmbed({ canAutoPlay: true });
    expect(new URL(frame.src).searchParams.get('autoplay')).toBe('0');
    await sendProviderMessage(frame, 'onError', 5);
    await vi.waitFor(() => expect(container.querySelector('video')).toBeInstanceOf(HTMLVideoElement));
    container.querySelector('video')!.dispatchEvent(new Event('canplay'));
    await vi.waitFor(() => expect(getPlayer().dataset.inlineMediaState).toBe('ready'));
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  test.each(['viewport', 'background', 'service', 'message-list'])(
    'Cancels native recovery when the %s becomes inactive and ignores its late result', async (boundary) => {
      let settleNative: (blob: Blob) => void = () => {};
      resolveMedia.mockImplementation(() => new Promise((resolve) => {
        settleNative = resolve;
      }));
      const frame = await startEmbed();
      await sendProviderMessage(frame, 'onError', 5);
      await vi.waitFor(() => expect(resolveMedia).toHaveBeenCalledTimes(1));
      const signal = resolveMedia.mock.calls[0][1];
      if (boundary === 'viewport') await setVisible(false);
      if (boundary === 'background') {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
      }
      if (boundary === 'service') {
        document.documentElement.dataset.relayActiveApp = 'x';
        window.dispatchEvent(new Event('egoist-relay-service-change'));
      }
      if (boundary === 'message-list') await renderPlayer({ isMessageListActive: false });
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      settleNative(new Blob(['video'], { type: 'video/mp4' }));
      await renderPlayer({ isMessageListActive: boundary === 'message-list' ? false : undefined });
      expect(container.querySelector('video')).toBeNull();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      expect(resolveMedia).toHaveBeenCalledTimes(1);
    },
  );

  test('Does not interrupt the active player for a passive preview recovery', async () => {
    const activeFrame = await startEmbed({ canAutoPlay: true });
    await sendProviderMessage(activeFrame, 'onReady');
    await sendProviderMessage(activeFrame, 'onStateChange', 1);
    await vi.waitFor(() => expect(getPlayer().dataset.inlineMediaState).toBe('playing'));
    extraContainer = document.createElement('div');
    document.body.append(extraContainer);
    const passiveFrame = await startEmbed({}, extraContainer);
    await sendProviderMessage(passiveFrame, 'onError', 5);
    await vi.waitFor(() => expect(getPlayer(extraContainer).dataset.inlineMediaState).toBe('error'));
    expect(getPlayer().dataset.inlineMediaState).toBe('playing');
    expect(container.querySelector('iframe')).toBe(activeFrame);
    expect(resolveMedia).not.toHaveBeenCalled();
    extraContainer.querySelector<HTMLButtonElement>('button[aria-label="Повторить"]')!.click();
    await vi.waitFor(() => expect(getPlayer(extraContainer).dataset.inlineMediaState).toBe('loading'));
    expect(getPlayer().dataset.inlineMediaState).toBe('idle');
  });

  test('Loads only after an explicit request when autoload is disabled and stops a pending recovery', async () => {
    await renderPlayer({ canAutoLoad: false, canAutoPlay: false });
    await setVisible(true);
    await renderPlayer({ canAutoLoad: false, canAutoPlay: false });
    expect(getPlayer().dataset.inlineMediaState).toBe('idle');
    expect(container.querySelector('iframe')).toBeNull();
    container.querySelector<HTMLButtonElement>('button[aria-label="Встроенный плеер YouTube"]')!.click();
    await vi.waitFor(() => expect(getPlayer().dataset.inlineMediaMode).toBe('embed'));
    await sendProviderMessage(container.querySelector('iframe')!, 'onError', 5);
    await vi.waitFor(() => expect(resolveMedia).toHaveBeenCalledTimes(1));
    stopInlineSocialMedia();
    await vi.waitFor(() => expect(resolveMedia.mock.calls[0][1].aborted).toBe(true));
    expect(container.querySelector('video')).toBeNull();
  });

  test('Keeps a healthy embed ready after autoplay is blocked', async () => {
    const frame = await startEmbed({ canAutoPlay: true });
    await sendProviderMessage(frame, 'onReady');
    await sendProviderMessage(frame, 'onAutoplayBlocked');
    await vi.waitFor(() => expect(getPlayer().dataset.inlineMediaState).toBe('ready'));
    expect(container.querySelector('iframe')).toBe(frame);
    expect(resolveMedia).not.toHaveBeenCalled();
  });
});
