import type { ChangeEvent } from 'react';
import { memo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import { selectSharedSettings } from '../../../global/selectors/sharedState';
import {
  DELETED_MESSAGES_MAX_MEGABYTES_OPTIONS,
  DELETED_MESSAGES_RETENTION_DAYS_OPTIONS,
} from '../../../util/deletedMessages';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Island, { IslandTitle } from '../../gili/layout/Island';
import Checkbox from '../../ui/Checkbox';
import ConfirmDialog from '../../ui/ConfirmDialog';
import ListItem from '../../ui/ListItem';
import Select from '../../ui/Select';

import styles from './SettingsDeletedMessages.module.scss';

type StateProps = {
  shouldKeepDeletedMessages: boolean;
  deletedMessagesRetentionDays: number;
  deletedMessagesMaxMegabytes: number;
};

const SettingsDeletedMessages = ({
  shouldKeepDeletedMessages,
  deletedMessagesRetentionDays,
  deletedMessagesMaxMegabytes,
}: StateProps) => {
  const { setShouldKeepDeletedMessages, setSharedSettingOption, clearDeletedMessages } = getActions();

  const lang = useLang();
  const [isClearDialogOpen, openClearDialog, closeClearDialog] = useFlag();

  const handleKeepChange = useLastCallback((isChecked: boolean) => {
    setShouldKeepDeletedMessages({ value: isChecked });
  });

  const handleRetentionChange = useLastCallback((e: ChangeEvent<HTMLSelectElement>) => {
    setSharedSettingOption({ deletedMessagesRetentionDays: Number(e.target.value) });
  });

  const handleLimitChange = useLastCallback((e: ChangeEvent<HTMLSelectElement>) => {
    setSharedSettingOption({ deletedMessagesMaxMegabytes: Number(e.target.value) });
  });

  const handleClearConfirm = useLastCallback(() => {
    clearDeletedMessages();
    closeClearDialog();
  });

  return (
    <>
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('RelayDeletedMessagesTitle')}</IslandTitle>
      <Island>
        <Checkbox
          label={lang('RelayKeepDeletedMessages')}
          subLabel={lang('RelayKeepDeletedMessagesHint')}
          checked={shouldKeepDeletedMessages}
          onCheck={handleKeepChange}
        />
        {shouldKeepDeletedMessages && (
          <div className={styles.limits}>
            <Select
              id="deleted-messages-retention"
              label={lang('RelayDeletedMessagesRetention')}
              value={String(deletedMessagesRetentionDays)}
              hasArrow
              onChange={handleRetentionChange}
            >
              {DELETED_MESSAGES_RETENTION_DAYS_OPTIONS.map((days) => (
                <option value={days} selected={days === deletedMessagesRetentionDays}>
                  {lang('RelayDeletedMessagesDaysOption', { count: days })}
                </option>
              ))}
            </Select>
            <Select
              id="deleted-messages-limit"
              label={lang('RelayDeletedMessagesLimit')}
              value={String(deletedMessagesMaxMegabytes)}
              hasArrow
              onChange={handleLimitChange}
            >
              {DELETED_MESSAGES_MAX_MEGABYTES_OPTIONS.map((megabytes) => (
                <option value={megabytes} selected={megabytes === deletedMessagesMaxMegabytes}>
                  {lang('RelayDeletedMessagesMegabytesOption', { count: megabytes })}
                </option>
              ))}
            </Select>
          </div>
        )}
        <ListItem icon="delete" narrow destructive onClick={openClearDialog}>
          {lang('RelayClearDeletedMessages')}
        </ListItem>
      </Island>
      <ConfirmDialog
        isOpen={isClearDialogOpen}
        onClose={closeClearDialog}
        title={lang('RelayClearDeletedMessagesTitle')}
        text={lang('RelayClearDeletedMessagesText')}
        confirmLabel={lang('RelayClearDeletedMessagesConfirm')}
        confirmHandler={handleClearConfirm}
        confirmIsDestructive
      />
    </>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    const {
      shouldKeepDeletedMessages, deletedMessagesRetentionDays, deletedMessagesMaxMegabytes,
    } = selectSharedSettings(global);

    return {
      shouldKeepDeletedMessages,
      deletedMessagesRetentionDays,
      deletedMessagesMaxMegabytes,
    };
  },
)(SettingsDeletedMessages));
