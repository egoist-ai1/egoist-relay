import { memo, useEffect, useRef, useState } from '../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../global';

import type { ApiAttachment } from '../../api/types';
import type { ThreadId } from '../../types';
import type {
  ShareSendJob, SocialMediaProgress, SocialShareMode, SocialShareRequest, SocialShareSuccess, SocialShareTarget,
} from './socialShare';
import type { SocialShareError } from './socialShareErrors';

import { requestMeasure, requestMutation } from '../../lib/fasterdom/fasterdom';
import { getPeerTitle } from '../../global/helpers/peers';
import { selectPeer, selectTabState } from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import { copyTextToClipboard } from '../../util/clipboard';
import { buildChatSelectionKey } from '../../util/keys/chatSelectionKey';
import {
  assertSocialShareTarget, createSocialShareJob, getSocialShareMediaCount, getSocialSharePrice, getSocialShareTextParts,
  releaseSocialShareMedia, resolveSocialShareMedia, saveSocialShareMedia, sendSocialShareJob,
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
  onClose: (requestId: string, wasSent?: boolean, summary?: SocialShareSuccess) => Promise<void>;
};
type StateProps = {
  starsBalance: number;
  isStarsBalanceModalOpen: boolean;
};
type Phase = 'idle' | 'downloading' | 'preparing' | 'sending' | 'error' | 'closing';
type CloseIntent = { wasSent: boolean; summary?: SocialShareSuccess };

