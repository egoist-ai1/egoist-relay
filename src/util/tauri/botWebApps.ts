import type { WebAppOutboundEvent } from '../../types/webapp';

import { IS_TAURI } from '../browser/globalEnvironment';
import { IS_WINDOWS } from '../browser/windowEnvironment';
import { resolveAppBounds } from './appBounds';
const MAX_PENDING_EVENTS = 64;
const LOAD_TIMEOUT = 30_000;
const NATIVE_EVENT = 'relay-mini-app-event';
const LOAD_FAILURES = ['network', 'timeout', 'server', 'access', 'certificate', 'redirect', 'process'] as const;
export type NativeWebAppLoadFailure = typeof LOAD_FAILURES[number] | 'unknown';

type NativeFrameEvent = {
  id: string;
  kind: 'event' | 'loaded' | 'loading' | 'error' | 'escape' | 'popup_error';
  data?: string;
};
type FrameOptions = {
  isVisible: () => boolean;
  onMessage: (data: string) => void;
  onLoad: () => void;
  onLoading?: () => void;
  onError: (failure: NativeWebAppLoadFailure) => void;
  onPopupError?: () => void;
  onEscape: () => void;
  onDownloads: () => void;
};
export type NativeWebAppFrame = {
  sendEvent: (event: WebAppOutboundEvent) => void;
  reload: (url: string) => void;
  update: () => void;
  dispose: () => void;
};

const OVERLAY_SELECTOR = '.Modal, dialog, .Menu, .bubble, [data-relay-operations]';
const HIDDEN_INITIAL_BOUNDS = { x: 0, y: 0, width: 1, height: 1 };
const WORKSPACE_VISIBILITY_EVENT = 'egoist-relay-workspace-visibility';

async function getWindowViewport() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const currentWindow = getCurrentWindow();
  const [size, scale] = await Promise.all([currentWindow.innerSize(), currentWindow.scaleFactor()]);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('MINI_APP_INVALID_SCALE');
  return { width: size.width / scale, height: size.height / scale };
}

type LayoutObserver = {
  needsLayout: () => boolean;
  update: (getViewport: typeof getWindowViewport) => void;
};

const observedFrames = new Map<HTMLIFrameElement, LayoutObserver>();
let releaseLayoutWatch: (() => void) | undefined;
let sharedResizeObserver: ResizeObserver | undefined;
let scheduledLayout: number | undefined;
let nativeViewportGeneration = 0;

function scheduleLayout() {
  if (scheduledLayout !== undefined || !Array.from(observedFrames.values()).some((item) => item.needsLayout())) return;
  scheduledLayout = requestAnimationFrame(() => {
    scheduledLayout = undefined;
    let viewport: ReturnType<typeof getWindowViewport> | undefined;
    const readViewport = () => {
      viewport ||= getWindowViewport();
      return viewport;
    };
    for (const item of observedFrames.values()) {
      if (item.needsLayout()) item.update(readViewport);
    }
  });
}

function invalidateNativeViewport() {
  nativeViewportGeneration += 1;
  scheduleLayout();
}

function affectsNativeLayout(record: MutationRecord) {
  if (record.type === 'attributes') {
    if (record.attributeName?.startsWith('data-relay-')) return true;
    const { target } = record;
    if (!(target instanceof Element)) return false;
    if (target.matches(OVERLAY_SELECTOR)) return true;
    return Array.from(observedFrames).some(([frame, item]) => item.needsLayout() && target.contains(frame));
  }
  const changes = [...record.addedNodes, ...record.removedNodes];
  return changes.some((node) => node instanceof Element
    && (node.matches(OVERLAY_SELECTOR) || Boolean(node.querySelector(OVERLAY_SELECTOR))));
}

