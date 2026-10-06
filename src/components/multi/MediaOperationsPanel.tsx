import { memo, useEffect, useMemo, useRef, useState } from '../../lib/teact/teact';

import type { RegularLangKey } from '../../types/language';
import type { MediaOperation, MediaOperationsSnapshot, MediaOperationStage } from './mediaOperations.types';

import buildClassName from '../../util/buildClassName';
import captureKeyboardListeners, { ALLOW_KEYBOARD_EVENT_PROPAGATION } from '../../util/captureKeyboardListeners';
import {
  cancelMediaOperation, clearMediaOperationHistory, getMediaOperationErrorCode, mediaOperationFileAction,
  retryMediaOperation,
} from './mediaOperations';
import { getMediaOperationPercent, isMediaOperationActive } from './mediaOperations.types';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Icon from '../common/icons/Icon';

import styles from './MediaOperationsPanel.module.scss';

type OwnProps = {
  snapshot: MediaOperationsSnapshot;
  isFull: boolean;
  onClose: NoneToVoidFunction;
  onSource: (operation: MediaOperation) => Promise<void>;
  onChat: (operation: MediaOperation) => Promise<void>;
};

const STAGE_KEYS: Record<MediaOperationStage, RegularLangKey> = {
  queued: 'RelayOperationQueued', resolving: 'RelayOperationResolving', downloading: 'RelayOperationDownloading',
  writing: 'RelayOperationWriting', preparing: 'RelayOperationPreparing', sending: 'RelayOperationSending',
  cancelling: 'RelayOperationCancelling', completed: 'RelayOperationCompleted', failed: 'RelayOperationFailed',
  cancelled: 'RelayOperationCancelled', interrupted: 'RelayOperationInterrupted', uncertain: 'RelayOperationUncertain',
};

