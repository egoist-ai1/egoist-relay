import { IS_TAURI } from '../browser/globalEnvironment';

// Память всех процессов приложения (оболочка, WebView2 сервисов, Node, Xray, tg-ws-proxy)
export type MemoryUsage = { bytes: number; processes: number };

const MB = 1024 * 1024;

export function normalizeMemoryUsage(raw: unknown): MemoryUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { bytes, processes } = raw as Record<string, unknown>;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  return { bytes, processes: typeof processes === 'number' && processes > 0 ? Math.floor(processes) : 0 };
}

export async function getMemoryUsage() {
  if (!IS_TAURI) return undefined;
  const { invoke } = await import('@tauri-apps/api/core');
  return normalizeMemoryUsage(await invoke('relay_memory_usage'));
}

// До гигабайта — целые мегабайты, дальше один знак после запятой (по-русски запятая)
export function splitMemory(bytes: number): { unit: 'mb' | 'gb'; value: string } {
  const megabytes = bytes / MB;
  if (megabytes < 1024) return { unit: 'mb', value: String(Math.max(1, Math.round(megabytes))) };
  return { unit: 'gb', value: (megabytes / 1024).toFixed(1).replace('.', ',') };
}