function watchLayout(frame: HTMLIFrameElement, observer: LayoutObserver) {
  observedFrames.set(frame, observer);
  if (!releaseLayoutWatch) {
    sharedResizeObserver = new ResizeObserver(scheduleLayout);
    const mutationObserver = new MutationObserver((records) => {
      if (records.some(affectsNativeLayout)) scheduleLayout();
    });
    mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'open', 'hidden', 'data-relay-operations', 'data-relay-native-covered'],
    });
    window.addEventListener('resize', invalidateNativeViewport);
    window.addEventListener('egoist-relay-service-change', invalidateNativeViewport);
    window.addEventListener(WORKSPACE_VISIBILITY_EVENT, invalidateNativeViewport);
    document.addEventListener('visibilitychange', invalidateNativeViewport);
    releaseLayoutWatch = () => {
      sharedResizeObserver?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', invalidateNativeViewport);
      window.removeEventListener('egoist-relay-service-change', invalidateNativeViewport);
      window.removeEventListener(WORKSPACE_VISIBILITY_EVENT, invalidateNativeViewport);
      document.removeEventListener('visibilitychange', invalidateNativeViewport);
      if (scheduledLayout !== undefined) cancelAnimationFrame(scheduledLayout);
      scheduledLayout = undefined;
    };
  }
  sharedResizeObserver?.observe(frame);
  return () => {
    observedFrames.delete(frame);
    sharedResizeObserver?.unobserve(frame);
    if (observedFrames.size) return;
    releaseLayoutWatch?.();
    releaseLayoutWatch = undefined;
    sharedResizeObserver = undefined;
  };
}

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
  if (!frame.isConnected || document.hidden || !owner || owner.matches('.closing, .not-shown, .not-open')
    || document.documentElement.dataset.relayNativeCovered === 'true'
    || document.querySelector('[data-relay-operations="true"]')) {
    return true;
  }
  const activeApp = document.documentElement.dataset.relayActiveApp;
  if (activeApp && activeApp !== 'telegram') {
    return true;
  }
  const overlays = document.querySelectorAll('.Modal.open, .Modal.closing, dialog[open], .Menu .bubble.open');
  let frameBounds: DOMRect | undefined;
  return Array.from(overlays).some((element) => {
    if (element === owner || element.contains(frame)) return false;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    if (!element.matches('.Menu .bubble')) return true;
    frameBounds ||= frame.getBoundingClientRect();
    const menuBounds = element.getBoundingClientRect();
    return menuBounds.left < frameBounds.right && menuBounds.right > frameBounds.left
      && menuBounds.top < frameBounds.bottom && menuBounds.bottom > frameBounds.top;
  });
}
export function createNativeWebAppFrame(
  frame: HTMLIFrameElement, url: string, options: FrameOptions,
): NativeWebAppFrame {
  let id = crypto.randomUUID();
  let isDisposed = false;
  let isCreated = false;
  let isLoaded = false;
  let hasLoadError = false;
  let shouldRecreate = false;
  let loadedNavigation = 0;
  let lastGeometry: string | undefined;
  let lastLayoutKey: string | undefined;
  let isLayoutQueued = false;
  let shouldRecheckLayout = false;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve();
  let releaseEvents: NoneToVoidFunction | undefined;
  let releaseDownloads: NoneToVoidFunction | undefined;
  const pendingEvents: WebAppOutboundEvent[] = [];
  const releaseSubscriptions = () => {
    releaseEvents?.();
    releaseEvents = undefined;
    releaseDownloads?.();
    releaseDownloads = undefined;
  };
  const reportError = (failure: NativeWebAppLoadFailure) => {
    if (isDisposed) return;
    if (failure === 'process') shouldRecreate = true;
    if (hasLoadError) {
      return;
    }
    hasLoadError = true;
    isLoaded = false;
    clearTimeout(loadTimer);
    options.onError(failure);
    scheduleUpdate();
  };
  const startLoading = () => {
    isLoaded = false;
    hasLoadError = false;
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => reportError('timeout'), LOAD_TIMEOUT);
    options.onLoading?.();
    scheduleUpdate();
  };
  const getApi = () => import('@tauri-apps/api/core');
  const reportUnknownError = () => reportError('unknown');
  const ready = initialize(url).catch(reportUnknownError);
  const releaseLayout = watchLayout(frame, {
    needsLayout: () => lastGeometry !== undefined || (isLoaded && options.isVisible()),
    update: updateLayout,
  });
  function queue(task: () => Promise<void>) {
    chain = chain.then(async () => {
      await ready;
      if (isDisposed || !isCreated) {
        return;
      }
      await task();
    }).catch(reportUnknownError);
    return chain;
  }
  function getFrameLayout() {
    return {
      rect: frame.getBoundingClientRect(),
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    };
  }
  function getLayoutKey({ rect, viewport }: ReturnType<typeof getFrameLayout>) {
    return [
      loadedNavigation, nativeViewportGeneration, window.devicePixelRatio,
      rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height,
    ].join(':');
  }

  function isRequestedVisible() {
    return !isDisposed && isLoaded && options.isVisible() && !isNativeFrameCovered(frame);
  }
  async function initialize(initialUrl: string) {
    const [{ invoke }, { listen }] = await Promise.all([getApi(), import('@tauri-apps/api/event')]);
    if (isDisposed) {
      return;
    }
    releaseEvents ||= await listen<NativeFrameEvent>(NATIVE_EVENT, ({ payload }) => {
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
        startLoading();
      }
      if (payload.kind === 'error') {
        reportError(LOAD_FAILURES.find((failure) => failure === payload.data) || 'unknown');
      }
      if (payload.kind === 'popup_error') options.onPopupError?.();
      if (payload.kind === 'loaded' && !shouldRecreate) {
        clearTimeout(loadTimer);
        isLoaded = true;
        hasLoadError = false;
        loadedNavigation += 1;
        options.onLoad();
        pendingEvents.splice(0).forEach(sendEvent);
        scheduleUpdate();
      }
    });
    if (isDisposed) {
      releaseSubscriptions();
      return;
    }
    releaseDownloads ||= await listen('relay-media-toggle', () => {
      if (!isDisposed && options.isVisible() && !isNativeFrameCovered(frame)) {
        options.onDownloads();
      }
    });
    if (isDisposed) {
      releaseSubscriptions();
      return;
    }
    startLoading();
    // WebView2 attaches the view before it can be hidden. Start in a one-pixel rectangle.
    await invoke('relay_mini_app_open', { id, url: initialUrl, bounds: HIDDEN_INITIAL_BOUNDS });
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
    if (!isDisposed) scheduleLayout();
  }

  function updateLayout(getViewport: typeof getWindowViewport) {
    if (isLayoutQueued) {
      shouldRecheckLayout = true;
      return;
    }
    isLayoutQueued = true;
    void queue(async () => {
      if (options.isVisible() && document.querySelector('[data-relay-operations="true"]')) options.onDownloads();
      const layout = isRequestedVisible() ? getFrameLayout() : undefined;
      const layoutKey = layout && getLayoutKey(layout);
      if ((layoutKey && layoutKey === lastLayoutKey) || (!layout && !lastGeometry)) return;
      const [{ invoke }, bounds] = await Promise.all([
        getApi(),
        layout && getViewport()
          .then((viewport) => resolveAppBounds(layout.rect, layout.viewport, viewport))
          .catch(() => undefined),
      ]);
      if (isDisposed) return;
      const visible = Boolean(bounds) && isRequestedVisible();
      if (visible && layoutKey !== getLayoutKey(getFrameLayout())) {
        shouldRecheckLayout = true;
        return;
      }
      const geometry = visible ? JSON.stringify({ bounds, loadedNavigation, nativeViewportGeneration }) : undefined;
      if (geometry !== lastGeometry) {
        await invoke('relay_mini_app_update', { id, bounds: visible ? bounds : undefined, visible });
        lastGeometry = geometry;
      }
      lastLayoutKey = visible ? layoutKey : undefined;
    }).finally(() => {
      isLayoutQueued = false;
      if (shouldRecheckLayout) {
        shouldRecheckLayout = false;
        scheduleUpdate();
      }
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
    if (isDisposed) return;
    startLoading();
    pendingEvents.splice(0);
    chain = chain.then(async () => {
      await ready;
      if (isDisposed) return;
      const { invoke } = await getApi();
      if (isDisposed) return;
      if (isCreated && shouldRecreate) {
        await invoke('relay_mini_app_close', { id });
        isCreated = false;
        id = crypto.randomUUID();
        lastGeometry = undefined;
        lastLayoutKey = undefined;
      }
      shouldRecreate = false;
      if (!isCreated) {
        await initialize(nextUrl);
        return;
      }
      await invoke('relay_mini_app_reload', { id, url: nextUrl });
    }).catch(reportUnknownError);
  }
  function dispose() {
    if (isDisposed) {
      return;
    }
    isDisposed = true;
    clearTimeout(loadTimer);
    pendingEvents.splice(0);
    releaseLayout();
    releaseSubscriptions();
    void Promise.all([ready, chain]).then(async () => {
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
