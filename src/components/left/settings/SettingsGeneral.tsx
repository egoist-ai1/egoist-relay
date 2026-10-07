import {
  memo, useCallback, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { SharedSettings } from '../../../global/types';
import type { TimeFormat } from '../../../types';
import type { IRadioOption } from '../../ui/RadioGroup';
import { SettingsScreens } from '../../../types';

import { selectSharedSettings } from '../../../global/selectors/sharedState';
import {
  ANTIGRAVITY_THEMES, applyAntigravityTheme, getActiveThemeVariantId,
} from '../../../util/antigravityThemes';
import applyMessageTextSize from '../../../util/applyMessageTextSize';
import {
  IS_ANDROID, IS_IOS, IS_MAC_OS,
} from '../../../util/browser/windowEnvironment';

import useAppLayout from '../../../hooks/useAppLayout';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Island, { IslandTitle } from '../../gili/layout/Island';
import Checkbox from '../../ui/Checkbox';
import ListItem from '../../ui/ListItem';
import RadioGroup from '../../ui/RadioGroup';
import RangeSlider from '../../ui/RangeSlider';

import styles from './SettingsGeneral.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps =
  Pick<SharedSettings, (
    'messageTextSize' |
    'messageSendKeyCombo' |
    'shouldReplaceTextShortcuts' |
    'timeFormat' |
    'theme' |
    'shouldUseSystemTheme'
  )>;

const SettingsGeneral = ({
  isActive,
  messageTextSize,
  messageSendKeyCombo,
  shouldReplaceTextShortcuts,
  timeFormat,
  theme,
  shouldUseSystemTheme,
  onReset,
}: OwnProps & StateProps) => {
  const {
    setSharedSettingOption, openSettingsScreen,
  } = getActions();

  const lang = useLang();

  const { isMobile } = useAppLayout();
  const isMobileDevice = isMobile && (IS_IOS || IS_ANDROID);

  const timeFormatOptions: IRadioOption[] = [{
    label: lang('SettingsTimeFormat12'),
    value: '12h',
  }, {
    label: lang('SettingsTimeFormat24'),
    value: '24h',
  }];

  const [activeVariant, setActiveVariant] = useState(getActiveThemeVariantId);

  const antigravityDarkOptions: IRadioOption[] = useMemo(() => {
    return ANTIGRAVITY_THEMES.filter((t) => t.category === 'dark').map((t) => ({
      label: t.name,
      value: t.id,
    }));
  }, []);

  const antigravityLightOptions: IRadioOption[] = useMemo(() => {
    return ANTIGRAVITY_THEMES.filter((t) => t.category === 'light').map((t) => ({
      label: t.name,
      value: t.id,
    }));
  }, []);

  const handleThemeVariantChange = useCallback((variantId: string) => {
    setActiveVariant(variantId);
    applyAntigravityTheme(variantId);
    const def = ANTIGRAVITY_THEMES.find((t) => t.id === variantId);
    if (def) {
      setSharedSettingOption({ theme: def.base });
      setSharedSettingOption({ shouldUseSystemTheme: false });
    }
  }, [setSharedSettingOption]);

  const keyboardSendOptions = !isMobileDevice ? [
    { value: 'enter', label: lang('SettingsSendEnter'), subLabel: lang('SettingsSendEnterDescription') },
    {
      value: 'ctrl-enter',
      label: lang(IS_MAC_OS || IS_IOS ? 'SettingsSendCmdenter' : 'SettingsSendCtrlenter'),
      subLabel: lang('SettingsSendPlusEnterDescription'),
    },
  ] : undefined;

  const handleMessageTextSizeChange = useCallback((newSize: number) => {
    applyMessageTextSize(newSize);

    setSharedSettingOption({ messageTextSize: newSize });
  }, []);

  const handleTimeFormatChange = useCallback((newTimeFormat: string) => {
    setSharedSettingOption({ timeFormat: newTimeFormat as TimeFormat });
    setSharedSettingOption({ wasTimeFormatSetManually: true });
  }, []);

  const handleMessageSendComboChange = useCallback((newCombo: string) => {
    setSharedSettingOption({ messageSendKeyCombo: newCombo as SharedSettings['messageSendKeyCombo'] });
  }, []);

  const handleTextShortcutReplacementChange = useLastCallback((shouldReplace: boolean) => {
    setSharedSettingOption({ shouldReplaceTextShortcuts: shouldReplace });
  });

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  return (
    <div className="settings-content custom-scroll">
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('Settings')}</IslandTitle>
      <Island>
        <RangeSlider
          label={lang('TextSize')}
          min={12}
          max={20}
          value={messageTextSize}
          onChange={handleMessageTextSizeChange}
        />
        <ListItem
          icon="photo"
          narrow
          onClick={() => openSettingsScreen({ screen: SettingsScreens.GeneralChatBackground })}
        >
          {lang('ChatBackground')}
        </ListItem>
      </Island>

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('RelayThemeVariants')}</IslandTitle>
      <Island>
        <div className={styles.themeGroupTitle}>
          {lang('RelayThemeDark')}
        </div>
        <RadioGroup
          name="antigravityDark"
          options={antigravityDarkOptions}
          selected={activeVariant}
          onChange={handleThemeVariantChange}
        />
        <div className={styles.themeGroupTitle}>
          {lang('RelayThemeLight')}
        </div>
        <RadioGroup
          name="antigravityLight"
          options={antigravityLightOptions}
          selected={activeVariant}
          onChange={handleThemeVariantChange}
        />
      </Island>

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('SettingsTimeFormat')}</IslandTitle>
      <Island>
        <RadioGroup
          name="timeformat"
          options={timeFormatOptions}
          selected={timeFormat}
          onChange={handleTimeFormatChange}
        />
      </Island>

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('SettingsKeyboard')}</IslandTitle>
      <Island>
        {keyboardSendOptions && (
          <RadioGroup
            name="keyboard-send-settings"
            options={keyboardSendOptions}
            onChange={handleMessageSendComboChange}
            selected={messageSendKeyCombo}
          />
        )}
        <Checkbox
          label={lang('SettingsAutomaticTextReplacements')}
          subLabel={lang('SettingsAutomaticTextReplacementsInfo')}
          checked={shouldReplaceTextShortcuts}
          onCheck={handleTextShortcutReplacementChange}
        />
      </Island>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const {
      theme,
      shouldUseSystemTheme,
      messageSendKeyCombo,
      shouldReplaceTextShortcuts,
      messageTextSize,
      timeFormat,
    } = selectSharedSettings(global);

    return {
      messageSendKeyCombo,
      shouldReplaceTextShortcuts,
      messageTextSize,
      timeFormat,
      theme,
      shouldUseSystemTheme,
    };
  },
)(SettingsGeneral));
