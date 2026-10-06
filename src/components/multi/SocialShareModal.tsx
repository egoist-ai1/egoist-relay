import { memo, useEffect, useRef, useState } from '../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../global';

import type { ThreadId } from '../../types';
import type { MediaOperation } from './mediaOperations.types';
import type {
  SocialShareMode, SocialShareRequest, SocialShareSuccess, SocialShareTarget,
} from './socialShare';
import type { SocialShareError } from './socialShareErrors';

import { requestMeasure, requestMutation } from '../../lib/fasterdom/fasterdom';
import { getPeerTitle } from '../../global/helpers/peers';
import { selectPeer, selectTabState } from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import { copyTextToClipboard } from '../../util/clipboard';
import { buildChatSelectionKey } from '../../util/keys/chatSelectionKey';
import { enqueueMediaOperation, getMediaOperationErrorCode, resumeMediaOperation } from './mediaOperations';
import {
  getSocialShareMediaCount, getSocialSharePrice, getSocialShareTextParts,
} from './socialShare';
import { classifySocialShareMediaError } from './socialShareErrors';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useOldLang from '../../hooks/useOldLang';
import usePaidMessageConfirmation from '../middle/composer/hooks/usePaidMessageConfirmation';

import Icon from '../common/icons/Icon';
import PaymentMessageConfirmDialog from '../common/PaymentMessageConfirmDialog';
import RecipientPicker from '../common/RecipientPicker';
import Modal from '../ui/Modal';

import styles from './SocialShareModal.module.scss';

type OwnProps = {
  request: SocialShareRequest;
  canSend: boolean;
  recoverOperation?: MediaOperation;
  onClose: (requestId: string, wasSent?: boolean, summary?: SocialShareSuccess, isQueued?: boolean) => Promise<void>;
};
type StateProps = {
  starsBalance: number;
  isStarsBalanceModalOpen: boolean;
};
type Phase = 'idle' | 'preparing' | 'error' | 'closing';
type CloseIntent = { wasSent: boolean; summary?: SocialShareSuccess; isQueued?: boolean };

