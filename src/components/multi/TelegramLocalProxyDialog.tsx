import { memo, useEffect, useRef, useState } from '../../lib/teact/teact';

import type { NetworkErrorCode } from '../../util/tauri/relayNetwork';
import type { TelegramLocalProxyLink } from '../../util/tauri/telegramLocalProxy';

import { applyNetwork, getNetworkErrorKey, parseNetworkErrorCode } from '../../util/tauri/relayNetwork';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import ConfirmDialog from '../ui/ConfirmDialog';

import styles from '../left/settings/SettingsRelayNetwork.module.scss';

type OwnProps = {
  isOpen: boolean;
  proxy: TelegramLocalProxyLink;
  onClose: (url: string, wasApplied?: boolean) => void;
};

const TelegramLocalProxyDialog = ({ isOpen, proxy, onClose }: OwnProps) => {
  const lang = useLang();
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<NetworkErrorCode>();
  const isApplyingRef = useRef(false);
  const previousUrlRef = useRef(proxy.url);

  useEffect(() => {
    if (previousUrlRef.current === proxy.url) return;
    previousUrlRef.current = proxy.url;
    setError(undefined);
  }, [proxy.url]);

  const handleConfirm = useLastCallback(async () => {
    if (!isOpen || isApplyingRef.current) return;
    isApplyingRef.current = true;
    setIsApplying(true);
    setError(undefined);
    const url = proxy.url;
    try {
      await applyNetwork({ telegramLocalProxy: url });
      onClose(url, true);
    } catch (err) {
      setError(parseNetworkErrorCode(err));
    } finally {
      isApplyingRef.current = false;
      setIsApplying(false);
    }
  });

  const handleClose = useLastCallback(() => {
    if (!isApplyingRef.current) onClose(proxy.url);
  });

  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={lang('RelayNetTelegramLocalProxyConfirmTitle')}
      text={lang('RelayNetTelegramLocalProxyConfirmText', { port: String(proxy.port) })}
      confirmLabel={lang(isApplying ? 'RelayNetApplying' : 'RelayNetTelegramLocalProxyConnect')}
      isConfirmDisabled={isApplying}
      confirmHandler={handleConfirm}
      onClose={handleClose}
    >
      {error && <p className={styles.error} role="alert">{lang(getNetworkErrorKey(error))}</p>}
    </ConfirmDialog>
  );
};

export default memo(TelegramLocalProxyDialog);
