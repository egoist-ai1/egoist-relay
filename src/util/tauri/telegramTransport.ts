import { IS_TAURI } from '../browser/globalEnvironment';

export async function getDesktopTelegramTransport(): Promise<string | undefined> {
  if (!IS_TAURI) return undefined;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ url?: string }>('relay_get_telegram_transport');
    return result.url;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Cannot connect the Lagom Telegram transport');
    return undefined;
  }
}
