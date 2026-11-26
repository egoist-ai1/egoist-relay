// Часы планировщика. Всё, что зависит от времени (темп, паузы FLOOD_WAIT, ожидание long-poll), идёт через них,
// поэтому тесты прогоняют часы и сутки ожидания за секунды на виртуальных часах без sleep в реальном времени.

export const realClock = Object.freeze({
  virtual: false,
  now: () => Date.now(),
  /** Возвращает true, если время вышло, и false, если сон прерван сигналом. */
  sleep(ms, signal) {
    return new Promise(resolve => {
      if (signal?.aborted) { resolve(false); return; }
      const onAbort = () => { clearTimeout(timer); resolve(false); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(true); }, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
});

/**
 * Дискретно-событийные часы: время прыгает к ближайшему таймеру, когда в цикле событий больше нечего делать.
 * Годятся для кода, который ждёт только через clock.sleep, синхронные вызовы SQLite и ввод-вывод файлов.
 */
export function createVirtualClock({ start = Date.UTC(2026, 9, 8) } = {}) {
  let time = start;
  let counter = 0;
  const timers = [];
  let scheduled = false;
  // Реальный ввод-вывод в полёте (fs, DNS, пул потоков): время нельзя двигать, пока он не вернулся, иначе код,
  // который ждёт файл и таймер вперемешку, видит «будущее» раньше своих данных (плавающие тесты параллельности и роста интервала).
  const IO_PENDING = /^(FSReq|GetAddrInfo|GetNameInfo|TCPConnectWrap|PipeConnectWrap|ShutdownWrap|WriteWrap|Statwatcher|Work)/i;
  const ioPending = () => process.getActiveResourcesInfo().some(name => IO_PENDING.test(name));
  let spins = 0;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(advance);
  }
  function advance() {
    if (ioPending() && spins < 5000) {
      spins++;
      if (spins % 50 === 0) setTimeout(advance, 1); else setImmediate(advance);
      return;
    }
    spins = 0;
    scheduled = false;
    const timer = timers.shift();
    if (!timer) return;
    if (timer.at > time) time = timer.at;
    timer.done(true);
    if (timers.length) schedule();
  }
  return {
    virtual: true,
    now: () => time,
    pending: () => timers.length,
    sleep(ms, signal) {
      return new Promise(resolve => {
        if (signal?.aborted) { resolve(false); return; }
        const timer = { at: time + Math.max(0, ms), n: counter++, done: null };
        const onAbort = () => {
          const index = timers.indexOf(timer);
          if (index >= 0) timers.splice(index, 1);
          resolve(false);
        };
        timer.done = value => { signal?.removeEventListener('abort', onAbort); resolve(value); };
        let low = 0; let high = timers.length;
        while (low < high) { const mid = (low + high) >> 1; if (timers[mid].at <= timer.at) low = mid + 1; else high = mid; }
        timers.splice(low, 0, timer);
        signal?.addEventListener('abort', onAbort, { once: true });
        schedule();
      });
    },
  };
}