const SocialShareModal = ({
  request, canSend, onClose, starsBalance, isStarsBalanceModalOpen,
}: OwnProps & StateProps) => {
  const lang = useLang();
  const oldLang = useOldLang();
  const [target, setTarget] = useState<SocialShareTarget>();
  const [mode, setMode] = useState<SocialShareMode>('link');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<SocialShareError>();
  const [hasSavedMedia, setHasSavedMedia] = useState(false);
  const [price, setPrice] = useState(0);
  const [isTargetLoading, setIsTargetLoading] = useState(false);
  const [mediaIndex, setMediaIndex] = useState(0);
  const [transferPercent, setTransferPercent] = useState<number>();
  const [confirmed, setConfirmed] = useState(0);
  const [isPaymentConfirmOpen, setIsPaymentConfirmOpen] = useState(false);
  const [isSourceExpanded, setIsSourceExpanded] = useState(false);
  const attachmentsRef = useRef<ApiAttachment[]>([]);
  const jobRef = useRef<ShareSendJob>();
  const operationRef = useRef(false);
  const operationTokenRef = useRef<{ canceled: boolean }>();
  const canceledRef = useRef(false);
  const selectionRef = useRef(0);
  const paymentRef = useRef(false);
  const closeIntentRef = useRef<CloseIntent>();
  const detailsRef = useRef<HTMLDivElement>();
  const mediaCount = getSocialShareMediaCount(request);
  const hasMedia = mediaCount > 0;
  const isBusy = phase === 'downloading' || phase === 'preparing' || phase === 'sending' || phase === 'closing';
  const hasCloseIntent = Boolean(closeIntentRef.current);
  const total = closeIntentRef.current?.summary?.count || jobRef.current?.items.length
    || getSocialShareTextParts(request).length + (mode === 'media' ? mediaCount : 0);
  const peer = target ? selectPeer(getGlobal(), target.peerId) : undefined;
  const peerName = peer ? getPeerTitle(oldLang, peer) : undefined;
  const handlePaymentVisibilityChange = useLastCallback((isOpen: boolean) => {
    setIsPaymentConfirmOpen(isOpen);
    if (!isOpen) paymentRef.current = false;
  });

  const {
    closeConfirmDialog, handleWithConfirmation, dialogHandler, shouldAutoApprove, setAutoApprove,
  } = usePaidMessageConfirmation(
    price * (total - confirmed), isStarsBalanceModalOpen, starsBalance, undefined, handlePaymentVisibilityChange,
  );

  useEffect(() => {
    if (!error && phase !== 'preparing' && phase !== 'sending') return;
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
      if (operationTokenRef.current) operationTokenRef.current.canceled = true;
      releaseSocialShareMedia(attachmentsRef.current);
      closeConfirmDialog();
    };
  }, [closeConfirmDialog]);

  useEffect(() => {
    let release: NoneToVoidFunction | undefined;
    let mounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) => listen<SocialMediaProgress>(
      'multi-social-media-progress', ({ payload }) => {
        if (!mounted || payload.requestId !== request.requestId || phase !== 'preparing') return;
        setMediaIndex(payload.index);
        setTransferPercent(payload.total ? Math.round(payload.loaded / payload.total * 100) : undefined);
      },
    )).then((unlisten) => {
      if (mounted) release = unlisten;
      else unlisten();
    }).catch(() => undefined);
    return () => {
      mounted = false;
      release?.();
    };
  }, [phase, request.requestId]);

  const handleSelectRecipient = useLastCallback(async (peerId: string, threadId?: ThreadId) => {
    if (operationRef.current || jobRef.current || paymentRef.current || closeIntentRef.current) return;
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

  const completeClose = useLastCallback(async (intent: CloseIntent) => {
    closeIntentRef.current = intent;
    canceledRef.current = true;
    if (operationTokenRef.current) operationTokenRef.current.canceled = true;
    releaseSocialShareMedia(attachmentsRef.current);
    jobRef.current = undefined;
    setTransferPercent(undefined);
    setPhase('closing');
    try {
      await onClose(request.requestId, intent.wasSent, intent.summary);
    } catch {
      setError('close');
      setPhase('error');
    }
  });

  const handleSaveOriginal = useLastCallback(async () => {
    if (operationRef.current || paymentRef.current || hasCloseIntent || canceledRef.current) return;
    const operation = { canceled: false };
    operationTokenRef.current = operation;
    operationRef.current = true;
    setError(undefined);
    setHasSavedMedia(false);
    setPhase('downloading');
    try {
      await saveSocialShareMedia(request, () => operation.canceled, setMediaIndex);
      if (!operation.canceled) {
        setHasSavedMedia(true);
        setPhase('idle');
      }
    } catch (err) {
      if (!operation.canceled) {
        setError(classifySocialShareMediaError(err));
        setPhase('error');
      }
    } finally {
      if (operationTokenRef.current === operation) operationRef.current = false;
    }
  });

  const performSend = useLastCallback(async () => {
    paymentRef.current = false;
    if (operationRef.current || !target || !canSend || canceledRef.current) return;
    const operation = { canceled: false };
    operationTokenRef.current = operation;
    operationRef.current = true;
    setError(undefined);
    try {
      if (!jobRef.current) {
        if (mode === 'media' && !attachmentsRef.current.length) {
          setPhase('preparing');
          setTransferPercent(undefined);
          try {
            attachmentsRef.current = await resolveSocialShareMedia(request, () => operation.canceled, setMediaIndex);
          } catch (err) {
            if (!operation.canceled) setError(classifySocialShareMediaError(err));
            throw err;
          }
        }
        if (operation.canceled) return;
        assertSocialShareTarget(target, mode === 'media' ? attachmentsRef.current : []);
        jobRef.current = createSocialShareJob(request, target, mode === 'media' ? attachmentsRef.current : []);
      }
      const currentPrice = await getSocialSharePrice(jobRef.current.target);
      if (operation.canceled) return;
      if (currentPrice !== price) {
        setPrice(currentPrice);
        throw new Error('SOCIAL_SHARE_PRICE_CHANGED');
      }
      setPhase('sending');
      await sendSocialShareJob(jobRef.current, price, (count, progress) => {
        if (operation.canceled) return;
        setConfirmed(count);
        setTransferPercent(progress === undefined ? undefined : Math.round(progress * 100));
      });
      if (operation.canceled) return;
      const summary = {
        recipientName: peerName || lang('RelayShareChooseRecipient'), count: jobRef.current.items.length,
      };
      await completeClose({ wasSent: true, summary });
    } catch (err) {
      if (operation.canceled) return;
      setError((previous) => previous || (String(err).includes('RESTRICTED') ? 'restricted' : 'send'));
      setPhase('error');
    } finally {
      if (operationTokenRef.current === operation) operationRef.current = false;
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
    if (phase === 'sending' || phase === 'closing' || paymentRef.current || isStarsBalanceModalOpen) return;
    await completeClose(closeIntentRef.current || { wasSent: false });
  });

  const handleModeChange = useLastCallback((nextMode: SocialShareMode) => {
    if (isBusy || jobRef.current || paymentRef.current || closeIntentRef.current) return;
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
        {hasMedia && (
          <fieldset className={styles.modes} disabled={isBusy || Boolean(jobRef.current) || hasCloseIntent}>
            <label className={buildClassName(styles.mode, mode === 'link' && styles.modeSelected)}>
              <input
                className={styles.modeInput}
                type="radio"
                name={`share-mode-${request.requestId}`}
                checked={mode === 'link'}
                onChange={() => handleModeChange('link')}
              />
              <Icon name="link" className={styles.modeIcon} />
              {lang('RelayShareLinkOnly')}
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
              {lang(request.unavailableMedia ? 'RelayShareVideo' : 'RelayShareAttachments')}
              {!request.unavailableMedia && <span className={styles.mediaCount}>{mediaCount}</span>}
            </label>
          </fieldset>
        )}
        {request.unavailableMedia && <p className={styles.warning}>{lang('RelaySharePublicVideoWarning')}</p>}
        {!canSend && <p role="status">{lang('RelayShareLoginRequired')}</p>}
        {phase === 'downloading' && (
          <p role="status" aria-live="polite" className={styles.status}>
            {lang('RelayDownloadStarted')}
            {' '}
            {lang('RelayShareProgress', { index: mediaIndex + 1, total: mediaCount })}
          </p>
        )}
        {hasSavedMedia && <p role="status" className={styles.status}>{lang('RelayDownloadSaved')}</p>}
        {phase === 'preparing' && (
          <p role="status" aria-live="polite" className={styles.status}>
            {lang('RelaySharePreparing')}
            {' '}
            {lang('RelayShareProgress', { index: mediaIndex + 1, total: mediaCount })}
            {transferPercent !== undefined && ` · ${transferPercent}%`}
          </p>
        )}
        {phase === 'sending' && (
          <p role="status" aria-live="polite" className={styles.status}>
            {lang('RelayShareSending')}
            {' '}
            {transferPercent !== undefined && `${transferPercent}%`}
          </p>
        )}
        {confirmed > 0 && !closeIntentRef.current?.wasSent && (
          <p className={styles.status}>
            {lang('RelaySharePartial', { confirmed, total })}
          </p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {lang(error === 'mediaDiskFull' ? 'RelayMediaDiskFull' : error === 'media' ? 'RelayShareMediaError'
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
          className={buildClassName(styles.modal, (isBusy || Boolean(jobRef.current) || hasCloseIntent) && styles.busy)}
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
        messagesCount={total - confirmed}
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
