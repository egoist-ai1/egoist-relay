import { memo } from '../../lib/teact/teact';

import type { LangFn } from '../../util/localization';
import type { MemoryUsage } from '../../util/tauri/relayMemory';
import type { NetworkState, NetworkStatus } from '../../util/tauri/relayNetwork';

import buildClassName from '../../util/buildClassName';
import { splitMemory } from '../../util/tauri/relayMemory';

import useLang from '../../hooks/useLang';

import styles from './StatusPlates.module.scss';

type OwnProps = {
  network?: NetworkStatus;
  memory?: MemoryUsage;
  onOpenNetworkSettings?: NoneToVoidFunction;
};

type PlateLevel = 'ok' | 'warn' | 'down';

const NETWORK_LABELS = {
  tunnel: 'RelayPlateNetTunnel',
  dnsOnly: 'RelayPlateNetDnsOnly',
  down: 'RelayPlateNetDown',
  starting: 'RelayPlateNetStarting',
  restartRequired: 'RelayPlateNetRestart',
  notConfigured: 'RelayPlateNetNone',
} as const satisfies Record<NetworkState, string>;

// Монохром: смысл несёт текст и форма точки (заливка, кольцо, пунктир), а не цвет
const NETWORK_LEVELS: Record<NetworkState, PlateLevel> = {
  tunnel: 'ok',
  notConfigured: 'ok',
  starting: 'warn',
  dnsOnly: 'warn',
  restartRequired: 'warn',
  down: 'down',
};

export function formatMemory(lang: LangFn, usage: MemoryUsage) {
  const { unit, value } = splitMemory(usage.bytes);
  return lang(unit === 'gb' ? 'RelayPlateMemoryGb' : 'RelayPlateMemoryMb', { value });
}

// Плашки рамки: сеть (нажатие открывает настройки сети) и память всех процессов приложения
const StatusPlates = ({ network, memory, onOpenNetworkSettings }: OwnProps) => {
  const lang = useLang();
  if (!network && !memory) return undefined;

  const memoryText = memory && formatMemory(lang, memory);
  const networkLabel = network && lang(NETWORK_LABELS[network.state]);
  const networkTitle = networkLabel && lang('RelayPlateNetworkTitle', { state: networkLabel });
  const memoryTitle = memory && memoryText
    && lang('RelayPlateMemoryTitle', { size: memoryText, count: memory.processes });

  return (
    <div className={styles.plates} role="group" aria-label={lang('RelayPlateGroup')}>
      {network && networkLabel && (
        <button
          type="button"
          className={buildClassName(styles.plate, styles.interactive)}
          title={networkTitle}
          aria-label={networkTitle}
          data-level={NETWORK_LEVELS[network.state]}
          onClick={onOpenNetworkSettings}
          disabled={!onOpenNetworkSettings}
        >
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.label}>{networkLabel}</span>
        </button>
      )}
      {memory && memoryText && (
        <span className={buildClassName(styles.plate, styles.memory)} title={memoryTitle} role="status">
          <span className={styles.label}>{memoryText}</span>
        </span>
      )}
    </div>
  );
};

export default memo(StatusPlates);
