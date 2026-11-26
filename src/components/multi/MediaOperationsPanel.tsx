import { memo, useEffect, useMemo, useRef, useState } from '../../lib/teact/teact';

import type { RegularLangKey } from '../../types/language';
import type { MediaOperation, MediaOperationsSnapshot, MediaOperationStage } from './mediaOperations.types';
import type { MediaOperationTransferState } from './mediaOperationTransfer';

import buildClassName from '../../util/buildClassName';
import captureKeyboardListeners, { ALLOW_KEYBOARD_EVENT_PROPAGATION } from '../../util/captureKeyboardListeners';
import { formatClockDuration } from '../../util/localization/dateFormat';
import { formatFileSize } from '../../util/textFormat';
import {
  cancelMediaOperation, clearMediaOperationHistory, getMediaOperationErrorCode, mediaOperationFileAction,
  retryMediaOperation,
} from './mediaOperations';
import { getMediaOperationPercent, isMediaOperationActive } from './mediaOperations.types';
import { getMediaOperationTransferEstimate, sampleMediaOperationTransfer } from './mediaOperationTransfer';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Icon from '../common/icons/Icon';
import MediaLibrary from './MediaLibrary';

import styles from './MediaOperationsPanel.module.scss';

type OwnProps = {
  snapshot: MediaOperationsSnapshot;
  isFull: boolean;
  initialSection?: 'saved';
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
const SECTIONS = ['current', 'history', 'saved'] as const;
type Section = typeof SECTIONS[number];
type OperationFeedback = { error?: string; isCopied?: boolean; isCopyError?: boolean };
type OperationControl = { key: RegularLangKey; action: () => Promise<void> };

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
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} ГБ`;
}

const MediaOperationsPanel = ({ snapshot, isFull, initialSection, onClose, onSource, onChat }: OwnProps) => {
  const lang = useLang();
  const closeRef = useRef<HTMLButtonElement>();
  const rootRef = useRef<HTMLDivElement>();
  const hasInitializedFocusRef = useRef(false);
  const pendingRef = useRef(new Set<string>());
  const current = useMemo(() => snapshot.operations.filter(isMediaOperationActive), [snapshot.operations]);
  const previousCurrentCountRef = useRef(current.length);
  const [section, setSection] = useState<Section>(initialSection || (current.length ? 'current' : 'history'));
  const [limit, setLimit] = useState(50);
  const [pendingIds, setPendingIds] = useState(() => new Set<string>());
  const [feedback, setFeedback] = useState(() => new Map<string, OperationFeedback>());
  const [expandedId, setExpandedId] = useState<string>();
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);
  const [isClearConfirm, setIsClearConfirm] = useState(false);
  const [transferSamples, setTransferSamples] = useState<Map<string, MediaOperationTransferState>>(() => new Map());
  const formatter = useMemo(() => new Intl.DateTimeFormat(lang.code, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }), [lang.code]);
  const sorted = useMemo(() => (
    (section === 'current' ? [...current]
      : snapshot.operations.filter((operation) => !isMediaOperationActive(operation)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  ), [current, section, snapshot.operations]);
  const libraryRefreshKey = useMemo(() => {
    if (section !== 'saved') return '';
    return snapshot.operations
      .filter((operation) => operation.files.length && (operation.kind === 'save' || operation.kind === 'download'))
      .map((operation) => `${operation.id}:${operation.files.map((file) => `${file.path}:${file.size}`).join(',')}`)
      .join('|');
  }, [section, snapshot.operations]);

  useEffect(() => {
    const now = performance.now();
    setTransferSamples((previous) => {
      const next = new Map<string, MediaOperationTransferState>();
      if (!snapshot.isLocked) {
        for (const operation of current) {
          const samples = sampleMediaOperationTransfer(previous.get(operation.id), operation, now);
          if (samples) next.set(operation.id, samples);
        }
      }
      return next;
    });
  }, [current, snapshot.isLocked]);

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

  const updateFeedback = useLastCallback((id: string, value?: OperationFeedback) => {
    setFeedback((previous) => {
      const next = new Map(previous);
      if (value) next.set(id, value);
      else next.delete(id);
      return next;
    });
  });
  const run = useLastCallback(async (id: string, task: () => Promise<void>, isCopy?: boolean) => {
    const pending = pendingRef.current;
    if (snapshot.isLocked || pending.has(id)) return;
    pending.add(id);
    setPendingIds(new Set(pending));
    updateFeedback(id);
    try {
      await task();
      if (isCopy && pendingRef.current === pending) updateFeedback(id, { isCopied: true });
    } catch (error) {
      if (pendingRef.current === pending) {
        updateFeedback(id, { error: getMediaOperationErrorCode(error), isCopyError: isCopy });
      }
    } finally {
      pending.delete(id);
      if (pendingRef.current === pending) setPendingIds(new Set(pending));
    }
  });
  const selectSection = useLastCallback((value: Section) => {
    setSection(value);
    setLimit(50);
    setExpandedId(undefined);
    setIsHistoryExpanded(false);
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
    const focused = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-section]');
    const focusedIndex = SECTIONS.findIndex((value) => value === focused?.dataset.section);
    const index = focusedIndex < 0 ? SECTIONS.indexOf(section) : focusedIndex;
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    const direction = getComputedStyle(event.currentTarget).direction === 'rtl' ? -step : step;
    const next = event.key === 'Home' ? SECTIONS[0] : event.key === 'End' ? SECTIONS[SECTIONS.length - 1]
      : SECTIONS[(index + direction + SECTIONS.length) % SECTIONS.length];
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
  const historyError = feedback.get('clear')?.error;

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
        <button
          className={styles.tabButton}
          type="button"
          role="tab"
          id="relay-operations-saved"
          data-section="saved"
          aria-selected={section === 'saved'}
          tabIndex={section === 'saved' ? 0 : -1}
          aria-controls="relay-operations-list"
          onClick={() => selectSection('saved')}
        >
          {lang('RelayLibraryTitle')}
        </button>
      </div>
      <div
        id="relay-operations-list"
        className={styles.content}
        role="tabpanel"
        aria-labelledby={`relay-operations-${section}`}
        tabIndex={0}
      >
        {section === 'saved' ? <MediaLibrary isLocked={snapshot.isLocked} refreshKey={libraryRefreshKey} />
          : snapshot.isLocked ? <p className={styles.empty}>{lang('RelayOperationLocked')}</p>
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
                      const { id, stage } = operation;
                      const itemFeedback = feedback.get(id);
                      const error = itemFeedback?.error || operation.error;
                      const isExpanded = expandedId === id;
                      const isPending = pendingIds.has(id);
                      const isActive = isMediaOperationActive(operation);
                      const percent = getMediaOperationPercent(operation);
                      const title = operation.files[0]?.fileName || operation.media?.[0]?.fileName
                        || operation.fileName || lang('RelayOperationUnknownFile');
                      const controls = getOperationControls(operation, onSource, onChat);
                      const primary = controls[0];
                      const transfer = getMediaOperationTransferEstimate(
                        transferSamples.get(id), operation, performance.now(),
                      );
                      const service = lang(operation.service === 'x' ? 'RelayXTitle'
                        : operation.service === 'instagram' ? 'RelayInstagramTitle' : 'RelayTelegramTitle');
                      const detailsId = `relay-operation-details-${id}`;
                      const detailsLabel = lang(isExpanded ? 'RelayOperationHideDetails' : 'RelayOperationDetails');
                      const { count, index: progressIndex } = operation.progress || {};
                      const hasFileProgress = count !== undefined && progressIndex !== undefined;
                      const files = operation.files.length ? operation.files : operation.media || [];
                      return (
                        <li
                          key={id}
                          className={styles.operation}
                          data-operation-id={id}
                          data-operation-stage={stage}
                        >
                          <div className={styles.summary}>
                            <div className={styles.summaryText}>
                              <h3 className={styles.operationTitle} dir="auto">{title}</h3>
                              <div className={styles.row}>
                                <span>{service}</span>
                                <span className={styles.separator} aria-hidden="true">·</span>
                                <span
                                  className={buildClassName(styles.stage, stage === 'uncertain' && styles.stageError)}
                                  role="status"
                                >
                                  {lang(STAGE_KEYS[stage])}
                                </span>
                                {percent !== undefined && <span className={styles.percent}>{`${percent}%`}</span>}
                              </div>
                            </div>
                            <div className={styles.summaryActions}>
                              {primary && (
                                <button
                                  className={buildClassName(styles.actionButton, styles.primaryAction)}
                                  type="button"
                                  disabled={isPending}
                                  onClick={() => { void run(id, primary.action); }}
                                >
                                  {lang(primary.key)}
                                </button>
                              )}
                              <button
                                className={buildClassName(styles.actionButton, styles.iconButton)}
                                type="button"
                                aria-label={`${detailsLabel} · ${title}`}
                                aria-expanded={isExpanded}
                                aria-controls={detailsId}
                                data-operation-details-toggle="true"
                                onClick={() => setExpandedId(isExpanded ? undefined : id)}
                              >
                                <Icon name={isExpanded ? 'up' : 'more'} />
                              </button>
                            </div>
                          </div>
                          {isActive && percent !== undefined && (
                            <progress
                              className={styles.progress}
                              max={100}
                              value={percent}
                              aria-label={lang(STAGE_KEYS[stage])}
                            />
                          )}
                          {transfer && (
                            <p className={buildClassName(styles.meta, styles.transfer)} data-operation-transfer="true">
                              <span>
                                {lang('RelayOperationSpeed', {
                                  speed: formatFileSize(lang, Math.max(1, Math.round(transfer.bytesPerSecond))),
                                })}
                              </span>
                              <span>
                                {lang('RelayOperationEta', { time: formatClockDuration(transfer.remainingSeconds) })}
                              </span>
                            </p>
                          )}
                          {operation.journalWarning
                            && <p className={styles.error} role="alert">{lang('RelayOperationJournalWarning')}</p>}
                          {error && (
                            <p className={styles.error} role="alert">
                              {lang(itemFeedback?.isCopyError && error === 'MEDIA_OPERATION_FAILED'
                                ? 'RelayMediaCopyFileFailed' : getMediaOperationErrorKey(error))}
                            </p>
                          )}
                          {itemFeedback?.isCopied && (
                            <p className={styles.meta} role="status">{lang('RelayMediaFileCopied')}</p>
                          )}
                          {stage === 'uncertain' && !error
                            && <p className={styles.error}>{lang('RelayOperationUncertainHelp')}</p>}
                          {operation.send && stage === 'cancelling'
                            && <p className={styles.meta}>{lang('RelayOperationCancelHelp')}</p>}
                          <div id={detailsId} hidden={!isExpanded} className={styles.details}>
                            {isExpanded && (
                              <>
                                <div className={styles.row}>
                                  <Icon
                                    name={operation.kind === 'send' ? 'send' : 'download'}
                                    className={styles.operationIcon}
                                  />
                                  <span>
                                    {lang(operation.kind === 'send' ? 'RelayOperationSend'
                                      : operation.kind === 'save' ? 'RelayOperationSave' : 'RelayOperationDownload')}
                                  </span>
                                  <time dateTime={new Date(operation.createdAt).toISOString()}>
                                    {formatter.format(operation.createdAt)}
                                  </time>
                                </div>
                                {operation.send && (
                                  <p className={styles.meta} dir="auto">
                                    {operation.send.recipientName}
                                    {' · '}
                                    {lang(operation.mode === 'file' ? 'RelayOperationModeFile'
                                      : operation.mode === 'media' ? 'RelayOperationModeMedia'
                                        : 'RelayOperationModeLink')}
                                    {' · '}
                                    {lang('RelayOperationConfirmed')}
                                    {' '}
                                    {`${operation.send.confirmed} / ${operation.send.total}`}
                                  </p>
                                )}
                                {(hasFileProgress || operation.attempt > 1) && (
                                  <div className={styles.meta}>
                                    {hasFileProgress && <span>{`${progressIndex + 1} / ${count}`}</span>}
                                    {operation.attempt > 1 && (
                                      <span>
                                        {lang('RelayOperationAttempt')}
                                        {' '}
                                        {operation.attempt}
                                      </span>
                                    )}
                                  </div>
                                )}
                                {files.map((file, index) => (
                                  <div className={styles.file} key={index}>
                                    {(index > 0 || file.fileName !== title) && <span dir="auto">{file.fileName}</span>}
                                    <span className={styles.meta}>
                                      {formatBytes(file.size)}
                                      {' · '}
                                      {file.mimeType}
                                      {file.width && file.height ? ` · ${file.width} × ${file.height}` : ''}
                                    </span>
                                    {operation.files.length > 0 && (
                                      <div className={styles.actions}>
                                        {index > 0 && (
                                          <button
                                            className={styles.actionButton}
                                            type="button"
                                            disabled={isPending}
                                            onClick={() => {
                                              void run(id, () => mediaOperationFileAction(id, 'open', index));
                                            }}
                                          >
                                            {lang('RelayOperationOpen')}
                                          </button>
                                        )}
                                        <button
                                          className={styles.actionButton}
                                          type="button"
                                          disabled={isPending}
                                          onClick={() => {
                                            void run(id, () => mediaOperationFileAction(id, 'reveal', index));
                                          }}
                                        >
                                          {lang('RelayOperationReveal')}
                                        </button>
                                        <button
                                          className={styles.actionButton}
                                          type="button"
                                          disabled={isPending}
                                          onClick={() => {
                                            void run(id, () => mediaOperationFileAction(id, 'copyFile', index), true);
                                          }}
                                        >
                                          {lang('RelayMediaCopyFile')}
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                ))}
                                {controls.length > 1 && (
                                  <div className={styles.actions}>
                                    {controls.slice(1).map(({ key, action }) => (
                                      <button
                                        key={key}
                                        className={styles.actionButton}
                                        type="button"
                                        disabled={isPending}
                                        onClick={() => { void run(id, action); }}
                                      >
                                        {lang(key)}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
        {section !== 'saved' && sorted.length > limit && (
          <button
            type="button"
            className={buildClassName(styles.actionButton, styles.more)}
            onClick={() => setLimit(limit + 50)}
          >
            {lang('RelayOperationMore')}
          </button>
        )}
      </div>
      {section === 'history' && !snapshot.isLocked && (
        <footer className={styles.footer}>
          <button
            className={styles.actionButton}
            type="button"
            aria-expanded={isHistoryExpanded}
            aria-controls="relay-operation-history-actions"
            onClick={() => {
              setIsHistoryExpanded(!isHistoryExpanded);
              setIsClearConfirm(false);
            }}
          >
            {lang('RelayOperationHistory')}
            {' · '}
            {lang(isHistoryExpanded ? 'RelayOperationHideDetails' : 'RelayOperationDetails')}
          </button>
          <div className={styles.historyActions} id="relay-operation-history-actions" hidden={!isHistoryExpanded}>
            {isHistoryExpanded && (
              <>
                <p className={styles.footerText}>{lang('RelayOperationPrivacy')}</p>
                {sorted.length > 0 && (
                  <button
                    className={styles.actionButton}
                    type="button"
                    onClick={handleClear}
                    disabled={pendingIds.has('clear')}
                  >
                    {lang(isClearConfirm ? 'RelayOperationClearConfirm' : 'RelayOperationClear')}
                  </button>
                )}
                {isClearConfirm && <p className={styles.footerText}>{lang('RelayOperationClearHelp')}</p>}
                {historyError && (
                  <p className={styles.footerText} role="alert">
                    {lang(getMediaOperationErrorKey(historyError))}
                  </p>
                )}
              </>
            )}
          </div>
        </footer>
      )}
    </div>
  );
};

function getOperationControls(
  operation: MediaOperation,
  onSource: OwnProps['onSource'],
  onChat: OwnProps['onChat'],
): OperationControl[] {
  const { id, stage } = operation;
  const controls: OperationControl[] = [];
  if (isMediaOperationActive(operation) && stage !== 'cancelling') {
    controls.push({ key: 'RelayOperationCancel', action: () => cancelMediaOperation(id) });
  }
  if (['failed', 'interrupted', 'cancelled'].includes(stage)
    && operation.kind !== 'download' && operation.service !== 'instagram' && operation.sourceUrl) {
    controls.push({
      key: operation.kind === 'save' && operation.files.length ? 'RelayOperationSaveAgain' : 'RelayOperationRetry',
      action: () => retryMediaOperation(id),
    });
  }
  if (operation.files.length > 0) {
    controls.push({ key: 'RelayOperationOpen', action: () => mediaOperationFileAction(id, 'open', 0) });
  }
  if (operation.sourceUrl) controls.push({ key: 'RelayOperationSource', action: () => onSource(operation) });
  if (operation.send) controls.push({ key: 'RelayOperationChat', action: () => onChat(operation) });
  return controls;
}

export default memo(MediaOperationsPanel);
