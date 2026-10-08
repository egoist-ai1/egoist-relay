/**
 * Сетевая политика соединения Telegram: backoff с джиттером, гонка маршрутов (happy eyeballs),
 * память о рабочем маршруте и сглаженный RTT. Модуль не зависит от GramJS и DOM: время и случайность
 * берутся из глобальных setTimeout/Date/Math.random, поэтому тесты идут на виртуальном времени.
 */

export type RouteKind = 'lagom' | 'direct';

export interface RouteCandidate {
  kind: RouteKind;
  url: string;
}

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  factor?: number;
  /** Доля задержки, подверженная случайности: 0 — без джиттера, 0.5 — от 50% до 100% */
  jitter?: number;
}

const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  baseMs: 300,
  capMs: 15000,
  factor: 2,
  jitter: 0.5,
};

/** Экспоненциальная задержка перед попыткой номер `attempt` (с нуля) с равномерным джиттером. */
export function backoffDelay(attempt: number, options: BackoffOptions = {}, random: () => number = Math.random) {
  const { baseMs, capMs, factor, jitter } = { ...DEFAULT_BACKOFF, ...options };
  const raw = Math.min(capMs, baseMs * factor ** Math.max(0, attempt));
  const spread = Math.min(1, Math.max(0, jitter));
  return Math.round(raw * (1 - spread + spread * random()));
}

const PING_TIMEOUT_MIN_MS = 2500;
const PING_TIMEOUT_MAX_MS = 5000;

/** Таймаут ответа на ping: быстрее объявляем обрыв на быстрой сети, не трогаем медленные линии. */
export function adaptivePingTimeout(smoothedRttMs?: number) {
  if (!smoothedRttMs || !Number.isFinite(smoothedRttMs)) return PING_TIMEOUT_MAX_MS;
  return Math.round(Math.min(PING_TIMEOUT_MAX_MS, Math.max(PING_TIMEOUT_MIN_MS, smoothedRttMs * 8)));
}

export class RouteRaceError extends Error {
  constructor(public readonly errors: Error[]) {
    super(errors.length ? errors[errors.length - 1].message : 'No route candidates');
    this.name = 'RouteRaceError';
  }
}

export interface RaceOptions<T> {
  /** Через сколько стартует следующий кандидат, если предыдущий ещё не ответил; провал предыдущего стартует сразу. */
  staggerMs: number;
  /** Закрыть результат проигравшего, который всё же успел открыться. */
  dispose?: (value: T, candidate: RouteCandidate) => void;
}

export interface RaceResult<T> {
  candidate: RouteCandidate;
  value: T;
  /** Время от старта гонки до открытия победителя. */
  elapsedMs: number;
}

/**
 * Параллельное подключение к кандидатам с отменой проигравших. Первый успешный побеждает;
 * остальным отправляется abort, а уже открывшиеся значения освобождаются через `dispose`.
 */
export function raceRoutes<T>(
  candidates: RouteCandidate[],
  open: (candidate: RouteCandidate, signal: AbortSignal) => Promise<T>,
  options: RaceOptions<T>,
  externalSignal?: AbortSignal,
): Promise<RaceResult<T>> {
  return new Promise((resolve, reject) => {
    if (!candidates.length) {
      reject(new RouteRaceError([]));
      return;
    }
    const startedAt = Date.now();
    const controllers: AbortController[] = [];
    const errors: Error[] = [];
    let started = 0;
    let failed = 0;
    let isSettled = false;
    let staggerTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      isSettled = true;
      if (staggerTimer) clearTimeout(staggerTimer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    };
    function onExternalAbort() {
      if (isSettled) return;
      finish();
      controllers.forEach((controller) => controller.abort());
      reject(new RouteRaceError([...errors, new Error('Route race aborted')]));
    }
    if (externalSignal?.aborted) {
      onExternalAbort();
      return;
    }
    externalSignal?.addEventListener('abort', onExternalAbort);

    const startNext = () => {
      if (isSettled || started >= candidates.length) return;
      if (staggerTimer) clearTimeout(staggerTimer);
      staggerTimer = undefined;
      const index = started++;
      const candidate = candidates[index];
      const controller = new AbortController();
      controllers[index] = controller;
      open(candidate, controller.signal).then((value) => {
        if (isSettled) {
          options.dispose?.(value, candidate);
          return;
        }
        finish();
        controllers.forEach((other, otherIndex) => {
          if (otherIndex !== index) other.abort();
        });
        resolve({ candidate, value, elapsedMs: Date.now() - startedAt });
      }, (error: unknown) => {
        if (isSettled) return;
        errors.push(error instanceof Error ? error : new Error(String(error)));
        failed++;
        if (failed >= candidates.length) {
          finish();
          reject(new RouteRaceError(errors));
        } else if (started < candidates.length) {
          startNext();
        }
      });
      if (started < candidates.length) {
        staggerTimer = setTimeout(startNext, options.staggerMs);
      }
    };
    startNext();
  });
}

export interface RouteStatus {
  kind: RouteKind;
  /** Сглаженный RTT до Telegram, мс; undefined, пока не измерен. */
  rttMs?: number;
}

