import type { ChangeEvent } from 'react';
import { memo, useEffect, useRef, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { NetworkErrorCode, NetworkServiceId, NetworkStatus } from '../../../util/tauri/relayNetwork';

import {
  applyNetwork, getNetworkErrorKey, getNetworkRouteKey, getNetworkStateKey, parseNetworkErrorCode,
  refreshSubscription, resetNetwork,
} from '../../../util/tauri/relayNetwork';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useNetworkStatus from '../../../hooks/useNetworkStatus';

import Island, { IslandDescription, IslandTitle } from '../../gili/layout/Island';
import Button from '../../ui/Button';
import ConfirmDialog from '../../ui/ConfirmDialog';
import InputText from '../../ui/InputText';
import TextArea from '../../ui/TextArea';

import styles from './SettingsRelayNetwork.module.scss';

type ServiceTitleKey = 'RelayTelegramTitle' | 'RelayXTitle' | 'RelayInstagramTitle';

const SERVICE_IDS: { id: NetworkServiceId; titleKey: ServiceTitleKey }[] = [
  { id: 'telegram', titleKey: 'RelayTelegramTitle' },
  { id: 'x', titleKey: 'RelayXTitle' },
  { id: 'instagram', titleKey: 'RelayInstagramTitle' },
];

const SettingsRelayNetwork = () => {
  const { showNotification } = getActions();

  const lang = useLang();
  const status = useNetworkStatus();

  // Введённые значения живут только в локальном состоянии и очищаются после применения
  const [vpn, setVpn] = useState('');
  const [doh, setDoh] = useState('');
  const [isApplying, startApplying, stopApplying] = useFlag();
  const [isRefreshing, startRefreshing, stopRefreshing] = useFlag();
  const [isResetDialogOpen, openResetDialog, closeResetDialog] = useFlag();
  const [errorCode, setErrorCode] = useState<NetworkErrorCode>();

  const stateRef = useRef<HTMLDivElement>();
  const errorRef = useRef<HTMLParagraphElement>();

  const hasInput = Boolean(vpn.trim() || doh.trim());
  const isBusy = isApplying || isRefreshing;

  useEffect(() => {
    if (errorCode) errorRef.current?.focus();
  }, [errorCode]);

  const handleVpnChange = useLastCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setVpn(e.currentTarget.value);
  });

  const handleDohChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setDoh(e.currentTarget.value);
  });

  const handleApply = useLastCallback(async () => {
    if (!hasInput || isBusy) return;
    setErrorCode(undefined);
    startApplying();
    try {
      await applyNetwork({ vpn: vpn.trim(), doh: doh.trim() });
      setVpn('');
      setDoh('');
      showNotification({ message: { key: 'RelayNetApplied' } });
      stateRef.current?.focus();
    } catch (err) {
      setErrorCode(parseNetworkErrorCode(err));
    } finally {
      stopApplying();
    }
  });

  const handleRefresh = useLastCallback(async () => {
    if (isBusy) return;
    setErrorCode(undefined);
    startRefreshing();
    try {
      await refreshSubscription();
      showNotification({ message: { key: 'RelayNetSubDone' } });
    } catch (err) {
      setErrorCode(parseNetworkErrorCode(err));
    } finally {
      stopRefreshing();
    }
  });

  const handleResetConfirm = useLastCallback(async () => {
    closeResetDialog();
    setErrorCode(undefined);
    try {
      await resetNetwork();
      showNotification({ message: { key: 'RelayNetResetDone' } });
      stateRef.current?.focus();
    } catch (err) {
      setErrorCode(parseNetworkErrorCode(err));
    }
  });

  if (!status) return undefined;

  return (
    <>
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('RelayNetworkTitle')}</IslandTitle>
      <Island aria-live="polite">
        <div ref={stateRef} className={styles.state} tabIndex={-1}>{lang(getNetworkStateKey(status.state))}</div>
        <dl className={styles.rows}>
          {renderRow(lang('RelayNetKey'), renderSourceLabel(status))}
          {status.nodeLabel && renderRow(lang('RelayNetNode'), renderNodeLabel(status))}
          {renderRow(lang('RelayNetDns'), renderDnsLabel(status))}
          {SERVICE_IDS.map(({ id, titleKey }) => (
            renderRow(lang(titleKey), lang(getNetworkRouteKey(status.services[id])))
          ))}
        </dl>
        {status.source === 'override' && (
          <div className={styles.actions}>
            <Button size="smaller" color="translucent" disabled={isBusy} onClick={openResetDialog}>
              {lang('RelayNetResetEmbedded')}
            </Button>
          </div>
        )}
      </Island>

      {status.vpnKind === 'subscription' && (
        <Island>
          <IslandDescription>
            {status.subscriptionUpdatedAt
              ? lang('RelayNetSubUpdated', { date: formatUpdatedAt(status.subscriptionUpdatedAt, lang.code) })
              : lang('RelayNetSubNever')}
          </IslandDescription>
          <div className={styles.actions}>
            <Button size="smaller" color="translucent" disabled={isBusy} onClick={handleRefresh}>
              {lang(isRefreshing ? 'RelayNetRefreshing' : 'RelayNetRefreshSub')}
            </Button>
          </div>
        </Island>
      )}

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('RelayNetReplaceTitle')}</IslandTitle>
      <Island>
        <div className={styles.fields}>
          <TextArea
            id="relay-network-vpn"
            label={lang('RelayNetVpnLabel')}
            value={vpn}
            autoComplete="off"
            noReplaceNewlines
            disabled={isBusy}
            onChange={handleVpnChange}
          />
          <InputText
            id="relay-network-doh"
            label={lang('RelayNetDohLabel')}
            value={doh}
            autoComplete="off"
            inputMode="url"
            disabled={isBusy}
            onChange={handleDohChange}
          />
        </div>
        <IslandDescription>{lang('RelayNetVpnHint')}</IslandDescription>
        {errorCode && (
          <p ref={errorRef} className={styles.error} role="alert" tabIndex={-1}>
            {lang(getNetworkErrorKey(errorCode))}
          </p>
        )}
        <div className={styles.actions}>
          <Button disabled={!hasInput || isBusy} onClick={handleApply}>
            {lang('RelayNetApply')}
          </Button>
          {isApplying && (
            <span className={styles.progress} role="status">
              <span className={styles.spinner} aria-hidden="true" />
              {lang('RelayNetApplying')}
            </span>
          )}
        </div>
      </Island>

      <ConfirmDialog
        isOpen={isResetDialogOpen}
        onClose={closeResetDialog}
        title={lang('RelayNetResetTitle')}
        text={lang('RelayNetResetText')}
        confirmLabel={lang('RelayNetResetConfirm')}
        confirmHandler={handleResetConfirm}
      />
    </>
  );

  function renderSourceLabel(currentStatus: NetworkStatus) {
    if (currentStatus.source === 'embedded') return lang('RelayNetKeyEmbedded');
    if (currentStatus.source === 'override') return lang('RelayNetKeyOverride');
    return lang('RelayNetKeyNone');
  }

  function renderNodeLabel(currentStatus: NetworkStatus) {
    return currentStatus.nodeCount > 1
      ? `${currentStatus.nodeLabel} · ${lang('RelayNetNodeCount', { count: currentStatus.nodeCount })}`
      : currentStatus.nodeLabel;
  }

  function renderDnsLabel(currentStatus: NetworkStatus) {
    if (currentStatus.dohState === 'private') return lang('RelayNetDnsPrivate', { host: currentStatus.dohHost || '—' });
    if (currentStatus.dohState === 'fallback') return lang('RelayNetDnsFallback');
    if (currentStatus.dohState === 'down') return lang('RelayNetDnsDown');
    return lang('RelayNetDnsNone');
  }
};

function renderRow(label: string, value?: string) {
  return (
    <div className={styles.row} key={label}>
      <dt className={styles.rowLabel}>{label}</dt>
      <dd className={styles.rowValue}>{value}</dd>
    </div>
  );
}

function formatUpdatedAt(timestamp: number, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

export default memo(SettingsRelayNetwork);
