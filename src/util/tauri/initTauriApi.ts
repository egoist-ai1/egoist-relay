import type { TauriUpdateEventHandlers, TauriUpdateMode, TauriUpdateProgress } from '../../types/tauri';

import { IS_MAC_OS } from '../browser/windowEnvironment';

let syncWindow: import('@tauri-apps/api/window').Window | undefined;
import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
  syncWindow = getCurrentWindow();
}).catch(() => {});

export function getTauriWindowSync() {
  if (syncWindow) return syncWindow;
  if (typeof (window as any).__TAURI__?.window?.getCurrentWindow === 'function') {
    syncWindow = (window as any).__TAURI__.window.getCurrentWindow();
    return syncWindow;
  }
  return undefined;
}

export default function initTauriApi() {
  const corePromise = import('@tauri-apps/api/core');
  async function markTitleBarOverlay(isOverlay: boolean, isMobile?: boolean) {
    if (!IS_MAC_OS) return;
    const core = await corePromise;
    return core.invoke<void>('mark_title_bar_overlay', { isOverlay, isMobile });
  }

  async function setNotificationsCount(amount: number, isMuted = false) {
    const core = await corePromise;
    return core.invoke<void>('set_notifications_count', { amount, isMuted });
  }

  async function openNewWindow(url: string) {
    const core = await corePromise;
    const opened = await core.invoke<boolean>('open_new_window_cmd', { url });
    if (!opened) throw new Error('Could not open the Relay window');
  }

  async function setWindowTitle(title: string) {
    const core = await corePromise;
    return core.invoke<void>('set_window_title', { title });
  }

  async function checkUpdate() {
    if (!window.tauri?.updaterEnabled) return undefined;
    const core = await corePromise;
    const result = await core.invoke<{
      available: boolean; version?: string; notes?: string; size?: number;
    }>('update_check');
    if (!result?.available || !result.version) return undefined;
    return {
      version: result.version,
      body: result.notes,
      size: result.size,
      downloadAndInstall: async (onProgress?: (progress: TauriUpdateProgress) => void) => {
        const onEvent = new core.Channel<TauriUpdateProgress>();
        if (onProgress) onEvent.onmessage = onProgress;
        await core.invoke<void>('update_install', { onEvent });
      },
    };
  }

  async function getUpdateMode(): Promise<TauriUpdateMode> {
    if (!window.tauri?.updaterEnabled) return 'off';
    const core = await corePromise;
    const mode = await core.invoke<TauriUpdateMode>('update_get_mode');
    return mode === 'auto' || mode === 'off' ? mode : 'ask';
  }

  async function onUpdateEvents(handlers: TauriUpdateEventHandlers) {
    const { listen } = await import('@tauri-apps/api/event');
    const releases = await Promise.all([
      listen<Parameters<NonNullable<TauriUpdateEventHandlers['onAvailable']>>[0]>(
        'update-available', ({ payload }) => handlers.onAvailable?.(payload),
      ),
      listen<Parameters<NonNullable<TauriUpdateEventHandlers['onManual']>>[0]>(
        'update-manual', ({ payload }) => handlers.onManual?.(payload),
      ),
      listen<Parameters<NonNullable<TauriUpdateEventHandlers['onFailed']>>[0]>(
        'update-failed', ({ payload }) => handlers.onFailed?.(payload),
      ),
    ]);
    return () => releases.forEach((release) => release());
  }

  // @ts-expect-error
  window.tauri ??= {};
  Object.assign(window.tauri, {
    markTitleBarOverlay,
    setNotificationsCount,
    openNewWindow,
    relaunch: () => import('@tauri-apps/plugin-process').then(({ relaunch }) => relaunch()),
    checkUpdate,
    getUpdateMode,
    onUpdateEvents,
    getCurrentWindow: () => import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow()),
    getSyncWindow: getTauriWindowSync,
    setWindowTitle,
    invoke: (cmd: string, args?: any) => corePromise.then(({ invoke }) => invoke(cmd, args)),
  });
}
