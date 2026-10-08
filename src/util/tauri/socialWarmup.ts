/**
 * Ленивый прогрев окон X и Instagram. Раньше оба окна создавались на каждом старте и конкурировали с
 * Telegram за сеть и процессор. Теперь прогрев стартует, только когда Telegram готов, пользователь
 * бездействует, и выключается настройкой `shouldWarmupSocialViews`.
 */

export const WARMUP_READY_DELAY_MS = 4000;
export const WARMUP_IDLE_MS = 2500;
export const WARMUP_POLL_MS = 1000;
export const WARMUP_STEP_GAP_MS = 3000;

export interface SocialWarmupOptions {
  /** Команды Tauri, которые создают окна; выполняются по очереди. */
  commands: readonly string[];
  isEnabled: () => boolean;
  isTelegramReady: () => boolean;
  /** Время последнего ввода пользователя, мс эпохи. */
  getLastInputAt: () => number;
  run: (command: string) => Promise<unknown>;
  onError?: (error: unknown) => void;
}

/** Запускает отложенный прогрев и возвращает функцию отмены. */
export function startSocialWarmup(options: SocialWarmupOptions) {
  const { commands, isEnabled, isTelegramReady, getLastInputAt, run, onError } = options;
  let isCancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readySince: number | undefined;
  let index = 0;

  const schedule = (delay: number) => {
    timer = setTimeout(tick, delay);
  };

  function tick() {
    timer = undefined;
    if (isCancelled || index >= commands.length) return;
    if (!isEnabled()) {
      // Выключенная настройка не расходует ресурсы; включение подхватит следующий опрос
      readySince = undefined;
      schedule(WARMUP_POLL_MS * 5);
      return;
    }
    const now = Date.now();
    if (!isTelegramReady()) {
      readySince = undefined;
      schedule(WARMUP_POLL_MS);
      return;
    }
    readySince ??= now;
    const isSettled = now - readySince >= WARMUP_READY_DELAY_MS;
    const isIdle = now - getLastInputAt() >= WARMUP_IDLE_MS;
    if (!isSettled || !isIdle) {
      schedule(WARMUP_POLL_MS);
      return;
    }

    const command = commands[index++];
    run(command).catch((error) => onError?.(error)).finally(() => {
      if (!isCancelled && index < commands.length) schedule(WARMUP_STEP_GAP_MS);
    });
  }

  schedule(WARMUP_POLL_MS);

  return () => {
    isCancelled = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}

let lastInputAt = Date.now();
let isTracking = false;

/** Подписка на ввод пользователя (один раз); возвращает время последнего ввода. */
export function getLastUserInputAt() {
  if (!isTracking && typeof window !== 'undefined') {
    isTracking = true;
    const mark = () => {
      lastInputAt = Date.now();
    };
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((name) => {
      window.addEventListener(name, mark, { passive: true, capture: true });
    });
  }
  return lastInputAt;
}
