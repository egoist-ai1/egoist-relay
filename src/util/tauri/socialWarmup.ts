export const WARMUP_READY_DELAY_MS = 4000;
export const WARMUP_IDLE_MS = 2500;
export const WARMUP_STEP_GAP_MS = 3000;

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

export interface SocialWarmupOptions {
  /** Команды Tauri, которые создают окна; выполняются по очереди. */
  commands: readonly string[];
  isEnabled: () => boolean;
  /** Отсекает команды скрытых сервисов; пропущенная команда выполнится, когда сервис снова покажут. */
  isCommandEnabled?: (command: string) => boolean;
  isTelegramReady: () => boolean;
  subscribeState: (refresh: () => void) => () => void;
  run: (command: string) => Promise<unknown>;
  onError?: (error: unknown) => void;
}

/** Прогревает окна только после готовности Telegram и паузы ввода в активном окне */
export function startSocialWarmup(options: SocialWarmupOptions) {
  const {
    commands, isEnabled, isCommandEnabled, isTelegramReady, subscribeState, run, onError,
  } = options;
  const remainingCommands = new Set(commands);
  let isCancelled = false;
  let isRunning = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduledAt: number | undefined;
  let readySince: number | undefined;
  let lastInputAt = Date.now();
  let nextCommandAt = 0;

  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
    scheduledAt = undefined;
  }

  function refresh() {
    if (isCancelled || !remainingCommands.size) return;
    const command = isEnabled() && !document.hidden && document.hasFocus() && isTelegramReady()
      ? commands.find((name) => remainingCommands.has(name) && (isCommandEnabled?.(name) ?? true))
      : undefined;
    if (!command) {
      readySince = undefined;
      clearTimer();
      return;
    }

    const now = Date.now();
    readySince ??= now;
    if (isRunning) return;
    const deadline = Math.max(readySince + WARMUP_READY_DELAY_MS, lastInputAt + WARMUP_IDLE_MS, nextCommandAt);
    if (now >= deadline) {
      clearTimer();
      void warmup(command);
      return;
    }
    if (deadline === scheduledAt) return;

    clearTimer();
    scheduledAt = deadline;
    timer = setTimeout(() => {
      scheduledAt = undefined;
      timer = undefined;
      refresh();
    }, deadline - now);
  }

  async function warmup(command: string) {
    remainingCommands.delete(command);
    isRunning = true;
    try {
      await run(command);
    } catch (error) {
      if (!isCancelled) onError?.(error);
    } finally {
      isRunning = false;
      if (remainingCommands.size) {
        nextCommandAt = Date.now() + WARMUP_STEP_GAP_MS;
        refresh();
      } else {
        cancel();
      }
    }
  }

  function markInput() {
    lastInputAt = Date.now();
    refresh();
  }

  const unsubscribeState = subscribeState(refresh);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);
  window.addEventListener('blur', refresh);
  INPUT_EVENTS.forEach((name) => window.addEventListener(name, markInput, { passive: true, capture: true }));
  refresh();

  function cancel() {
    if (isCancelled) return;
    isCancelled = true;
    clearTimer();
    unsubscribeState();
    document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('blur', refresh);
    INPUT_EVENTS.forEach((name) => window.removeEventListener(name, markInput, true));
  }

  return cancel;
}
