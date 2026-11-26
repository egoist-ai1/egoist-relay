import { memo, useEffect, useRef, useUnmountCleanup } from '../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../global';

import type { ApiOnProgress } from '../../api/types';
import type { TabState } from '../../global/types';
import type { NativeMediaDownload } from '../../util/tauri/mediaDownload';
import { ApiMediaFormat } from '../../api/types';

import { selectTabState } from '../../global/selectors';
import { IS_TAURI } from '../../util/browser/globalEnvironment';
import { IS_OPFS_SUPPORTED, IS_SERVICE_WORKER_SUPPORTED, MAX_BUFFER_SIZE } from '../../util/browser/windowEnvironment';
import download from '../../util/download';
import generateUniqueId from '../../util/generateUniqueId';
import * as mediaLoader from '../../util/mediaLoader';
import { normalizeNativeDownloadFileName, prepareNativeMediaDownload } from '../../util/tauri/mediaDownload';
import { mediaOperationFileAction } from '../multi/mediaOperations';
import {
  buildRecoveryRequest, changeTelegramDownloadQueue, getPublicDownloadSource, restoreTelegramDownloadQueue,
} from './telegramDownloadRecovery';

import useLastCallback from '../../hooks/useLastCallback';
import useRunDebounced from '../../hooks/useRunDebounced';

type StateProps = {
  activeDownloads: TabState['activeDownloads'];
  recoveryAccountId?: string;
  canRestore?: boolean;
};

type DownloadMetadata = StateProps['activeDownloads'][string];
type DownloadJob = {
  metadata: DownloadMetadata;
  release: NoneToVoidFunction;
  progress?: ApiOnProgress;
  native?: NativeMediaDownload;
  recovery?: { id: string; accountId: string; remembered: Promise<unknown> };
  hasSettled?: boolean;
};

type RecoveryScope = { abort: AbortController; attempted: Set<string>; isRunning: boolean };

const GLOBAL_UPDATE_DEBOUNCE = 1000;

