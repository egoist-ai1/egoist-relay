import type { Window as TauriWindow } from '@tauri-apps/api/window';

export type TauriUpdateMode = 'auto' | 'ask' | 'off';

// Ход установки: канал `onEvent` команды `update_install`
export type TauriUpdateProgress = {
  phase: 'downloading' | 'verifying' | 'launching';
  done: number;
  total: number;
};

export type TauriUpdate = {
  version: string;
  body?: string;
  size?: number;
  // Скачивает, проверяет подпись и запускает установщик; приложение закрывается само
  downloadAndInstall: (onProgress?: (progress: TauriUpdateProgress) => void) => Promise<void>;
};

// События бэкенда: `update-available`, `update-manual`, `update-failed`
export type TauriUpdateEventHandlers = {
  onAvailable?: (payload: { version: string; notes: string; size: number; ready: boolean }) => void;
  onManual?: (payload: { version: string; message: string }) => void;
  onFailed?: (payload: { version: string; attempts: number; message: string }) => void;
};

type TauriApi = {
  version: string;
  updaterEnabled?: boolean;
  youtubePlayerSmoke?: boolean;
  markTitleBarOverlay: (isOverlay: boolean, isMobile?: boolean) => Promise<void>;
  setNotificationsCount: (amount: number, isMuted?: boolean) => Promise<void>;
  openNewWindow: (url: string) => Promise<void>;
  relaunch: () => Promise<void>;
  checkUpdate: () => Promise<TauriUpdate | undefined>;
  getUpdateMode: () => Promise<TauriUpdateMode>;
  // Возвращает функцию отписки
  onUpdateEvents: (handlers: TauriUpdateEventHandlers) => Promise<() => void>;
  getCurrentWindow: () => Promise<TauriWindow>;
  setWindowTitle: (title: string) => Promise<void>;
};

declare global {
  interface Window {
    tauri: TauriApi;
  }
}

export {};