const RTT_SMOOTHING = 0.25;
const ROUTE_DEMOTE_MS = 60000;
const RTT_REPORT_MIN_DELTA = 0.2;
const RTT_REPORT_MIN_INTERVAL_MS = 10000;

/**
 * Память о рабочем маршруте. Маршрут Lagom приоритетный; после провала он понижается на
 * `ROUTE_DEMOTE_MS`, а фоновая проверка (`probeDue`/`markProbe`) возвращает его, не блокируя подключение.
 */
export class RouteHealth {
  private lastWorking: RouteKind = 'lagom';

  private failedAt: Partial<Record<RouteKind, number>> = {};

  private probedAt = 0;

  private active?: RouteKind;

  private smoothedRtt?: number;

  private reported?: { kind?: RouteKind; rttMs?: number; at: number };

  private listener?: (status: RouteStatus | undefined) => void;

  constructor(private readonly now: () => number = Date.now) {}

  reset() {
    this.lastWorking = 'lagom';
    this.failedAt = {};
    this.probedAt = 0;
    this.active = undefined;
    this.smoothedRtt = undefined;
    this.reported = undefined;
  }

  setListener(listener?: (status: RouteStatus | undefined) => void) {
    this.listener = listener;
  }

  getRtt() {
    return this.smoothedRtt;
  }

  getStatus(): RouteStatus | undefined {
    return this.active ? { kind: this.active, rttMs: this.smoothedRtt && Math.round(this.smoothedRtt) } : undefined;
  }

  order(candidates: RouteCandidate[]): RouteCandidate[] {
    const isDemoted = (kind: RouteKind) => {
      const failedAt = this.failedAt[kind];
      return failedAt !== undefined && this.now() - failedAt < ROUTE_DEMOTE_MS;
    };
    const rank = (candidate: RouteCandidate) => {
      if (isDemoted(candidate.kind)) return 2;
      return candidate.kind === this.lastWorking ? 0 : 1;
    };
    return candidates.map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => rank(a.candidate) - rank(b.candidate) || a.index - b.index)
      .map(({ candidate }) => candidate);
  }

  recordSuccess(kind: RouteKind, rttMs?: number) {
    delete this.failedAt[kind];
    this.lastWorking = kind;
    this.active = kind;
    if (rttMs !== undefined) this.observeRtt(rttMs, false);
    this.emit(true);
  }

  recordFailure(kind: RouteKind) {
    this.failedAt[kind] = this.now();
    if (this.active === kind) {
      this.active = undefined;
      this.smoothedRtt = undefined;
      this.emit(true);
    }
  }

  /** Осторожный возврат Lagom после удачной фоновой проверки. */
  recordProbeSuccess(kind: RouteKind) {
    delete this.failedAt[kind];
    if (kind === 'lagom') this.lastWorking = 'lagom';
  }

  observeRtt(rttMs: number, shouldEmit = true) {
    if (!Number.isFinite(rttMs) || rttMs < 0) return;
    this.smoothedRtt = this.smoothedRtt === undefined
      ? rttMs : this.smoothedRtt + (rttMs - this.smoothedRtt) * RTT_SMOOTHING;
    if (shouldEmit) this.emit(false);
  }

  /** Нужна ли фоновая проверка понижённого маршрута (не чаще раза в `intervalMs`). */
  probeDue(kind: RouteKind, intervalMs: number) {
    const failedAt = this.failedAt[kind];
    return failedAt !== undefined && this.now() - this.probedAt >= intervalMs;
  }

  markProbe() {
    this.probedAt = this.now();
  }

  private emit(isForced: boolean) {
    const status = this.getStatus();
    const previous = this.reported;
    const now = this.now();
    const rtt = status?.rttMs;
    if (previous?.kind === status?.kind) {
      if (!status || rtt === previous?.rttMs) return;
      const previousRtt = previous?.rttMs;
      const isFirstRtt = previousRtt === undefined && rtt !== undefined;
      const isBigChange = previousRtt !== undefined && rtt !== undefined
        && Math.abs(rtt - previousRtt) / Math.max(1, previousRtt) >= RTT_REPORT_MIN_DELTA
        && now - (previous?.at ?? 0) >= RTT_REPORT_MIN_INTERVAL_MS;
      if (!isFirstRtt && !isBigChange && !isForced) return;
    }
    this.reported = { kind: status?.kind, rttMs: rtt, at: now };
    this.listener?.(status);
  }
}

/** Пауза, которую сигнал `online` от ОС прерывает: после возврата сети не ждём остаток backoff. */
export function sleepUntilOnline(ms: number) {
  return new Promise<void>((resolve) => {
    const target = globalThis as unknown as EventTarget | undefined;
    const done = () => {
      clearTimeout(timer);
      target?.removeEventListener?.('online', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    target?.addEventListener?.('online', done);
  });
}

/** Будильник цикла ping: просыпается по таймеру или раньше — по событию сети/пробуждения. */
export class WakeableTimer {
  private wake?: () => void;

  sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      this.wake = done;
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  notify() {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

/** Общее состояние маршрутов процесса (API-воркер). */
export const routeHealth = new RouteHealth();
