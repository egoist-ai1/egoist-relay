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
    const { check } = await import('@tauri-apps/plugin-updater');
    return (await check()) ?? undefined;
  }

  // @ts-expect-error
  window.tauri ??= {};
  Object.assign(window.tauri, {
    markTitleBarOverlay,
    setNotificationsCount,
    openNewWindow,
    relaunch: () => import('@tauri-apps/plugin-process').then(({ relaunch }) => relaunch()),
    checkUpdate,
    getCurrentWindow: () => import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow()),
    getSyncWindow: getTauriWindowSync,
    setWindowTitle,
    invoke: (cmd: string, args?: any) => corePromise.then(({ invoke }) => invoke(cmd, args)),
  });
}
