import { IS_TAURI } from '../browser/globalEnvironment';

/**
 * Адрес локального моста к MTProxy. Оболочка запускает мост только когда в настройках сети задана
 * ссылка MTProxy; иначе адреса нет, и Telegram идёт по стандартному wss через прокси WebView.
 */
export async function getDesktopTelegramTransport(): Promise<string | undefined> {
  if (!IS_TAURI) return undefined;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ url?: string; mtproxy?: boolean }>('relay_get_telegram_transport');
    return result.mtproxy ? result.url : undefined;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Cannot connect the MTProxy Telegram transport');
    return undefined;
  }
}

/**
 * Оболочка сообщает, что MTProxy в настройках сети сменился и мост остановлен: адрес `getDesktopTelegramTransport()`
 * нужно запросить заново и переподключить GramJS. Возвращает функцию отписки.
 */
export async function watchDesktopTelegramTransportChange(callback: NoneToVoidFunction): Promise<NoneToVoidFunction> {
  if (!IS_TAURI) return () => undefined;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen('relay-telegram-transport-changed', () => callback());
  } catch (err) {
    return () => undefined;
  }
}
