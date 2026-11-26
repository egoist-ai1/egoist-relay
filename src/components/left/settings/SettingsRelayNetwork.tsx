import type { ChangeEvent } from 'react';
import { memo, useEffect, useRef, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type {
  NetworkErrorCode, NetworkServiceId, NetworkServiceRoute, NetworkStatus,
} from '../../../util/tauri/relayNetwork';

import { copyTextToClipboard } from '../../../util/clipboard';
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
const DIAGNOSTIC_STATES = new Set<NetworkStatus['state']>([
  'starting', 'tunnel', 'dnsOnly', 'down', 'restartRequired', 'notConfigured',
]);
const DIAGNOSTIC_DNS_STATES = new Set<NetworkStatus['dohState']>(['private', 'fallback', 'down', 'none']);
const DIAGNOSTIC_ROUTES = new Set<NetworkServiceRoute>([
  'tunnel', 'direct', 'localProxy', 'unavailable', 'disabled', 'unknown',
]);
const MIN_TELEGRAM_SOCKS_PORT = 1024;
const MAX_TELEGRAM_SOCKS_PORT = 65535;

type OwnProps = {
  noTitle?: boolean;
};

const SettingsRelayNetwork = ({ noTitle }: OwnProps) => {
  const { showNotification } = getActions();

  const lang = useLang();
  const status = useNetworkStatus();

  // Введённые значения живут только в локальном состоянии и очищаются после применения
  const [vpn, setVpn] = useState('');
  const [doh, setDoh] = useState('');
  const [telegramSocksPort, setTelegramSocksPort] = useState(
    status?.telegramSocksPort ? String(status.telegramSocksPort) : '',
  );
  const [isTelegramPortInvalid, setIsTelegramPortInvalid] = useState(false);
  const [telegramProxyErrorCode, setTelegramProxyErrorCode] = useState<NetworkErrorCode>();
  const [isApplying, startApplying, stopApplying] = useFlag();
  const [isApplyingTelegramProxy, startApplyingTelegramProxy, stopApplyingTelegramProxy] = useFlag();
  const [isRemovingLocalProxy, startRemovingLocalProxy, stopRemovingLocalProxy] = useFlag();
  const [localProxyErrorCode, setLocalProxyErrorCode] = useState<NetworkErrorCode>();
  const [isRefreshing, startRefreshing, stopRefreshing] = useFlag();
  const [isResetDialogOpen, openResetDialog, closeResetDialog] = useFlag();
  const [errorCode, setErrorCode] = useState<NetworkErrorCode>();

  const stateRef = useRef<HTMLDivElement>();
  const errorRef = useRef<HTMLParagraphElement>();
  const telegramErrorRef = useRef<HTMLParagraphElement>();
  const localProxyErrorRef = useRef<HTMLParagraphElement>();
  const savedTelegramPortRef = useRef(status?.telegramSocksPort);

  const hasInput = Boolean(vpn.trim() || doh.trim());
  const isBusy = isApplying || isApplyingTelegramProxy || isRemovingLocalProxy || isRefreshing;
  const telegramPortText = telegramSocksPort.trim();
  const parsedTelegramSocksPort = telegramPortText ? Number(telegramPortText) : 0;
  const hasValidTelegramPort = !telegramPortText || (/^\d+$/.test(telegramPortText)
    && Number.isInteger(parsedTelegramSocksPort) && parsedTelegramSocksPort >= MIN_TELEGRAM_SOCKS_PORT
    && parsedTelegramSocksPort <= MAX_TELEGRAM_SOCKS_PORT);
  const hasTelegramProxyChanges = !hasValidTelegramPort
    || parsedTelegramSocksPort !== (status?.telegramSocksPort || 0);

  useEffect(() => {
    if (errorCode) errorRef.current?.focus();
  }, [errorCode]);

  useEffect(() => {
    if (savedTelegramPortRef.current === status?.telegramSocksPort) return;
    savedTelegramPortRef.current = status?.telegramSocksPort;
    setTelegramSocksPort(status?.telegramSocksPort ? String(status.telegramSocksPort) : '');
  }, [status?.telegramSocksPort]);

  useEffect(() => {
    if (isTelegramPortInvalid || telegramProxyErrorCode) telegramErrorRef.current?.focus();
  }, [isTelegramPortInvalid, telegramProxyErrorCode]);

  useEffect(() => {
    if (localProxyErrorCode) localProxyErrorRef.current?.focus();
  }, [localProxyErrorCode]);

  const handleVpnChange = useLastCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setVpn(e.currentTarget.value);
  });

  const handleDohChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setDoh(e.currentTarget.value);
  });

  const handleTelegramSocksChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setTelegramSocksPort(e.currentTarget.value);
    setIsTelegramPortInvalid(false);
    setTelegramProxyErrorCode(undefined);
  });

  const handleApplyTelegramProxy = useLastCallback(async () => {
    if (isBusy) return;
    setIsTelegramPortInvalid(!hasValidTelegramPort);
    setTelegramProxyErrorCode(undefined);
    if (!hasValidTelegramPort) return;
    startApplyingTelegramProxy();
    try {
      await applyNetwork({ telegramSocksPort: parsedTelegramSocksPort });
      showNotification({ message: { key: 'RelayNetTelegramSocksApplied' } });
      stateRef.current?.focus();
    } catch (err) {
      setTelegramProxyErrorCode(parseNetworkErrorCode(err));
    } finally {
      stopApplyingTelegramProxy();
    }
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

  const handleRemoveLocalProxy = useLastCallback(async () => {
    if (isBusy) return;
    startRemovingLocalProxy();
    setLocalProxyErrorCode(undefined);
    try {
      await applyNetwork({ telegramLocalProxy: '' });
      showNotification({ message: { key: 'RelayNetTelegramLocalProxyRemoved' } });
      stateRef.current?.focus();
    } catch (err) {
      setLocalProxyErrorCode(parseNetworkErrorCode(err));
    } finally {
      stopRemovingLocalProxy();
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

  const handleCopyDiagnostics = useLastCallback(() => {
    if (!status) return;
    let telegramProxyMode = status.telegramSocksPort ? 'localSocks' : 'automatic';
    if (status.telegramLocalProxyPort) telegramProxyMode = 'localMtproto';
    const diagnostics = {
      app: 'beresta',
      version: APP_VERSION,
      state: DIAGNOSTIC_STATES.has(status.state) ? status.state : 'unknown',
      dns: DIAGNOSTIC_DNS_STATES.has(status.dohState) ? status.dohState : 'unknown',
      telegramProxyMode,
      services: Object.fromEntries(SERVICE_IDS.map(({ id }) => [
        id, DIAGNOSTIC_ROUTES.has(status.services[id]) ? status.services[id] : 'unknown',
      ])),
      connectionError: status.lastError ? parseNetworkErrorCode(status.lastError) : undefined,
      settingsError: errorCode,
      telegramProxyError: telegramProxyErrorCode,
      localProxyError: localProxyErrorCode,
    };
    let isCopied = false;
    try {
      isCopied = copyTextToClipboard(JSON.stringify(diagnostics, undefined, 2));
    } catch { /* Ошибка буфера обмена отображается через уведомление */ }
    showNotification({ message: { key: isCopied ? 'RelayNetDiagnosticsCopied' : 'RelayNetDiagnosticsCopyFailed' } });
  });

  if (!status) return undefined;

  return (
    <>
      {!noTitle && <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('RelayNetworkTitle')}</IslandTitle>}
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
        <div className={styles.actions}>
          <Button size="smaller" color="translucent" onClick={handleCopyDiagnostics}>
            {lang('RelayNetCopyDiagnostics')}
          </Button>
          {status.source === 'override' && (
            <Button size="smaller" color="translucent" disabled={isBusy} onClick={openResetDialog}>
              {lang('RelayNetResetEmbedded')}
            </Button>
          )}
        </div>
      </Island>

      {Boolean(status.telegramLocalProxyPort) && (
        <>
          <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
            {lang('RelayNetTelegramLocalProxyTitle')}
          </IslandTitle>
          <Island>
            <div className={styles.state}>
              {lang('RelayNetTelegramLocalProxyEndpoint', { port: String(status.telegramLocalProxyPort) })}
            </div>
            <IslandDescription>{lang('RelayNetTelegramLocalProxyHint')}</IslandDescription>
            {localProxyErrorCode && (
              <p ref={localProxyErrorRef} className={styles.error} role="alert" tabIndex={-1}>
                {lang(getNetworkErrorKey(localProxyErrorCode))}
              </p>
            )}
            <div className={styles.actions}>
              <Button color="translucent" disabled={isBusy} onClick={handleRemoveLocalProxy}>
                {lang('RelayNetTelegramLocalProxyRemove')}
              </Button>
            </div>
          </Island>
        </>
      )}

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('RelayNetTelegramProxyTitle')}</IslandTitle>
      <Island>
        <div className={styles.fields}>
          <InputText
            id="relay-network-telegram-socks"
            label={lang('RelayNetTelegramSocksPort')}
            value={telegramSocksPort}
            autoComplete="off"
            inputMode="numeric"
            disabled={isBusy}
            onChange={handleTelegramSocksChange}
          />
        </div>
        <IslandDescription>{lang('RelayNetTelegramSocksHint')}</IslandDescription>
        {(isTelegramPortInvalid || telegramProxyErrorCode) && (
          <p ref={telegramErrorRef} className={styles.error} role="alert" tabIndex={-1}>
            {lang(isTelegramPortInvalid
              ? 'RelayNetTelegramSocksInvalidPort' : getNetworkErrorKey(telegramProxyErrorCode!))}
          </p>
        )}
        <div className={styles.actions}>
          <Button
            disabled={!hasTelegramProxyChanges || isBusy}
            ariaLabel={lang('RelayNetTelegramSocksApply')}
            onClick={handleApplyTelegramProxy}
          >
            {lang(isApplyingTelegramProxy ? 'RelayNetApplying' : 'RelayNetApply')}
          </Button>
        </div>
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
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23',
  }).format(new Date(timestamp));
}

export default memo(SettingsRelayNetwork);
