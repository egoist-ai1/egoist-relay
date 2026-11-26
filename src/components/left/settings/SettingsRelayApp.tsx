import { memo, useRef, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { SharedSettings } from '../../../global/types';

import { selectSharedSettings } from '../../../global/selectors/sharedState';
import { IS_TAURI } from '../../../util/browser/globalEnvironment';
import { IS_WINDOWS } from '../../../util/browser/windowEnvironment';
import { copyTextToClipboard } from '../../../util/clipboard';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Island, { IslandDescription, IslandTitle } from '../../gili/layout/Island';
import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';

import styles from './SettingsRelayApp.module.scss';

type StateProps = Pick<SharedSettings, 'shouldWarmupVisibleSocialViews' | 'shouldHideX' | 'shouldHideInstagram'>;

type McpCopyState = 'preparing' | 'copied' | 'manual' | 'unavailable';

const MCP_COPY_STATUS_KEY = {
  preparing: 'RelayMcpPreparing',
  copied: 'RelayMcpCopied',
  manual: 'RelayMcpCopyManual',
  unavailable: 'RelayMcpUnavailable',
} as const;

const RelayMcpSettings = () => {
  const lang = useLang();
  const isPreparingRef = useRef(false);
  const [copyState, setCopyState] = useState<McpCopyState>();
  const [manualConfig, setManualConfig] = useState<string>();

  const handleCopyConfig = useLastCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isPreparingRef.current) return;
    const trigger = event.currentTarget;

    isPreparingRef.current = true;
    setCopyState('preparing');
    setManualConfig(undefined);

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const { command, args } = await invoke<{ command: string; args: string[] }>('relay_mcp_launch_config');
      const config = JSON.stringify({ mcpServers: { beresta: { command, args } } }, undefined, 2);

      const shouldRestoreFocus = document.activeElement === trigger;
      let isCopied = false;
      try {
        isCopied = copyTextToClipboard(config);
      } catch {
        // Конфигурация остаётся доступной в поле для ручного копирования
      }
      if (shouldRestoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
      if (!isCopied) setManualConfig(config);
      setCopyState(isCopied ? 'copied' : 'manual');
    } catch {
      setCopyState('unavailable');
    } finally {
      isPreparingRef.current = false;
    }
  });

  return (
    <>
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('RelayMcpTitle')}</IslandTitle>
      <Island>
        <IslandDescription>{lang('RelayMcpDescription')}</IslandDescription>
        <div className={styles.mcpControls}>
          <Button
            className={styles.copyConfig}
            color="translucent"
            iconName="copy"
            noForcedUpperCase
            onClick={handleCopyConfig}
          >
            {lang('RelayMcpCopyConfig')}
          </Button>
          {manualConfig && (
            <textarea
              aria-label={lang('RelayMcpConfigLabel')}
              className={styles.mcpConfig}
              dir="ltr"
              readOnly
              rows={7}
              value={manualConfig}
            />
          )}
          <div className={styles.mcpStatus} role="status">
            {copyState && lang(MCP_COPY_STATUS_KEY[copyState])}
          </div>
        </div>
      </Island>
    </>
  );
};

// Настройки «Бересты» доступны до подключения аккаунта Telegram
const RelayAppSettingsContentComponent = ({
  shouldWarmupVisibleSocialViews,
  shouldHideX,
  shouldHideInstagram,
}: StateProps) => {
  const { setSharedSettingOption } = getActions();

  const lang = useLang();
  const hasVisibleSocialService = !shouldHideX || !shouldHideInstagram;

  const handleShowXChange = useLastCallback((shouldShow: boolean) => {
    setSharedSettingOption({ shouldHideX: !shouldShow });
  });

  const handleShowInstagramChange = useLastCallback((shouldShow: boolean) => {
    setSharedSettingOption({ shouldHideInstagram: !shouldShow });
  });

  const handleWarmupSocialChange = useLastCallback((shouldWarmup: boolean) => {
    setSharedSettingOption({ shouldWarmupVisibleSocialViews: shouldWarmup });
  });

  return (
    <>
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('RelayServicesTitle')}</IslandTitle>
      <Island>
        <Checkbox
          label={lang('RelayShowX')}
          checked={!shouldHideX}
          onCheck={handleShowXChange}
        />
        <Checkbox
          label={lang('RelayShowInstagram')}
          checked={!shouldHideInstagram}
          onCheck={handleShowInstagramChange}
        />
      </Island>
      {IS_TAURI && IS_WINDOWS && <RelayMcpSettings />}
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('RelayAppStartupTitle')}</IslandTitle>
      <Island>
        <Checkbox
          label={lang('RelayWarmupSocial')}
          subLabel={lang(hasVisibleSocialService ? 'RelayWarmupSocialHint' : 'RelayAppWarmupUnavailable')}
          checked={shouldWarmupVisibleSocialViews === true}
          disabled={!hasVisibleSocialService}
          onCheck={handleWarmupSocialChange}
        />
      </Island>
    </>
  );
};

export const RelayAppSettingsContent = memo(withGlobal(
  (global): Complete<StateProps> => {
    const { shouldWarmupVisibleSocialViews, shouldHideX, shouldHideInstagram } = selectSharedSettings(global);

    return { shouldWarmupVisibleSocialViews, shouldHideX, shouldHideInstagram };
  },
)(RelayAppSettingsContentComponent));

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

// Экран в настройках Telegram (Настройки → Береста)
const SettingsRelayApp = ({ isActive, onReset }: OwnProps) => {
  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  return (
    <div className="settings-content custom-scroll">
      <RelayAppSettingsContent />
    </div>
  );
};

export default memo(SettingsRelayApp);
