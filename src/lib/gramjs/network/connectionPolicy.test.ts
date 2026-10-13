import { appendFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { RouteCandidate, RouteStatus } from './connectionPolicy';

import {
  adaptivePingTimeout, backoffDelay, raceRoutes, RouteHealth, RouteRaceError, sleepUntilOnline, WakeableTimer,
} from './connectionPolicy';

const WSS: RouteCandidate = { kind: 'wss', url: 'ws://127.0.0.1:1/apiws' };
const MTPROXY: RouteCandidate = { kind: 'mtproxy', url: 'wss://zws2.web.telegram.org:443/apiws' };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('backoffDelay', () => {
  test('grows exponentially to the cap without jitter', () => {
    const options = { baseMs: 400, capMs: 4000, jitter: 0 };
    expect([0, 1, 2, 3, 4, 5, 9].map((attempt) => backoffDelay(attempt, options)))
      .toEqual([400, 800, 1600, 3200, 4000, 4000, 4000]);
  });

  test('jitter keeps the delay between half and the full value', () => {
    const options = { baseMs: 1000, capMs: 8000, jitter: 0.5 };
    expect(backoffDelay(2, options, () => 0)).toBe(2000);
    expect(backoffDelay(2, options, () => 1)).toBe(4000);
    expect(backoffDelay(2, options, () => 0.5)).toBe(3000);
  });
});

describe('adaptivePingTimeout', () => {
  test('is bounded and conservative until RTT is known', () => {
    expect(adaptivePingTimeout(undefined)).toBe(5000);
    expect(adaptivePingTimeout(40)).toBe(2500);
    expect(adaptivePingTimeout(400)).toBe(3200);
    expect(adaptivePingTimeout(2000)).toBe(5000);
  });
});

describe('raceRoutes', () => {
  function deferredOpen() {
    type Pending = { resolve: (value: string) => void; reject: (error: Error) => void; signal: AbortSignal };
    const pending = new Map<string, Pending>();
    const open = (candidate: RouteCandidate, signal: AbortSignal) => new Promise<string>((resolve, reject) => {
      pending.set(candidate.kind, { resolve, reject, signal });
    });
    return { pending, open };
  }

  test('the first route wins without starting the second one when it opens within the stagger', async () => {
    const { pending, open } = deferredOpen();
    const race = raceRoutes([WSS, MTPROXY], open, { staggerMs: 300 });
    await vi.advanceTimersByTimeAsync(40);
    pending.get('wss')!.resolve('wss-socket');
    await expect(race).resolves.toMatchObject({ candidate: WSS, value: 'wss-socket', elapsedMs: 40 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pending.has('mtproxy')).toBe(false);
  });

  test('a failed first route starts the next one immediately', async () => {
    const { pending, open } = deferredOpen();
    const race = raceRoutes([WSS, MTPROXY], open, { staggerMs: 300 });
    await vi.advanceTimersByTimeAsync(160);
    pending.get('wss')!.reject(new Error('503'));
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.has('mtproxy')).toBe(true);
    await vi.advanceTimersByTimeAsync(120);
    pending.get('mtproxy')!.resolve('mtproxy-socket');
    await expect(race).resolves.toMatchObject({ candidate: MTPROXY, elapsedMs: 280 });
  });

  test('a slow first route is overtaken after the stagger and the loser is aborted', async () => {
    const { pending, open } = deferredOpen();
    const dispose = vi.fn();
    const race = raceRoutes([WSS, MTPROXY], open, { staggerMs: 300, dispose });
    await vi.advanceTimersByTimeAsync(300);
    expect(pending.has('mtproxy')).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    pending.get('mtproxy')!.resolve('mtproxy-socket');
    await expect(race).resolves.toMatchObject({ candidate: MTPROXY, elapsedMs: 400 });
    expect(pending.get('wss')!.signal.aborted).toBe(true);
    expect(pending.get('mtproxy')!.signal.aborted).toBe(false);
    // Проигравший, всё же открывшийся после отмены, закрывается
    pending.get('wss')!.resolve('late-wss-socket');
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledWith('late-wss-socket', WSS);
  });

  test('rejects with every error when all routes fail', async () => {
    const { pending, open } = deferredOpen();
    const race = raceRoutes([WSS, MTPROXY], open, { staggerMs: 300 });
    const assertion = expect(race).rejects.toBeInstanceOf(RouteRaceError);
    pending.get('wss')!.reject(new Error('503'));
    await vi.advanceTimersByTimeAsync(0);
    pending.get('mtproxy')!.reject(new Error('timeout'));
    await assertion;
  });

  test('an external abort cancels every attempt', async () => {
    const { pending, open } = deferredOpen();
    const controller = new AbortController();
    const race = raceRoutes([WSS, MTPROXY], open, { staggerMs: 300 }, controller.signal);
    const assertion = expect(race).rejects.toBeInstanceOf(RouteRaceError);
    await vi.advanceTimersByTimeAsync(350);
    controller.abort();
    await assertion;
    expect(pending.get('wss')!.signal.aborted).toBe(true);
    expect(pending.get('mtproxy')!.signal.aborted).toBe(true);
  });
});

describe('RouteHealth', () => {
  test('keeps wss first by default and demotes it for a minute after a failure', () => {
    let now = 1000;
    const health = new RouteHealth(() => now);
    expect(health.order([WSS, MTPROXY]).map(({ kind }) => kind)).toEqual(['wss', 'mtproxy']);
    health.recordFailure('wss');
    expect(health.order([WSS, MTPROXY]).map(({ kind }) => kind)).toEqual(['mtproxy', 'wss']);
    now += 61000;
    expect(health.order([WSS, MTPROXY]).map(({ kind }) => kind)).toEqual(['wss', 'mtproxy']);
  });

  test('remembers the last working route', () => {
    const health = new RouteHealth(() => 0);
    health.recordSuccess('mtproxy');
    expect(health.order([WSS, MTPROXY]).map(({ kind }) => kind)).toEqual(['mtproxy', 'wss']);
  });

  test('a background probe returns wss without touching the active route', () => {
    let now = 0;
    const health = new RouteHealth(() => now);
    health.recordFailure('wss');
    health.recordSuccess('mtproxy');
    expect(health.probeDue('wss', 30000)).toBe(false);
    now = 30000;
    expect(health.probeDue('wss', 30000)).toBe(true);
    health.markProbe();
    expect(health.probeDue('wss', 30000)).toBe(false);
    health.recordProbeSuccess('wss');
    expect(health.getStatus()?.kind).toBe('mtproxy');
    expect(health.order([WSS, MTPROXY])[0].kind).toBe('wss');
    expect(health.probeDue('wss', 0)).toBe(false);
  });

  test('reports route changes at once and RTT changes only when meaningful', () => {
    let now = 0;
    const health = new RouteHealth(() => now);
    const reports: Array<RouteStatus | undefined> = [];
    health.setListener((status) => reports.push(status));
    health.recordSuccess('wss');
    health.observeRtt(80);
    expect(reports).toEqual([{ kind: 'wss', rttMs: undefined }, { kind: 'wss', rttMs: 80 }]);
    now += 1000;
    health.observeRtt(84);
    expect(reports).toHaveLength(2);
    now += 20000;
    health.observeRtt(400);
    health.observeRtt(400);
    health.observeRtt(400);
    expect(reports.length).toBeGreaterThan(2);
    health.recordFailure('wss');
    expect(reports[reports.length - 1]).toBeUndefined();
  });

  test('smooths RTT', () => {
    const health = new RouteHealth(() => 0);
    health.observeRtt(100);
    health.observeRtt(200);
    expect(health.getRtt()).toBe(125);
  });
});

describe('timers', () => {
  test('WakeableTimer resolves early on notify', async () => {
    const timer = new WakeableTimer();
    const done = vi.fn();
    void timer.sleep(3000).then(done);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).not.toHaveBeenCalled();
    timer.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalled();
  });

  test('sleepUntilOnline ends on the online event and cleans up', async () => {
    const done = vi.fn();
    void sleepUntilOnline(8000).then(done);
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).not.toHaveBeenCalled();
    globalThis.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test('sleepUntilOnline ends by timer without the event', async () => {
    const done = vi.fn();
    void sleepUntilOnline(500).then(done);
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toHaveBeenCalled();
  });
});

// Синтетический бенч на виртуальном времени: не измеряет реальную сеть, а сравнивает политики на одной модели.
describe('synthetic benchmark', () => {
  // Числа выводятся в файл по RELAY_BENCH_OUT: testSetup глушит console
  function report(line: string) {
    if (process.env.RELAY_BENCH_OUT) {
      appendFileSync(process.env.RELAY_BENCH_OUT, `${line}
`);
    }
  }

  function mulberry32(seed: number) {
    let state = seed;
    return () => {
      state = (state + 0x6D2B79F5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  async function timeToConnect(wssMode: 'refused' | 'blackhole' | 'ok', mtproxyLatency: number) {
    const open = (candidate: RouteCandidate, signal: AbortSignal) => new Promise<string>((resolve, reject) => {
      const wssLatency = { ok: 4, refused: 165, blackhole: 2500 }[wssMode];
      const latency = candidate.kind === 'mtproxy' ? mtproxyLatency : wssLatency;
      const timer = setTimeout(() => {
        if (candidate.kind === 'wss' && wssMode !== 'ok') reject(new Error('wss unavailable'));
        else resolve(candidate.kind);
      }, latency);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    });
    const race = raceRoutes([WSS, MTPROXY], open, { staggerMs: 300 });
    await vi.advanceTimersByTimeAsync(5000);
    return (await race).elapsedMs;
  }

  test('failover to the mtproxy route', async () => {
    const refused = await timeToConnect('refused', 120);
    const blackhole = await timeToConnect('blackhole', 120);
    const healthy = await timeToConnect('ok', 120);
    // До правки: локальный мост сразу «открывался» и умирал через ~2,4 с без шанса на запасной путь (проверено на старом
    // мосту, scratch-бенч); при чёрной дыре клиент ждал 3 с, спал 2 с и повторял тот же маршрут.
    report(`failover ms: wss refused=${refused}, wss blackhole=${blackhole}, wss healthy=${healthy}`);
    expect(refused).toBe(285);
    expect(blackhole).toBe(420);
    expect(healthy).toBe(4);
  });

  test('reconnect attempts and recovery latency during an outage', () => {
    const random = mulberry32(7);
    const oldDelay = () => 2000;
    const newDelay = (attempt: number) => backoffDelay(attempt, { baseMs: 400, capMs: 4000 }, random);

    function attemptsIn(durationMs: number, delay: (attempt: number) => number) {
      let t = 0;
      let count = 0;
      for (let attempt = 0; t + delay(attempt) <= durationMs; attempt++) {
        t += delay(attempt);
        count++;
      }
      return count;
    }

    // Среднее ожидание успешной попытки после окончания обрыва в случайный момент 5..60 с
    function meanRecovery(delay: (attempt: number) => number, wakesOnOnline: boolean) {
      let total = 0;
      const runs = 2000;
      for (let run = 0; run < runs; run++) {
        const end = 5000 + random() * 55000;
        let t = 0;
        for (let attempt = 0; ; attempt++) {
          const next = t + delay(attempt);
          if (next >= end) {
            total += wakesOnOnline ? 0 : next - end;
            break;
          }
          t = next;
        }
      }
      return Math.round(total / runs);
    }

    const result = {
      attemptsOld: attemptsIn(60000, oldDelay),
      attemptsNew: attemptsIn(60000, newDelay),
      recoveryOld: meanRecovery(oldDelay, false),
      recoveryNewTimerOnly: meanRecovery(newDelay, false),
      recoveryNewWithOnline: meanRecovery(newDelay, true),
    };
    report(`outage 60s: ${JSON.stringify(result)}`);
    expect(result.attemptsOld).toBe(30);
    expect(result.attemptsNew).toBeLessThan(result.attemptsOld);
  });
});