export function getMediaOperationErrorKey(code: string): RegularLangKey {
  if (code.includes('JOURNAL') || code.includes('DPAPI')) return 'RelayOperationJournalError';
  if (code.includes('FILE_MISSING') || code.includes('FILE_UNAVAILABLE')) return 'RelayOperationMissingFile';
  if (code.includes('OUTCOME_UNCERTAIN')) return 'RelayOperationUncertainHelp';
  if (code.includes('ACCOUNT')) return 'RelayOperationAccountChanged';
  if (code.includes('SOURCE_CHANGED')) return 'RelayOperationSourceChanged';
  if (code.includes('RECAPTURE') || code.includes('RETRY_FROM_SOURCE')) return 'RelayOperationRecapture';
  if (code.includes('PRICE')) return 'RelayOperationPriceChanged';
  if (code.includes('QUEUE_FULL')) return 'RelayOperationQueueFull';
  if (code.includes('TOO_LARGE') || code.includes('MEDIA_LIMIT')) return 'RelayOperationLimit';
  if (code.includes('DISK_FULL')) return 'RelayOperationDiskFull';
  if (code.includes('TIMEOUT') || code.includes('DEADLINE')) return 'RelayOperationTimeout';
  if (code.includes('PROXY') || code.includes('PAC')) return 'RelayOperationProxy';
  if (code.includes('AUTH_REQUIRED') || code.includes('UNAVAILABLE') || code.includes('FORBIDDEN')) {
    return 'RelayOperationUnavailable';
  }
  return 'RelayOperationError';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

const MediaOperationsPanel = ({ snapshot, isFull, onClose, onSource, onChat }: OwnProps) => {
  const lang = useLang();
  const closeRef = useRef<HTMLButtonElement>();
  const rootRef = useRef<HTMLDivElement>();
  const hasInitializedFocusRef = useRef(false);
  const current = snapshot.operations.filter(isMediaOperationActive);
  const previousCurrentCountRef = useRef(current.length);
  const [section, setSection] = useState<'current' | 'history'>(current.length ? 'current' : 'history');
  const [limit, setLimit] = useState(50);
  const [busyId, setBusyId] = useState<string>();
  const [actionError, setActionError] = useState<{ id: string; code: string }>();
  const [isClearConfirm, setIsClearConfirm] = useState(false);
  const formatter = useMemo(() => new Intl.DateTimeFormat(lang.code, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }), [lang.code]);
  const operations = section === 'current' ? current
    : snapshot.operations.filter((operation) => !isMediaOperationActive(operation));
  const sorted = useMemo(() => [...operations].sort((a, b) => b.updatedAt - a.updatedAt), [operations]);

  useEffect(() => {
    if (!hasInitializedFocusRef.current || (isFull && !rootRef.current?.contains(document.activeElement))) {
      closeRef.current?.focus();
    }
    hasInitializedFocusRef.current = true;
  }, [isFull]);

  useEffect(() => {
    if (previousCurrentCountRef.current && !current.length && section === 'current') setSection('history');
    previousCurrentCountRef.current = current.length;
  }, [current.length, section]);

  const run = useLastCallback(async (id: string, task: () => Promise<void>) => {
    if (busyId) return;
    setBusyId(id);
    setActionError(undefined);
    try {
      await task();
    } catch (error) {
      setActionError({
        id, code: getMediaOperationErrorCode(error),
      });
    } finally {
      setBusyId(undefined);
    }
  });
  const selectSection = useLastCallback((value: 'current' | 'history') => {
    setSection(value);
    setLimit(50);
    setIsClearConfirm(false);
  });
  const handleKeys = useLastCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  });
  const handleTabs = useLastCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'current' : event.key === 'End' ? 'history'
      : section === 'current' ? 'history' : 'current';
    selectSection(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-section="${next}"]`)?.focus();
  });
  useEffect(() => captureKeyboardListeners({
    onEsc: (event) => {
      if (!rootRef.current?.contains(event.target as Node)) return false;
      event.preventDefault();
      onClose();
      return undefined;
    },
    // Allow the panel tablist's own handler through Telegram's global key capture.
    onLeft: (event) => rootRef.current?.contains(event.target as Node)
      ? ALLOW_KEYBOARD_EVENT_PROPAGATION : false,
    onRight: (event) => rootRef.current?.contains(event.target as Node)
      ? ALLOW_KEYBOARD_EVENT_PROPAGATION : false,
  }), [onClose]);

  const handleClear = useLastCallback(() => {
    if (!isClearConfirm) {
      setIsClearConfirm(true);
      return;
    }
    void run('clear', async () => {
      await clearMediaOperationHistory();
      setIsClearConfirm(false);
    });
  });

  return (
    <div
      className={buildClassName(styles.root, isFull && styles.full)}
      ref={rootRef}
      role="region"
      id="relay-media-operations"
      aria-labelledby="relay-operations-title"
      onKeyDown={handleKeys}
      data-relay-operations="true"
    >
      <header className={styles.header}>
        <h2 className={styles.heading} id="relay-operations-title">{lang('RelayOperationTitle')}</h2>
        <button
          type="button"
          ref={closeRef}
          className={buildClassName(styles.actionButton, styles.iconButton)}
          onClick={onClose}
          aria-label={lang(isFull ? 'RelayOperationBack' : 'RelayOperationClose')}
        >
          <Icon name={isFull ? 'arrow-left' : 'close'} />
        </button>
      </header>
      <div className={styles.tabs} role="tablist" aria-label={lang('RelayOperationTitle')} onKeyDown={handleTabs}>
        <button
          className={styles.tabButton}
          type="button"
          role="tab"
          id="relay-operations-current"
          data-section="current"
          aria-selected={section === 'current'}
          tabIndex={section === 'current' ? 0 : -1}
          aria-controls="relay-operations-list"
          onClick={() => selectSection('current')}
        >
          {lang('RelayOperationCurrent')}
          {current.length > 0 && <span className={styles.tabCount}>{current.length}</span>}
        </button>
        <button
          className={styles.tabButton}
          type="button"
          role="tab"
          id="relay-operations-history"
          data-section="history"
          aria-selected={section === 'history'}
          tabIndex={section === 'history' ? 0 : -1}
          aria-controls="relay-operations-list"
          onClick={() => selectSection('history')}
        >
          {lang('RelayOperationHistory')}
        </button>
      </div>
      <div
        id="relay-operations-list"
        className={styles.content}
        role="tabpanel"
        aria-labelledby={section === 'current' ? 'relay-operations-current' : 'relay-operations-history'}
        tabIndex={0}
      >
        {snapshot.isLocked ? <p className={styles.empty}>{lang('RelayOperationLocked')}</p>
          : snapshot.error ? (
            <p className={styles.error} role="alert">{lang(getMediaOperationErrorKey(snapshot.error))}</p>
          )
            : !sorted.length ? (
              <p className={styles.empty}>
                {lang(section === 'current'
                  ? 'RelayOperationEmptyCurrent' : 'RelayOperationEmptyHistory')}
              </p>
            )
              : (
                <ol className={styles.list}>
                  {sorted.slice(0, limit).map((operation) => {
                    const percent = getMediaOperationPercent(operation);
                    const active = isMediaOperationActive(operation);
                    const error = actionError?.id === operation.id ? actionError.code : operation.error;
                    const file = operation.files[0] || operation.media?.[0];
                    const title = file?.fileName || operation.fileName || lang('RelayOperationUnknownFile');
                    return (
                      <li
                        key={operation.id}
                        className={styles.operation}
                        data-operation-id={operation.id}
                        data-operation-stage={operation.stage}
                      >
                        <div className={styles.row}>
                          <Icon
                            name={operation.kind === 'send' ? 'send' : 'download'}
                            className={styles.operationIcon}
                          />
                          <span className={styles.kind}>
                            {lang(operation.kind === 'send' ? 'RelayOperationSend'
                              : operation.kind === 'save' ? 'RelayOperationSave' : 'RelayOperationDownload')}
                          </span>
                          <span className={styles.source}>
                            {operation.service === 'x' ? 'X'
                              : operation.service === 'instagram' ? 'Instagram' : 'Telegram'}
                          </span>
                          <time className={styles.timestamp} dateTime={new Date(operation.createdAt).toISOString()}>
                            {formatter.format(operation.createdAt)}
                          </time>
                        </div>
                        <h3 className={styles.operationTitle} dir="auto">{title}</h3>
                        {operation.send && (
                          <p className={styles.meta} dir="auto">
                            {operation.send.recipientName}
                            {' · '}
                            {lang(operation.mode === 'file' ? 'RelayOperationModeFile'
                              : operation.mode === 'media' ? 'RelayOperationModeMedia' : 'RelayOperationModeLink')}
                          </p>
                        )}
                        <p
                          className={buildClassName(styles.stage, operation.stage === 'uncertain' && styles.error)}
                          role="status"
                          aria-live="polite"
                        >
                          {lang(STAGE_KEYS[operation.stage])}
                        </p>
                        {active && percent !== undefined && (
                          <progress
                            className={styles.progress}
                            max={100}
                            value={percent}
                            aria-label={lang(STAGE_KEYS[operation.stage])}
                          >
                            {percent}
                            %
                          </progress>
                        )}
                        <div className={styles.meta}>
                          {percent !== undefined && `${percent}%`}
                          {operation.progress?.count !== undefined && (
                            <span>
                              {lang('RelayOperationItem')}
                              {' '}
                              {(operation.progress.index || 0) + 1}
                              {' '}
                              /
                              {' '}
                              {operation.progress.count}
                            </span>
                          )}
                          {operation.send && (
                            <span>
                              {lang('RelayOperationConfirmed')}
                              {' '}
                              {operation.send.confirmed}
                              {' '}
                              /
                              {' '}
                              {operation.send.total}
                            </span>
                          )}
                          {operation.attempt > 1 && (
                            <span>
                              {lang('RelayOperationAttempt')}
                              {' '}
                              {operation.attempt}
                            </span>
                          )}
                        </div>
                        {operation.media?.map((media, index) => (
                          <div className={styles.file} key={index}>
                            <span dir="auto">{media.fileName}</span>
                            <span className={styles.meta}>
                              {formatBytes(media.size)}
                              {' · '}
                              {media.mimeType}
                              {media.width && media.height ? ` · ${media.width} × ${media.height}` : ''}
                            </span>
                          </div>
                        ))}
                        {operation.files.map((saved, index) => (
                          <div className={styles.file} key={saved.path}>
                            <span dir="auto" title={saved.path}>{saved.fileName}</span>
                            <span className={styles.meta}>
                              {formatBytes(saved.size)}
                              {' · '}
                              {saved.mimeType}
                              {saved.width && saved.height ? ` · ${saved.width} × ${saved.height}` : ''}
                            </span>
                            <div className={styles.actions}>
                              <button
                                className={styles.actionButton}
                                type="button"
                                disabled={Boolean(busyId)}
                                onClick={() => {
                                  void run(operation.id, () => mediaOperationFileAction(operation.id, 'open', index));
                                }}
                              >
                                {lang('RelayOperationOpen')}
                              </button>
                              <button
                                className={styles.actionButton}
                                type="button"
                                disabled={Boolean(busyId)}
                                onClick={() => {
                                  void run(operation.id, () => mediaOperationFileAction(operation.id, 'reveal', index));
                                }}
                              >
                                {lang('RelayOperationReveal')}
                              </button>
                            </div>
                          </div>
                        ))}
                        {operation.journalWarning
                          && <p className={styles.error} role="alert">{lang('RelayOperationJournalWarning')}</p>}
                        {error && <p className={styles.error} role="alert">{lang(getMediaOperationErrorKey(error))}</p>}
                        {operation.stage === 'uncertain' && !error
                          && <p className={styles.error}>{lang('RelayOperationUncertainHelp')}</p>}
                        {operation.send && operation.stage === 'cancelling'
                          && <p className={styles.meta}>{lang('RelayOperationCancelHelp')}</p>}
                        <div className={styles.actions}>
                          {active && operation.stage !== 'cancelling' && (
                            <button
                              className={styles.actionButton}
                              type="button"
                              disabled={Boolean(busyId)}
                              onClick={() => { void run(operation.id, () => cancelMediaOperation(operation.id)); }}
                            >
                              {lang('RelayOperationCancel')}
                            </button>
                          )}
                          {['failed', 'interrupted', 'cancelled'].includes(operation.stage)
                            && operation.kind !== 'download'
                            && operation.sourceUrl && (
                            <button
                              className={styles.actionButton}
                              type="button"
                              disabled={Boolean(busyId)}
                              onClick={() => { void run(operation.id, () => retryMediaOperation(operation.id)); }}
                            >
                              {lang(operation.kind === 'save' && operation.files.length
                                ? 'RelayOperationSaveAgain' : 'RelayOperationRetry')}
                            </button>
                          )}
                          {operation.sourceUrl && (
                            <button
                              className={styles.actionButton}
                              type="button"
                              disabled={Boolean(busyId)}
                              onClick={() => { void run(operation.id, () => onSource(operation)); }}
                            >
                              {lang('RelayOperationSource')}
                            </button>
                          )}
                          {operation.send && (
                            <button
                              className={styles.actionButton}
                              type="button"
                              disabled={Boolean(busyId)}
                              onClick={() => { void run(operation.id, () => onChat(operation)); }}
                            >
                              {lang('RelayOperationChat')}
                            </button>
                          )}
                        </div>
                        {!operation.sourceUrl && <p className={styles.meta}>{lang('RelayOperationUnknownSource')}</p>}
                      </li>
                    );
                  })}
                </ol>
              )}
        {sorted.length > limit && (
          <button
            type="button"
            className={buildClassName(styles.actionButton, styles.more)}
            onClick={() => setLimit(limit + 50)}
          >
            {lang('RelayOperationMore')}
          </button>
        )}
      </div>
      <footer className={styles.footer}>
        <p className={styles.footerText}>{lang('RelayOperationPrivacy')}</p>
        {!snapshot.isLocked && section === 'history' && sorted.length > 0 && (
          <>
            <button className={styles.actionButton} type="button" onClick={handleClear} disabled={Boolean(busyId)}>
              {lang(isClearConfirm ? 'RelayOperationClearConfirm' : 'RelayOperationClear')}
            </button>
            {isClearConfirm && <p className={styles.footerText}>{lang('RelayOperationClearHelp')}</p>}
          </>
        )}
        {actionError?.id === 'clear' && (
          <p className={styles.footerText} role="alert">{lang(getMediaOperationErrorKey(actionError.code))}</p>
        )}
      </footer>
    </div>
  );
};

export default memo(MediaOperationsPanel);