const SocialShareModal = ({
  request, canSend, recoverOperation, onClose, starsBalance, isStarsBalanceModalOpen,
}: OwnProps & StateProps) => {
  const lang = useLang();
  const oldLang = useOldLang();
  const [target, setTarget] = useState<SocialShareTarget | undefined>(recoverOperation?.send ? {
    peerId: recoverOperation.send.peerId, threadId: recoverOperation.send.threadId as ThreadId | undefined,
  } : undefined);
  const [mode, setMode] = useState<SocialShareMode>(
    recoverOperation?.kind === 'send' ? recoverOperation.mode || 'link' : 'link',
  );
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<SocialShareError>();
  const [price, setPrice] = useState(0);
  const [isTargetLoading, setIsTargetLoading] = useState(Boolean(recoverOperation?.send));
  const [isPaymentConfirmOpen, setIsPaymentConfirmOpen] = useState(false);
  const [isSourceExpanded, setIsSourceExpanded] = useState(false);
  const operationRef = useRef(false);
  const canceledRef = useRef(false);
  const selectionRef = useRef(0);
  const paymentRef = useRef(false);
  const closeIntentRef = useRef<CloseIntent>();
  const detailsRef = useRef<HTMLDivElement>();
  const mediaCount = getSocialShareMediaCount(request);
  const hasMedia = mediaCount > 0;
  const isBusy = phase === 'preparing' || phase === 'closing';
  const hasCloseIntent = Boolean(closeIntentRef.current);
  const total = getSocialShareTextParts(request).length + (mode !== 'link' ? mediaCount : 0);
  const peer = target ? selectPeer(getGlobal(), target.peerId) : undefined;
  const peerName = peer ? getPeerTitle(oldLang, peer) : undefined;
  const handlePaymentVisibilityChange = useLastCallback((isOpen: boolean) => {
    setIsPaymentConfirmOpen(isOpen);
    if (!isOpen) paymentRef.current = false;
  });

  const {
    closeConfirmDialog, handleWithConfirmation, dialogHandler, shouldAutoApprove, setAutoApprove,
  } = usePaidMessageConfirmation(
    price * (total - (recoverOperation?.send?.confirmed || 0)), isStarsBalanceModalOpen, starsBalance,
    undefined, handlePaymentVisibilityChange,
  );

  useEffect(() => {
    if (!error && phase !== 'preparing') return;
    requestMeasure(() => {
      const details = detailsRef.current;
      if (!details) return;
      const bottom = details.scrollHeight;
      requestMutation(() => {
        details.scrollTop = bottom;
      });
    });
  }, [error, phase]);

  useEffect(() => {
    canceledRef.current = false;
    return () => {
      canceledRef.current = true;
      closeConfirmDialog();
    };
  }, [closeConfirmDialog]);

  const handleSelectRecipient = useLastCallback(async (peerId: string, threadId?: ThreadId) => {
    if (operationRef.current || paymentRef.current || closeIntentRef.current) return;
    if (recoverOperation?.send && (peerId !== recoverOperation.send.peerId
      || String(threadId || '') !== String(recoverOperation.send.threadId || ''))) return;
    const selection = ++selectionRef.current;
    const selected = { peerId, threadId };
    setTarget(selected);
    setError(undefined);
    setIsTargetLoading(true);
    try {
      const selectedPrice = await getSocialSharePrice(selected);
      if (selection === selectionRef.current && !canceledRef.current) setPrice(selectedPrice);
    } catch {
      if (selection === selectionRef.current && !canceledRef.current) setError('restricted');
    } finally {
      if (selection === selectionRef.current && !canceledRef.current) setIsTargetLoading(false);
    }
  });

  useEffect(() => {
    if (recoverOperation?.send) {
      void handleSelectRecipient(recoverOperation.send.peerId,
        recoverOperation.send.threadId);
    }
  }, [recoverOperation]);

  const completeClose = useLastCallback(async (intent: CloseIntent) => {
    closeIntentRef.current = intent;
    canceledRef.current = true;
    setPhase('closing');
    try {
      await onClose(request.requestId, intent.wasSent, intent.summary, intent.isQueued);
    } catch {
      setError('close');
      setPhase('error');
    }
  });

  const handleSaveOriginal = useLastCallback(async () => {
    if (operationRef.current || paymentRef.current || hasCloseIntent || canceledRef.current) return;
    operationRef.current = true;
    setError(undefined);
    setPhase('preparing');
    try {
      const input = { request, kind: 'save' as const };
      if (recoverOperation?.kind === 'save') await resumeMediaOperation(recoverOperation.id, input);
      else await enqueueMediaOperation(input);
      await completeClose({ wasSent: false, isQueued: true });
    } catch (err) {
      const code = getMediaOperationErrorCode(err);
      setError(code === 'MEDIA_QUEUE_FULL' ? 'queue' : code.includes('JOURNAL') ? 'journal'
        : classifySocialShareMediaError(err));
      setPhase('error');
    } finally {
      operationRef.current = false;
    }
  });

  const performSend = useLastCallback(async () => {
    paymentRef.current = false;
    if (operationRef.current || !target || !canSend || canceledRef.current) return;
    operationRef.current = true;
    setError(undefined);
    setPhase('preparing');
    try {
      const currentPrice = await getSocialSharePrice(target);
      if (currentPrice !== price) {
        setPrice(currentPrice);
        throw new Error('SOCIAL_SHARE_PRICE_CHANGED');
      }
      const input = { request, kind: 'send' as const, mode, target, price,
        recipientName: peerName || lang('RelayShareChooseRecipient') };
      if (recoverOperation?.kind === 'send') await resumeMediaOperation(recoverOperation.id, input);
      else await enqueueMediaOperation(input);
      await completeClose({ wasSent: false, isQueued: true });
    } catch (err) {
      const code = getMediaOperationErrorCode(err);
      setError(code === 'MEDIA_QUEUE_FULL' ? 'queue' : code.includes('JOURNAL') ? 'journal'
        : code.includes('RESTRICTED') ? 'restricted' : 'send');
      setPhase('error');
    } finally {
      operationRef.current = false;
    }
  });

  const handleSend = useLastCallback(() => {
    if (closeIntentRef.current) {
      if (phase !== 'closing') void completeClose(closeIntentRef.current);
      return;
    }
    if (operationRef.current || paymentRef.current || isStarsBalanceModalOpen
      || !target || error === 'restricted' || canceledRef.current) return;
    paymentRef.current = true;
    handleWithConfirmation(() => {
      void performSend();
    });
  });

  const handlePaymentClose = useLastCallback(() => {
    paymentRef.current = false;
    closeConfirmDialog();
  });

  const handleClose = useLastCallback(async () => {
    if (operationRef.current || phase === 'closing' || paymentRef.current || isStarsBalanceModalOpen) return;
    await completeClose(closeIntentRef.current || { wasSent: false });
  });

  const handleModeChange = useLastCallback((nextMode: SocialShareMode) => {
    if (isBusy || recoverOperation?.kind === 'send' || paymentRef.current || closeIntentRef.current) return;
    setMode(nextMode);
    setError(undefined);
    setPhase('idle');
  });

  const handleToggleSource = useLastCallback(() => setIsSourceExpanded((previous) => !previous));

  const handleCopyLink = useLastCallback(() => {
    if (isBusy || paymentRef.current || hasCloseIntent || canceledRef.current) return;
    let isCopied = false;
    try {
      isCopied = copyTextToClipboard(request.url);
    } catch {
      // Keep the recipient picker available if the browser denies clipboard access.
    }
    getActions().showNotification({ message: { key: isCopied ? 'LinkCopied' : 'GeneralError' } });
    if (isCopied) void handleClose();
  });

  const footer = (
    <div className={styles.footer} data-relay-share={request.service} data-relay-share-modal="true" aria-busy={isBusy}>
      <div className={styles.details} ref={detailsRef}>
        <div className={styles.source}>
          <button
            type="button"
            className={styles.sourceToggle}
            onClick={handleToggleSource}
            aria-label={lang('RelayShareSourceDetails')}
            aria-expanded={isSourceExpanded}
          >
            <span className={styles.service}>{request.service === 'x' ? 'X' : 'Instagram'}</span>
            <span className={styles.sourcePreview} dir="auto">{request.text || request.url}</span>
            <Icon name={isSourceExpanded ? 'up' : 'down'} className={styles.sourceChevron} />
          </button>
          {isSourceExpanded && (
            <div className={styles.sourceDetails}>
              {request.text && <p className={styles.text} dir="auto">{request.text}</p>}
              <span className={styles.url} dir="ltr">{request.url}</span>
            </div>
          )}
        </div>
        {recoverOperation && (
          <p className={styles.warning}>
            {lang(recoverOperation.kind === 'save'
              ? 'RelayOperationSaveRecovery' : 'RelayOperationRecoveryHelp')}
            {recoverOperation.send && (
              <span>
                {' '}
                {lang('RelayOperationConfirmed')}
                {' '}
                {recoverOperation.send.confirmed}
                {' / '}
                {recoverOperation.send.total}
              </span>
            )}
          </p>
        )}
        {hasMedia && (
          <fieldset className={styles.modes} disabled={isBusy || hasCloseIntent || recoverOperation?.kind === 'send'}>
            <label className={buildClassName(styles.mode, mode === 'link' && styles.modeSelected)}>
              <input
                className={styles.modeInput}
                type="radio"
                name={`share-mode-${request.requestId}`}
                checked={mode === 'link'}
                onChange={() => handleModeChange('link')}
              />
              <Icon name="link" className={styles.modeIcon} />
              {lang('RelayOperationModeLink')}
            </label>
            <label className={buildClassName(styles.mode, mode === 'media' && styles.modeSelected)}>
              <input
                className={styles.modeInput}
                type="radio"
                name={`share-mode-${request.requestId}`}
                checked={mode === 'media'}
                onChange={() => handleModeChange('media')}
              />
              <Icon name="attach" className={styles.modeIcon} />
              {lang('RelayOperationModeMedia')}
              {!request.unavailableMedia && <span className={styles.mediaCount}>{mediaCount}</span>}
            </label>
            <label className={buildClassName(styles.mode, mode === 'file' && styles.modeSelected)}>
              <input
                className={styles.modeInput}
                type="radio"
                name={`share-mode-${request.requestId}`}
                checked={mode === 'file'}
                onChange={() => handleModeChange('file')}
              />
              <Icon name="document" className={styles.modeIcon} />
              {lang('RelayOperationModeFile')}
            </label>
          </fieldset>
        )}
        {hasMedia && (
          <p className={styles.warning}>
            {lang(mode === 'file' ? 'RelayOperationFileHelp'
              : mode === 'media' ? 'RelayOperationMediaHelp' : 'RelayOperationLinkHelp')}
          </p>
        )}
        {request.unavailableMedia && <p className={styles.warning}>{lang('RelaySharePublicVideoWarning')}</p>}
        {!canSend && <p role="status">{lang('RelayShareLoginRequired')}</p>}
        {phase === 'preparing' && (
          <p role="status" aria-live="polite" className={styles.status}>{lang('RelayOperationAccepting')}</p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {lang(error === 'queue' ? 'RelayOperationQueueFull' : error === 'journal' ? 'RelayOperationJournalError'
              : error === 'mediaDiskFull' ? 'RelayMediaDiskFull' : error === 'media' ? 'RelayShareMediaError'
                : error === 'mediaAuth' ? 'RelayShareMediaAuth'
                  : error === 'mediaForbidden' ? 'RelayInlineMediaForbidden'
                    : error === 'mediaUnavailable' ? 'RelayInlineMediaUnavailable'
                      : error === 'mediaRateLimited' ? 'RelayInlineMediaRateLimited'
                        : error === 'mediaConnection' ? 'RelayInlineMediaConnection'
                          : error === 'mediaLimit' ? 'RelayInlineMediaLimit'
                            : error === 'restricted' ? 'RelayShareRestricted'
                              : error === 'close' ? 'RelayShareCloseError' : 'RelayShareError')}
          </p>
        )}
      </div>
      <div className={styles.actions}>
        {hasMedia && !hasCloseIntent && (
          <button type="button" className={styles.secondary} onClick={handleSaveOriginal} disabled={isBusy}>
            <Icon name="download" className={styles.sendIcon} />
            {lang('RelayReaderDownload')}
          </button>
        )}
        {target && !hasCloseIntent && (
          <button
            type="button"
            className={styles.secondary}
            data-relay-share-copy
            onClick={handleCopyLink}
            disabled={isBusy}
          >
            {lang('CopyLink')}
          </button>
        )}
        {(target || hasCloseIntent) && (canSend || hasCloseIntent) ? (
          <button
            type="button"
            data-relay-share-send
            className={styles.send}
            onClick={handleSend}
            disabled={isBusy || (!hasCloseIntent && (isTargetLoading || error === 'restricted'))}
          >
            <Icon name={hasCloseIntent ? 'reload' : 'send'} className={styles.sendIcon} />
            {lang(phase === 'error' ? 'RelayShareRetry' : 'RelayShareSend')}
          </button>
        ) : (
          <button
            type="button"
            className={styles.send}
            data-relay-share-copy
            onClick={handleCopyLink}
            disabled={isBusy || hasCloseIntent}
          >
            {lang('CopyLink')}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {canSend ? (
        <RecipientPicker
          isOpen
          title={lang('ShareWith')}
          searchPlaceholder={lang('Search')}
          className={buildClassName(styles.modal, (isBusy || hasCloseIntent) && styles.busy)}
          footer={footer}
          selectedRecipient={target && buildChatSelectionKey(target.peerId, target.threadId
            ? Number(target.threadId) : undefined)}
          isSingleSelect
          isNativeDialog
          withFolders
          onSelectRecipient={handleSelectRecipient}
          onClose={handleClose}
          isLowStackPriority
        />
      ) : (
        <Modal
          isOpen
          title={lang('ShareWith')}
          className={styles.modal}
          hasCloseButton
          onClose={handleClose}
        >
          {footer}
        </Modal>
      )}
      <PaymentMessageConfirmDialog
        isOpen={isPaymentConfirmOpen}
        onClose={handlePaymentClose}
        userName={peerName}
        messagePriceInStars={price}
        messagesCount={total - (recoverOperation?.send?.confirmed || 0)}
        shouldAutoApprove={shouldAutoApprove}
        setAutoApprove={setAutoApprove}
        confirmHandler={dialogHandler}
      />
    </>
  );
};

export default memo(withGlobal<OwnProps>((global): Complete<StateProps> => ({
  starsBalance: global.stars?.balance.amount || 0,
  isStarsBalanceModalOpen: Boolean(selectTabState(global).starsBalanceModal),
}))(SocialShareModal));
