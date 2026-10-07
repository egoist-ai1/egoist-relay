import { IS_TAURI } from '../browser/globalEnvironment';
import { handleError } from '../handleError';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

let lastSent: string | undefined;

/**
 * Передаёт оболочке Tauri цвет подложки нативных WebView (X, Instagram, Mini App) и тему окна.
 * Вне Tauri и для значений не вида `#RRGGBB` (альфа, `var()`, имена цветов) ничего не делает.
 */
export function syncNativeTheme(background: string | undefined, isDark: boolean): void {
  if (!IS_TAURI || !background || !HEX_COLOR.test(background)) {
    return;
  }

  const key = `${background.toUpperCase()}:${isDark}`;
  if (key === lastSent) {
    return;
  }
  lastSent = key;

  void (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('relay_set_theme', { background, isDark });
    } catch (err) {
      // Следующая попытка с тем же цветом должна дойти до оболочки
      lastSent = undefined;
      handleError(err instanceof Error ? err : new Error(String(err)));
    }
  })();
}
