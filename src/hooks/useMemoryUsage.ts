import { useEffect, useState } from '../lib/teact/teact';

import type { MemoryUsage } from '../util/tauri/relayMemory';

import { IS_TAURI } from '../util/browser/globalEnvironment';
import { getMemoryUsage } from '../util/tauri/relayMemory';

const REFRESH_INTERVAL = 10000;

// Память приложения для плашки заголовка: опрос раз в 10 с, пока окно видно, без пересечения запросов
export default function useMemoryUsage() {
  const [usage, setUsage] = useState<MemoryUsage | undefined>();

  useEffect(() => {
    if (!IS_TAURI) return undefined;

    let isActive = true;
    let isBusy = false;
    let last: MemoryUsage | undefined;

    async function refresh() {
      if (isBusy || document.hidden) return;
      isBusy = true;
      try {
        const next = await getMemoryUsage();
        // Одинаковое значение не перерисовывает заголовок
        if (isActive && next && (last?.bytes !== next.bytes || last.processes !== next.processes)) {
          last = next;
          setUsage(next);
        }
      } catch {
        // Плашка памяти необязательна: при ошибке остаётся последнее значение
      } finally {
        isBusy = false;
      }
    }

    refresh();
    const timer = window.setInterval(refresh, REFRESH_INTERVAL);
    document.addEventListener('visibilitychange', refresh);

    return () => {
      isActive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  return usage;
}
