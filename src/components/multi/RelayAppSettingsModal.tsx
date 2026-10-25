import { memo } from '../../lib/teact/teact';

import useLang from '../../hooks/useLang';

import { RelayAppSettingsContent } from '../left/settings/SettingsRelayApp';
import Modal from '../ui/Modal';

import styles from './RelayAppSettingsModal.module.scss';

type OwnProps = {
  isOpen: boolean;
  onClose: NoneToVoidFunction;
};

// Окно «Настройки Бересты» из rail: сервисы и сеть доступны без входа в Telegram
const RelayAppSettingsModal = ({ isOpen, onClose }: OwnProps) => {
  const lang = useLang();

  return (
    <Modal
      isOpen={isOpen}
      title={lang('RelayAppSettings')}
      className={styles.modal}
      contentClassName={styles.content}
      hasCloseButton
      onClose={onClose}
    >
      <div className={styles.body}>
        <RelayAppSettingsContent />
      </div>
    </Modal>
  );
};

export default memo(RelayAppSettingsModal);
