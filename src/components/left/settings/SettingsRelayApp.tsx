import { memo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { SharedSettings } from '../../../global/types';

import { selectSharedSettings } from '../../../global/selectors/sharedState';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Island, { IslandTitle } from '../../gili/layout/Island';
import Checkbox from '../../ui/Checkbox';
import ListItem from '../../ui/ListItem';
import SettingsRelayNetwork from './SettingsRelayNetwork';

type StateProps = Pick<SharedSettings, 'shouldWarmupSocialViews' | 'shouldHideX' | 'shouldHideInstagram'>;

// Настройки самого приложения (сервисы и сеть). Не зависят от входа в Telegram: окно из rail
// открывает их и тогда, когда Telegram не подключился из-за сети
const RelayAppSettingsContentComponent = ({
  shouldWarmupSocialViews,
  shouldHideX,
  shouldHideInstagram,
}: StateProps) => {
  const { setSharedSettingOption } = getActions();

  const lang = useLang();

  const handleShowXChange = useLastCallback((shouldShow: boolean) => {
    setSharedSettingOption({ shouldHideX: !shouldShow });
  });

  const handleShowInstagramChange = useLastCallback((shouldShow: boolean) => {
    setSharedSettingOption({ shouldHideInstagram: !shouldShow });
  });

  const handleWarmupSocialChange = useLastCallback((shouldWarmup: boolean) => {
    setSharedSettingOption({ shouldWarmupSocialViews: shouldWarmup });
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
        <ListItem inactive>
          <span>{lang('RelayServicesHint')}</span>
        </ListItem>
      </Island>
      <Island>
        <Checkbox
          label={lang('RelayWarmupSocial')}
          subLabel={lang('RelayWarmupSocialHint')}
          checked={shouldWarmupSocialViews !== false}
          onCheck={handleWarmupSocialChange}
        />
      </Island>

      <SettingsRelayNetwork />
    </>
  );
};

export const RelayAppSettingsContent = memo(withGlobal(
  (global): Complete<StateProps> => {
    const { shouldWarmupSocialViews, shouldHideX, shouldHideInstagram } = selectSharedSettings(global);

    return { shouldWarmupSocialViews, shouldHideX, shouldHideInstagram };
  },
)(RelayAppSettingsContentComponent));

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

// Экран в настройках Telegram (Настройки → Egoist Social)
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
