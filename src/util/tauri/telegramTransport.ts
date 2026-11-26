import { IS_TAURI } from '../browser/globalEnvironment';

let shouldRetryTransport = false;
let isRequestingTransport = false;

/**
 * Адрес локального моста к MTProxy, который оболочка запускает самостоятельно для Telegram.
 */
export async function getDesktopTelegramTransport(): Promise<string | undefined> {
  if (!IS_TAURI) return undefined;
  isRequestingTransport = true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ url?: string; mtproxy?: boolean }>('relay_get_telegram_transport');
    const url = result.mtproxy ? result.url : undefined;
    shouldRetryTransport = !url;
    return url;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Cannot start the local Telegram proxy');
    shouldRetryTransport = true;
    return undefined;
  } finally {
    isRequestingTransport = false;
  }
}

/**
 * Оболочка сообщает, что локальный прокси Telegram изменился: адрес `getDesktopTelegramTransport()`
 * нужно запросить заново и переподключить GramJS. Возвращает функцию отписки.
 */
export async function watchDesktopTelegramTransportChange(callback: NoneToVoidFunction): Promise<NoneToVoidFunction> {
  if (!IS_TAURI) return () => undefined;
  const retryTimer = setInterval(() => {
    if (shouldRetryTransport && !isRequestingTransport) callback();
  }, 15000);
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen('relay-telegram-transport-changed', () => callback());
    return () => {
      clearInterval(retryTimer);
      unlisten();
    };
  } catch (err) {
    return () => clearInterval(retryTimer);
  }
}