const DownloadManager = ({ activeDownloads, recoveryAccountId, canRestore }: StateProps) => {
  const { cancelMediaHashDownloads, showNotification } = getActions();
  const jobsRef = useRef(new Map<string, DownloadJob>());
  const completedRef = useRef(new Map<string, DownloadMetadata>());
  const recoveryScopeRef = useRef<RecoveryScope>();
  const runDebounced = useRunDebounced(GLOBAL_UPDATE_DEBOUNCE, true);

  const restoreQueue = useLastCallback(() => {
    const scope = recoveryScopeRef.current;
    if (!scope || scope.isRunning || !recoveryAccountId) return;
    scope.isRunning = true;
    void restoreTelegramDownloadQueue(recoveryAccountId, scope.attempted, scope.abort.signal)
      .catch(() => undefined).finally(() => { scope.isRunning = false; });
  });

  useEffect(() => {
    if (!IS_TAURI || !recoveryAccountId || !canRestore) return undefined;
    const scope = { abort: new AbortController(), attempted: new Set<string>(), isRunning: false };
    recoveryScopeRef.current = scope;
    restoreQueue();
    // При первом запуске оболочка может ещё разблокировать журнал
    const retry = setTimeout(restoreQueue, GLOBAL_UPDATE_DEBOUNCE);
    window.addEventListener('online', restoreQueue);
    return () => {
      scope.abort.abort();
      recoveryScopeRef.current = undefined;
      clearTimeout(retry);
      window.removeEventListener('online', restoreQueue);
    };
  }, [recoveryAccountId, canRestore, restoreQueue]);

  const handleMediaFinished = useLastCallback((hash: string, metadata: DownloadMetadata) => {
    completedRef.current.set(hash, metadata);
    runDebounced(() => {
      const currentDownloads = selectTabState(getGlobal()).activeDownloads;
      const mediaHashes = Array.from(completedRef.current)
        .filter(([mediaHash, completed]) => currentDownloads[mediaHash] === completed)
        .map(([mediaHash]) => mediaHash);
      completedRef.current.clear();
      if (mediaHashes.length) cancelMediaHashDownloads({ mediaHashes });
    });
  });

  useUnmountCleanup(() => {
    jobsRef.current.forEach((job) => {
      job.release();
      void job.native?.cancel().catch(() => undefined);
      if (job.progress) mediaLoader.cancelProgress(job.progress);
    });
    jobsRef.current.clear();
    completedRef.current.clear();
  });

  useEffect(() => {
    const jobs = jobsRef.current;
    jobs.forEach((job, hash) => {
      if (activeDownloads[hash] === job.metadata) return;
      job.release();
      void job.native?.cancel().catch(() => undefined);
      if (job.progress) mediaLoader.cancelProgress(job.progress);
      if (!job.hasSettled) void forgetRecovery(job);
      jobs.delete(hash);
    });

    Object.entries(activeDownloads).forEach(([mediaHash, metadata]) => {
      if (jobs.has(mediaHash)) return;
      const {
        size, filename, format: mediaFormat, localUrl, copyToClipboard,
      } = metadata;
      const job: DownloadJob = { metadata, release: mediaLoader.retainMedia(mediaHash, mediaFormat, true) };
      jobs.set(mediaHash, job);
      const isCurrent = () => jobs.get(mediaHash) === job
        && selectTabState(getGlobal()).activeDownloads[mediaHash] === metadata;
      const handleFailure = () => {
        if (!isCurrent()) return;
        job.hasSettled = true;
        showNotification({ message: { key: 'RelayDownloadFailed' } });
        handleMediaFinished(mediaHash, metadata);
      };

      if (size > MAX_BUFFER_SIZE && !IS_OPFS_SUPPORTED && !IS_SERVICE_WORKER_SUPPORTED) {
        showNotification({ message: { key: 'RelayDownloadTooLarge' } });
        handleMediaFinished(mediaHash, metadata);
        job.release();
        return;
      }

      const handleProgress: ApiOnProgress = () => {
        if (!isCurrent()) mediaLoader.cancelProgress(handleProgress);
      };
      job.progress = handleProgress;
      const request = IS_TAURI && recoveryAccountId && !localUrl
        ? buildRecoveryRequest(mediaHash, metadata) : undefined;
      if (request && recoveryAccountId) {
        job.recovery = {
          id: request.id,
          accountId: recoveryAccountId,
          remembered: changeTelegramDownloadQueue(recoveryAccountId, { type: 'remember', request })
            .catch(() => undefined),
        };
      }
      const cached = localUrl || mediaLoader.getFromMemory(mediaHash, mediaFormat, true);
      const pending = Promise.resolve(job.recovery?.remembered).then(() => {
        if (!isCurrent()) return undefined;
        return cached || mediaLoader.fetch(
          mediaHash, mediaFormat, true, handleProgress, generateUniqueId(), undefined, IS_TAURI,
        );
      });
      void pending.then(async (result) => {
        if (!isCurrent()) return;
        if (!result) {
          handleFailure();
          return;
        }
        const destinationName = IS_TAURI ? await normalizeNativeDownloadFileName(filename) : filename;
        if (!isCurrent()) return;
        const prepareDownload = async (url: string) => {
          if (!IS_TAURI) return;
          job.native = await prepareNativeMediaDownload(url, destinationName, getPublicDownloadSource(metadata));
          const recovery = job.recovery;
          if (recovery) {
            await changeTelegramDownloadQueue(recovery.accountId, {
              type: 'associate', id: recovery.id, operationId: job.native.id,
            }).catch(() => undefined);
          }
        };
        if (mediaFormat === ApiMediaFormat.DownloadUrl && !result.startsWith('blob:')) {
          const url = new URL(result, window.document.baseURI);
          url.searchParams.set('filename', encodeURIComponent(destinationName));
          await prepareDownload(url.toString());
          if (!isCurrent()) {
            await job.native?.cancel();
            return;
          }
          const downloadWindow = window.open(url.toString());
          if (!downloadWindow) {
            handleFailure();
            return;
          }
          downloadWindow.addEventListener('beforeunload', () => {
            showNotification({ message: { key: 'RelayDownloadStarted' } });
          }, { once: true });
        } else {
          await prepareDownload(result);
          const didStart = await download(result, destinationName, () => !isCurrent());
          if (!isCurrent()) return;
          if (!didStart) {
            await job.native?.cancel();
            handleFailure();
            return;
          }
        }
        if (job.native) {
          const nativeResult = await job.native.completed;
          if (!isCurrent()) return;
          if (!nativeResult.success && !nativeResult.error?.includes('CANCEL')) {
            handleFailure();
            return;
          }
          if (nativeResult.success && copyToClipboard && !getGlobal().passcode?.isScreenLocked) {
            const copied = await mediaOperationFileAction(nativeResult.operationId, 'copyFile')
              .then(() => true, () => false);
            if (isCurrent() && !getGlobal().passcode?.isScreenLocked) {
              showNotification({
                message: { key: copied ? 'RelayMediaFileCopied' : 'RelayMediaCopyFileFailed' },
              });
            }
          }
        }
        job.hasSettled = true;
        await forgetRecovery(job);
        handleMediaFinished(mediaHash, metadata);
      }).catch(handleFailure).finally(job.release);
    });
    restoreQueue();
  }, [activeDownloads, recoveryAccountId, restoreQueue]);

  return undefined;
};

async function forgetRecovery(job: DownloadJob) {
  const recovery = job.recovery;
  if (!recovery) return;
  await recovery.remembered;
  await changeTelegramDownloadQueue(recovery.accountId, { type: 'forget', id: recovery.id }).catch(() => undefined);
}

export default memo(withGlobal(
  (global): Complete<StateProps> => ({
    activeDownloads: selectTabState(global).activeDownloads,
    recoveryAccountId: global.currentUserId,
    canRestore: global.isSynced && !global.passcode?.isScreenLocked,
  }),
)(DownloadManager));
