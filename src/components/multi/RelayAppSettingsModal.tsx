import { memo } from '../../lib/teact/teact';

import useLang from '../../hooks/useLang';

import Island, { IslandTitle } from '../gili/layout/Island';
import { RelayAppSettingsContent } from '../left/settings/SettingsRelayApp';
import Button from '../ui/Button';
import Modal from '../ui/Modal';

import styles from './RelayAppSettingsModal.module.scss';

type OwnProps = {
  isOpen: boolean;
  isClearingCache?: boolean;
  onClose: NoneToVoidFunction;
  onCloseAnimationEnd?: NoneToVoidFunction;
  onOpenCacheDialog?: (trigger: HTMLButtonElement) => void;
};

// Настройки «Бересты» из боковой панели доступны без входа в Telegram
const RelayAppSettingsModal = ({
  isOpen, isClearingCache, onClose, onCloseAnimationEnd, onOpenCacheDialog,
}: OwnProps) => {
  const lang = useLang();

  return (
    <Modal
      isOpen={isOpen}
      title={lang('RelayAppSettingsOpen')}
      className={styles.modal}
      contentClassName={styles.content}
      hasCloseButton
      onClose={onClose}
      onCloseAnimationEnd={onCloseAnimationEnd}
    >
      <div className={styles.body}>
        <RelayAppSettingsContent />
        {onOpenCacheDialog && (
          <>
            <IslandTitle>{lang('RelayPrivacyDataSection')}</IslandTitle>
            <Island>
              <Button
                color="translucent"
                hasPopup
                disabled={isClearingCache}
                onClick={(event) => onOpenCacheDialog(event.currentTarget)}
              >
                {lang(isClearingCache ? 'RelayCacheClearing' : 'RelayCacheClear')}
              </Button>
            </Island>
          </>
        )}
      </div>
    </Modal>
  );
};

export default memo(RelayAppSettingsModal);
