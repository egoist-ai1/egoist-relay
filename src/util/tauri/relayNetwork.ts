import type { RegularLangKey } from '../../types/language';

import { IS_TAURI } from '../browser/globalEnvironment';

export type NetworkState = 'starting' | 'tunnel' | 'dnsOnly' | 'down' | 'restartRequired' | 'notConfigured';
export type NetworkServiceId = 'telegram' | 'x' | 'instagram';
export type NetworkServiceRoute = 'tunnel' | 'direct' | 'localProxy' | 'unavailable' | 'disabled' | 'unknown';

// Значения ключей, URL подписок и DoH во фронтенд не приходят: только метки и хосты
export type NetworkStatus = {
  state: NetworkState;
  source: 'embedded' | 'override' | 'none';
  vpnKind: 'link' | 'subscription' | 'none';
  nodeLabel?: string;
  nodeCount: number;
  dohState: 'private' | 'fallback' | 'down' | 'none';
  dohHost?: string;
  hasMtproxy: boolean;
  services: Record<NetworkServiceId, NetworkServiceRoute>;
  subscriptionUpdatedAt?: number;
  lastError?: string;
};

export type NetworkApplyInput = { vpn?: string; doh?: string; mtproxy?: string };

const NETWORK_ERROR_CODES = [
  'INVALID_VPN', 'INVALID_DOH', 'INVALID_MTPROXY', 'PROBE_FAILED', 'APPLY_FAILED', 'SUBSCRIPTION_FAILED',
] as const;
export type NetworkErrorCode = typeof NETWORK_ERROR_CODES[number] | 'UNKNOWN';

const STATUS_EVENT = 'relay-network-status';

const ERROR_KEYS: Record<NetworkErrorCode, RegularLangKey> = {
  INVALID_VPN: 'RelayNetErrInvalidVpn',
  INVALID_DOH: 'RelayNetErrInvalidDoh',
  INVALID_MTPROXY: 'RelayNetErrInvalidMtproxy',
  PROBE_FAILED: 'RelayNetErrProbeFailed',
  APPLY_FAILED: 'RelayNetErrApplyFailed',
  SUBSCRIPTION_FAILED: 'RelayNetErrSubscription',
  UNKNOWN: 'RelayNetErrUnknown',
};

const STATE_KEYS: Record<NetworkState, RegularLangKey> = {
  starting: 'RelayNetStateStarting',
  tunnel: 'RelayNetStateTunnel',
  dnsOnly: 'RelayNetStateDnsOnly',
  down: 'RelayNetStateDown',
  restartRequired: 'RelayNetStateRestart',
  notConfigured: 'RelayNetStateNotConfigured',
};

const ROUTE_KEYS: Record<NetworkServiceRoute, RegularLangKey> = {
  tunnel: 'RelayNetRouteTunnel',
  direct: 'RelayNetRouteDirect',
  localProxy: 'RelayNetRouteLocalProxy',
  unavailable: 'RelayNetRouteUnavailable',
  disabled: 'RelayNetRouteDisabled',
  unknown: 'RelayNetRouteUnknown',
};

export const NOT_CONFIGURED_STATUS: NetworkStatus = {
  state: 'notConfigured',
  source: 'none',
  vpnKind: 'none',
  nodeCount: 0,
  dohState: 'none',
  hasMtproxy: false,
  services: { telegram: 'unknown', x: 'unknown', instagram: 'unknown' },
};

let currentStatus: NetworkStatus | undefined;
let isWatching = false;
const subscribers = new Set<(status: NetworkStatus) => void>();

export function getNetworkStateKey(state: NetworkState) {
  return STATE_KEYS[state];
}

export function getNetworkRouteKey(route: NetworkServiceRoute) {
  return ROUTE_KEYS[route];
}

export function getNetworkErrorKey(code: NetworkErrorCode) {
  return ERROR_KEYS[code];
}

// Дополняет ответ оболочки значениями по умолчанию, чтобы интерфейс не падал на неполной нагрузке
export function normalizeNetworkStatus(raw: unknown): NetworkStatus {
  if (!raw || typeof raw !== 'object') return NOT_CONFIGURED_STATUS;
  const payload = raw as Partial<NetworkStatus>;
  return {
    ...NOT_CONFIGURED_STATUS,
    ...payload,
    services: { ...NOT_CONFIGURED_STATUS.services, ...payload.services },
  };
}

// Tauri отдаёт ошибку команды строкой-кодом или объектом; ищем известный код в любом виде
export function parseNetworkErrorCode(error: unknown): NetworkErrorCode {
  let text = '';
  if (typeof error === 'string') {
    text = error;
  } else if (error instanceof Error) {
    text = error.message;
  } else if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    text = [code, message].filter((part) => typeof part === 'string').join(' ');
  }
  return NETWORK_ERROR_CODES.find((code) => text.includes(code)) ?? 'UNKNOWN';
}

export function getCachedNetworkStatus() {
  return currentStatus;
}

// Подписчик получает последний известный статус сразу, затем каждое событие оболочки
export function watchNetworkStatus(callback: (status: NetworkStatus) => void) {
  subscribers.add(callback);
  if (currentStatus) callback(currentStatus);
  startWatching();
  return () => {
    subscribers.delete(callback);
  };
}

export async function getNetworkStatus(shouldPublish = true) {
  return invokeNetwork('relay_network_status', undefined, shouldPublish);
}

// Только заполненные поля: пустая строка на стороне оболочки очищает замену поля
export async function applyNetwork(input: NetworkApplyInput) {
  if (!IS_TAURI) throw new Error('APPLY_FAILED');
  return invokeNetwork('relay_network_apply', {
    vpn: input.vpn || undefined,
    doh: input.doh || undefined,
  });
}

export async function resetNetwork() {
  return invokeNetwork('relay_network_reset');
}

export async function refreshSubscription() {
  if (!IS_TAURI) throw new Error('SUBSCRIPTION_FAILED');
  return invokeNetwork('relay_network_refresh_subscription');
}

export async function setServiceEnabled(service: 'x' | 'instagram', isEnabled: boolean) {
  return invokeNetwork('relay_network_set_service_enabled', { service, enabled: isEnabled });
}

async function invokeNetwork(command: string, args?: Record<string, unknown>, shouldPublish = true) {
  if (!IS_TAURI) return NOT_CONFIGURED_STATUS;
  const { invoke } = await import('@tauri-apps/api/core');
  const status = normalizeNetworkStatus(await invoke(command, args));
  if (shouldPublish) publish(status);
  return status;
}

function publish(status: NetworkStatus) {
  currentStatus = status;
  subscribers.forEach((callback) => callback(status));
}

function startWatching() {
  if (isWatching) return;
  isWatching = true;

  if (!IS_TAURI) {
    publish(NOT_CONFIGURED_STATUS);
    return;
  }

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      await listen<unknown>(STATUS_EVENT, ({ payload }) => publish(normalizeNetworkStatus(payload)));
    } catch {
      // Без оболочки остаётся состояние «не задан»
      publish(NOT_CONFIGURED_STATUS);
      return;
    }
    try {
      const initial = await getNetworkStatus(false);
      // Событие могло прийти раньше ответа команды: свежее не перезаписываем
      if (!currentStatus) publish(initial);
    } catch {
      if (!currentStatus) publish(NOT_CONFIGURED_STATUS);
    }
  })();
}
