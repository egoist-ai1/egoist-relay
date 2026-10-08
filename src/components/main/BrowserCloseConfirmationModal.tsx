import {
  memo, useCallback, useState,
} from '../../lib/teact/teact';
import { getActions } from '../../global';

import type { TabState } from '../../global/types';

import useLang from '../../hooks/useLang';
import useOldLang from '../../hooks/useOldLang';

import Checkbox from '../ui/Checkbox';
import ConfirmDialog from '../ui/ConfirmDialog';

export type OwnProps = {
  modal: TabState['isBrowserCloseConfirmationModalOpen'];
};

const BrowserCloseConfirmationModal = ({
  modal,
}: OwnProps) => {
  const { closeBrowserCloseConfirmationModal, closeBrowserModal } = getActions();

  const oldLang = useOldLang();
  const lang = useLang();

  const isOpen = Boolean(modal);

  const [shouldSkipInFuture, setShouldSkipInFuture] = useState(false);

  const onClose = useCallback(() => {
    closeBrowserCloseConfirmationModal({ shouldSkipInFuture });
  }, [shouldSkipInFuture]);

  const confirmHandler = useCallback(() => {
    closeBrowserModal({ shouldSkipConfirmation: true });
    closeBrowserCloseConfirmationModal({ shouldSkipInFuture });
  }, [shouldSkipInFuture]);

  return (
    <ConfirmDialog
      title={lang('CloseBrowserTabs')}
      isOpen={isOpen}
      onClose={onClose}
      confirmLabel={oldLang('Confirm')}
      confirmHandler={confirmHandler}
      confirmIsDestructive
    >
      <p>{lang('AreYouSureCloseBrowserTabs')}</p>
      <Checkbox
        className="dialog-checkbox"
        label={lang('DoNotAskAgain')}
        checked={shouldSkipInFuture}
        onCheck={setShouldSkipInFuture}
      />
    </ConfirmDialog>
  );
};

export default memo(BrowserCloseConfirmationModal);
