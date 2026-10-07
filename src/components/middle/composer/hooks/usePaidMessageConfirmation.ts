import { useEffect, useRef, useState } from '../../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../../global';

import { PAID_MESSAGES_PURPOSE } from '../../../../config';

import useLastCallback from '../../../../hooks/useLastCallback';

export default function usePaidMessageConfirmation(
  starsForAllMessages: number,
  isStarsBalanceModeOpen: boolean,
  starsBalance: number,
  shouldDelayConfirmHandler?: boolean,
  onConfirmDialogChange?: (isOpen: boolean) => void,
) {
  const {
    shouldPaidMessageAutoApprove,
  } = getGlobal().settings.byKey;

  const [shouldAutoApprove, setShouldAutoApprove] = useState(Boolean(shouldPaidMessageAutoApprove));
  const [isWaitingStarsTopup, setIsWaitingStarsTopup] = useState(false);
  const confirmPaymentHandlerRef = useRef<NoneToVoidFunction | undefined>(undefined);

  const closeConfirmDialog = useLastCallback(() => {
    if (onConfirmDialogChange) onConfirmDialogChange(false);
    else getActions().closePaymentMessageConfirmDialogOpen();
  });

  useEffect(() => {
    if (isWaitingStarsTopup && !isStarsBalanceModeOpen) {
      setIsWaitingStarsTopup(false);

      if (onConfirmDialogChange ? starsBalance >= starsForAllMessages : starsBalance > starsForAllMessages) {
        confirmPaymentHandlerRef?.current?.();
      } else {
        onConfirmDialogChange?.(false);
      }
    }
  }, [isWaitingStarsTopup, isStarsBalanceModeOpen, starsBalance, starsForAllMessages, onConfirmDialogChange]);

  const handleStarsTopup = useLastCallback(() => {
    getActions().openStarsBalanceModal({
      topup: {
        balanceNeeded: starsForAllMessages,
        purpose: PAID_MESSAGES_PURPOSE,
      },
    });
    setIsWaitingStarsTopup(true);
  });

  const dialogHandler = useLastCallback(() => {
    if (starsForAllMessages > starsBalance) {
      handleStarsTopup();
    } else if (shouldDelayConfirmHandler) {
      setTimeout(() => {
        confirmPaymentHandlerRef?.current?.();
      }, 250);
    } else {
      confirmPaymentHandlerRef?.current?.();
    }

    closeConfirmDialog();
    if (shouldAutoApprove) getActions().setPaidMessageAutoApprove();
  });

  const handleWithConfirmation = useLastCallback(<T extends (...args: any[]) => void>(
    handler: T,
    ...args: Parameters<T>
  ) => {
    if (starsForAllMessages) {
      confirmPaymentHandlerRef.current = () => handler(...args);
      if (!shouldPaidMessageAutoApprove) {
        if (onConfirmDialogChange) onConfirmDialogChange(true);
        else getActions().openPaymentMessageConfirmDialogOpen();
        return;
      }

      if (starsForAllMessages > starsBalance) {
        handleStarsTopup();
        return;
      }
    }

    handler(...args);
  });

  return {
    closeConfirmDialog,
    handleWithConfirmation,
    dialogHandler,
    shouldAutoApprove,
    setAutoApprove: setShouldAutoApprove,
  };
}
