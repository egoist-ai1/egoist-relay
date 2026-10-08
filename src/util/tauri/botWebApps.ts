import type { WebAppOutboundEvent } from '../../types/webapp';

import { IS_TAURI } from '../browser/globalEnvironment';
import { IS_WINDOWS } from '../browser/windowEnvironment';
import { resolveAppBounds } from './appBounds';
const MAX_PENDING_EVENTS = 64;
const NATIVE_EVENT = 'relay-mini-app-event';
type NativeFrameEvent = {
  id: string;
  kind: 'event' | 'loaded' | 'loading' | 'error' | 'escape';
  data?: string;
};
type FrameOptions = {
  isVisible: () => boolean;
  onMessage: (data: string) => void;
  onLoad: () => void;
  onError: () => void;
  onEscape: () => void;
  onDownloads: () => void;
};
export type NativeWebAppFrame = {
  sendEvent: (event: WebAppOutboundEvent) => void;
  reload: (url: string) => void;
  update: () => void;
  dispose: () => void;
};
export function shouldUseNativeWebApp(url?: string): boolean {
  if (!IS_TAURI || !IS_WINDOWS || !url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
export function isNativeFrameCovered(frame: HTMLIFrameElement): boolean {
  const owner = frame.closest('.Modal');
  if (!owner || owner.matches('.closing, .not-shown, .not-open')
    || document.querySelector('[data-relay-operations="true"]')) {
    return true;
  }
  const activeApp = document.documentElement.dataset.relayActiveApp;
  if (activeApp && activeApp !== 'telegram') {
    return true;
  }
  return Array.from(document.querySelectorAll('.Modal.open, dialog[open], .Menu .bubble.open')).some((element) => {
    if (element === owner || element.contains(frame)) {
      return false;
    }
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  });
}
export function createNativeWebAppFrame(
  frame: HTMLIFrameElement, url: string, options: FrameOptions,
): NativeWebAppFrame {
  const id = crypto.randomUUID();
  let isDisposed = false;
  let isCreated = false;
  let isLoaded = false;
  let hasLoadError = false;
  let lastGeometry = '';
  let scheduledFrame: number | undefined;
  let chain = Promise.resolve();
  let releaseEvents: NoneToVoidFunction | undefined;
  let releaseDownloads: NoneToVoidFunction | undefined;
  const pendingEvents: WebAppOutboundEvent[] = [];
  const reportError = () => {
    if (isDisposed || hasLoadError) {
      return;
    }
    hasLoadError = true;
    options.onError();
  };
  const getApi = () => import('@tauri-apps/api/core');
  const ready = initialize().catch(reportError);
  const resizeObserver = new ResizeObserver(scheduleUpdate);
  resizeObserver.observe(frame);
  const mutationObserver = new MutationObserver(scheduleUpdate);
  mutationObserver.observe(document.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'style', 'open', 'hidden'] });
  window.addEventListener('resize', scheduleUpdate);
  window.addEventListener('egoist-relay-service-change', scheduleUpdate);
  function queue(task: () => Promise<void>) {
    chain = chain.then(async () => {
      await ready;
      if (isDisposed || !isCreated) {
        return;
      }
      await task();
    }).catch(reportError);
  }
  async function getBounds() {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const currentWindow = getCurrentWindow();
    const [size, scale] = await Promise.all([currentWindow.innerSize(), currentWindow.scaleFactor()]);
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new Error('MINI_APP_INVALID_SCALE');
    }
    return resolveAppBounds(frame.getBoundingClientRect(),
      { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
      { width: size.width / scale, height: size.height / scale });
  }
  async function initialize() {
    const [{ invoke }, { listen }] = await Promise.all([getApi(), import('@tauri-apps/api/event')]);
    if (isDisposed) {
      return;
    }
    releaseEvents = await listen<NativeFrameEvent>(NATIVE_EVENT, ({ payload }) => {
      if (isDisposed || payload.id !== id) {
        return;
      }
      if (payload.kind === 'event' && typeof payload.data === 'string') {
        options.onMessage(payload.data);
      }
      if (payload.kind === 'escape' && options.isVisible() && !isNativeFrameCovered(frame)) {
        options.onEscape();
      }
      if (payload.kind === 'loading') {
        isLoaded = false;
        hasLoadError = false;
        scheduleUpdate();
      }
      if (payload.kind === 'loaded' || payload.kind === 'error') {
        isLoaded = true;
        if (payload.kind === 'error') {
          reportError();
        } else {
          options.onLoad();
        }
        pendingEvents.splice(0).forEach(sendEvent);
        scheduleUpdate();
      }
    });
    releaseDownloads = await listen('relay-media-toggle', () => {
      if (!isDisposed && options.isVisible() && !isNativeFrameCovered(frame)) {
        options.onDownloads();
      }
    });
    if (isDisposed) {
      releaseEvents();
      releaseDownloads();
      return;
    }
    // Inactive tabs can mount before their DOM frame has a measurable rectangle.
    let initialBounds;
    try {
      initialBounds = await getBounds();
    } catch {
      initialBounds = { x: 0, y: 0, width: 1, height: 1 };
    }
    await invoke('relay_mini_app_open', { id, url, bounds: initialBounds });
    isCreated = true;
    if (isDisposed) {
      await invoke('relay_mini_app_close', { id });
      isCreated = false;
      return;
    }
    pendingEvents.splice(0).forEach(sendEvent);
    scheduleUpdate();
  }
  function scheduleUpdate() {
    if (isDisposed || scheduledFrame !== undefined) {
      return;
    }
    scheduledFrame = requestAnimationFrame(() => {
      scheduledFrame = undefined;
      if (options.isVisible() && document.querySelector('[data-relay-operations="true"]')) options.onDownloads();
      queue(async () => {
        let visible = isLoaded && options.isVisible() && !isNativeFrameCovered(frame);
        const bounds = visible ? await getBounds() : undefined;
        visible = visible && options.isVisible() && !isNativeFrameCovered(frame);
        const geometry = JSON.stringify({ bounds: visible ? bounds : undefined, visible });
        if (geometry === lastGeometry || isDisposed) {
          return;
        }
        const { invoke } = await getApi();
        await invoke('relay_mini_app_update', { id, bounds: visible ? bounds : undefined, visible });
        lastGeometry = geometry;
      });
    });
  }
  function sendEvent(event: WebAppOutboundEvent) {
    if (isDisposed) {
      return;
    }
    if (!isCreated || !isLoaded) {
      if (pendingEvents.length < MAX_PENDING_EVENTS) {
        pendingEvents.push(event);
      }
      return;
    }
    queue(async () => {
      const { invoke } = await getApi();
      await invoke('relay_mini_app_send', { id, event });
    });
  }
  function reload(nextUrl: string) {
    hasLoadError = false;
    isLoaded = false;
    pendingEvents.splice(0);
    scheduleUpdate();
    queue(async () => {
      const { invoke } = await getApi();
      await invoke('relay_mini_app_reload', { id, url: nextUrl });
    });
  }
  function dispose() {
    if (isDisposed) {
      return;
    }
    isDisposed = true;
    pendingEvents.splice(0);
    if (scheduledFrame !== undefined) {
      cancelAnimationFrame(scheduledFrame);
    }
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    window.removeEventListener('resize', scheduleUpdate);
    window.removeEventListener('egoist-relay-service-change', scheduleUpdate);
    releaseEvents?.();
    releaseDownloads?.();
    void ready.then(async () => {
      if (!isCreated) {
        return;
      }
      const { invoke } = await getApi();
      await invoke('relay_mini_app_close', { id });
    }).catch(() => {
    });
  }
  return { sendEvent, reload, update: scheduleUpdate, dispose };
}
