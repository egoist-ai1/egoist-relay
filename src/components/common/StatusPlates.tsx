import { memo } from '../../lib/teact/teact';

import type { NetworkState, NetworkStatus } from '../../util/tauri/relayNetwork';

import useLang from '../../hooks/useLang';

import styles from './StatusPlates.module.scss';

type OwnProps = {
  network?: NetworkStatus;
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

const StatusPlates = ({ network, onOpenNetworkSettings }: OwnProps) => {
  const lang = useLang();
  if (!network) return undefined;

  const networkLabel = lang(NETWORK_LABELS[network.state]);
  const networkTitle = lang('RelayPlateNetworkTitle', { state: networkLabel });

  return (
    <button
      type="button"
      className={styles.plate}
      title={networkTitle}
      aria-label={networkTitle}
      data-level={NETWORK_LEVELS[network.state]}
      onClick={onOpenNetworkSettings}
      disabled={!onOpenNetworkSettings}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.label}>{networkLabel}</span>
    </button>
  );
};

export default memo(StatusPlates);
