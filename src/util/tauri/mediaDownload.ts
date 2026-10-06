export type NativeMediaDownloadResult = { operationId: string; success: boolean; path?: string; error?: string };
export type NativeMediaDownload = {
  id: string;
  completed: Promise<NativeMediaDownloadResult>;
  cancel: () => Promise<void>;
};
type Waiter = { resolve: (result: NativeMediaDownloadResult) => void; startTimer?: ReturnType<typeof setTimeout> };
const waiters = new Map<string, Waiter>();
let listeners: Promise<void> | undefined;

async function ensureListeners() {
  if (!listeners) {
    listeners = (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      await listen<NativeMediaDownloadResult>('download-finished', ({ payload }) => finish(payload));
      await listen<{ operationId: string }>('relay-media-download-started', ({ payload }) => {
        const waiter = waiters.get(payload.operationId);
        if (waiter?.startTimer) {
          clearTimeout(waiter.startTimer);
          waiter.startTimer = undefined;
        }
      });
    })();
  }
  return listeners;
}
function finish(result: NativeMediaDownloadResult) {
  const waiter = waiters.get(result.operationId);
  if (!waiter) return;
  if (waiter.startTimer) clearTimeout(waiter.startTimer);
  waiters.delete(result.operationId);
  waiter.resolve(result);
}

export async function normalizeNativeDownloadFileName(fileName: string): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('relay_media_download_file_name', { fileName });
}

export async function prepareNativeMediaDownload(url: string, fileName: string): Promise<NativeMediaDownload> {
  await ensureListeners();
  const { invoke } = await import('@tauri-apps/api/core');
  const id = await invoke<string>('relay_media_download_prepare', { url, fileName });
  const completed = new Promise<NativeMediaDownloadResult>((resolve) => {
    const startTimer = setTimeout(() => {
      void invoke('relay_media_operation_action', { action: { type: 'cancel', id } }).catch(() => undefined);
      finish({ operationId: id, success: false, error: 'MEDIA_DOWNLOAD_NOT_STARTED' });
    }, 125000);
    waiters.set(id, { resolve, startTimer });
  });
  return {
    id, completed,
    cancel: async () => {
      if (!waiters.has(id)) return;
      try {
        await invoke('relay_media_operation_action', {
          action: {
            type: 'cancel', id,
          },
        });
      } finally {
        finish({
          operationId: id, success: false, error: 'MEDIA_CANCELLED',
        });
      }
    },
  };
}
