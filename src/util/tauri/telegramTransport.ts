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
