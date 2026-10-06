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

import useLastCallback from '../../hooks/useLastCallback';
import useRunDebounced from '../../hooks/useRunDebounced';

type StateProps = {
  activeDownloads: TabState['activeDownloads'];
};

type DownloadMetadata = StateProps['activeDownloads'][string];
type DownloadJob = {
  metadata: DownloadMetadata;
  release: NoneToVoidFunction;
  progress?: ApiOnProgress;
  native?: NativeMediaDownload;
};

const GLOBAL_UPDATE_DEBOUNCE = 1000;

const DownloadManager = ({ activeDownloads }: StateProps) => {
  const { cancelMediaHashDownloads, showNotification } = getActions();
  const jobsRef = useRef(new Map<string, DownloadJob>());
  const completedRef = useRef(new Map<string, DownloadMetadata>());
  const runDebounced = useRunDebounced(GLOBAL_UPDATE_DEBOUNCE, true);

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
      jobs.delete(hash);
    });

    Object.entries(activeDownloads).forEach(([mediaHash, metadata]) => {
      if (jobs.has(mediaHash)) return;
      const { size, filename, format: mediaFormat } = metadata;
      const job: DownloadJob = { metadata, release: mediaLoader.retainMedia(mediaHash, mediaFormat, true) };
      jobs.set(mediaHash, job);
      const isCurrent = () => jobs.get(mediaHash) === job
        && selectTabState(getGlobal()).activeDownloads[mediaHash] === metadata;
      const handleFailure = () => {
        if (!isCurrent()) return;
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
      const cached = mediaLoader.getFromMemory(mediaHash, mediaFormat, true);
      const pending = cached ? Promise.resolve(cached)
        : mediaLoader.fetch(mediaHash, mediaFormat, true, handleProgress, generateUniqueId());
      void pending.then(async (result) => {
        if (!isCurrent()) return;
        if (!result) {
          handleFailure();
          return;
        }
        const destinationName = IS_TAURI ? await normalizeNativeDownloadFileName(filename) : filename;
        if (!isCurrent()) return;
        if (mediaFormat === ApiMediaFormat.DownloadUrl && !result.startsWith('blob:')) {
          const url = new URL(result, window.document.baseURI);
          url.searchParams.set('filename', encodeURIComponent(destinationName));
          if (IS_TAURI) job.native = await prepareNativeMediaDownload(url.toString(), destinationName);
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
          if (IS_TAURI) job.native = await prepareNativeMediaDownload(result, destinationName);
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
        }
        handleMediaFinished(mediaHash, metadata);
      }).catch(handleFailure).finally(job.release);
    });
  }, [activeDownloads]);

  return undefined;
};

export default memo(withGlobal(
  (global): Complete<StateProps> => ({ activeDownloads: selectTabState(global).activeDownloads }),
)(DownloadManager));
