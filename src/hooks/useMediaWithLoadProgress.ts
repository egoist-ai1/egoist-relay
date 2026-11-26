import {
  useEffect, useRef, useState,
} from '../lib/teact/teact';

import { ApiMediaFormat } from '../api/types';

import { selectIsSynced } from '../global/selectors';
import { IS_PROGRESSIVE_SUPPORTED } from '../util/browser/windowEnvironment';
import * as mediaLoader from '../util/mediaLoader';
import useSelector from './data/useSelector';
import useForceUpdate from './useForceUpdate';
import useLastCallback from './useLastCallback';
import useThrottledCallback from './useThrottledCallback';
import useUniqueId from './useUniqueId';

const STREAMING_PROGRESS = 0.75;
const STREAMING_TIMEOUT = 1500;
const PROGRESS_THROTTLE = 500;
const MAX_ONLINE_RECOVERIES = 2;

export default function useMediaWithLoadProgress(
  mediaHash: string | undefined,
  noLoad = false,
  mediaFormat = ApiMediaFormat.BlobUrl,
  delay?: number | false,
  isHtmlAllowed = false,
  isPriority?: boolean,
  isResumable?: boolean,
) {
  const isStreaming = IS_PROGRESSIVE_SUPPORTED && mediaFormat === ApiMediaFormat.Progressive;
  const mediaData = mediaHash
    ? (isStreaming && !noLoad ? mediaLoader.getProgressiveUrl(mediaHash)
      : mediaLoader.getFromMemory(mediaHash, mediaFormat, isHtmlAllowed)) : undefined;

  const forceUpdate = useForceUpdate();
  const isSynced = useSelector(selectIsSynced);
  const id = useUniqueId();
  const [loadProgress, setLoadProgress] = useState(mediaData && !isStreaming ? 1 : 0);
  const [failedMediaHash, setFailedMediaHash] = useState<string>();
  const [retryAttempt, setRetryAttempt] = useState(0);
  const startedAtRef = useRef<number>();
  const onlineRecoveryCountRef = useRef(0);

  const retryLoad = useLastCallback(() => {
    setFailedMediaHash(undefined);
    setRetryAttempt((attempt) => attempt + 1);
  });

  const handleProgress = useThrottledCallback((progress: number) => {
    if (startedAtRef.current && id && (!delay || (Date.now() - startedAtRef.current > delay))) {
      setLoadProgress(progress);
    }
  }, [delay, id], PROGRESS_THROTTLE, true);

  useEffect(() => {
    if (noLoad || !mediaHash) return undefined;
    if (mediaData) {
      if (!isStreaming) return undefined;
      const streamingTimer = setTimeout(() => setLoadProgress(STREAMING_PROGRESS), STREAMING_TIMEOUT);
      return () => clearTimeout(streamingTimer);
    }

    let isCurrent = true;
    let redrawTimer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    startedAtRef.current = startedAt;
    setLoadProgress(0);
    setFailedMediaHash(undefined);

    const pending = mediaLoader.fetch(
      mediaHash, mediaFormat, isHtmlAllowed, handleProgress, id, isPriority, isResumable,
    );
    pending.then((result) => {
      if (!isCurrent) return;
      startedAtRef.current = undefined;
      if (!result) {
        setFailedMediaHash(mediaHash);
        return;
      }
      onlineRecoveryCountRef.current = 0;
      const spentTime = Date.now() - startedAt;
      if (!delay || spentTime >= delay) forceUpdate();
      else redrawTimer = setTimeout(forceUpdate, delay - spentTime);
    });

    return () => {
      isCurrent = false;
      clearTimeout(redrawTimer);
      if (startedAtRef.current) mediaLoader.cancelProgress(handleProgress);
      startedAtRef.current = undefined;
    };
  }, [
    noLoad, mediaHash, mediaData, mediaFormat, isStreaming, delay, handleProgress, isHtmlAllowed, id,
    isSynced, retryAttempt, isPriority, isResumable,
  ]);

  useEffect(() => {
    onlineRecoveryCountRef.current = 0;
  }, [mediaHash, mediaFormat, isHtmlAllowed]);

  useEffect(() => {
    if (noLoad || !mediaHash || mediaData || failedMediaHash !== mediaHash) return undefined;
    let wasOffline = navigator.onLine === false;
    const handleOffline = () => {
      wasOffline = true;
    };
    const handleOnline = () => {
      if (!wasOffline || navigator.onLine === false || onlineRecoveryCountRef.current >= MAX_ONLINE_RECOVERIES) return;
      wasOffline = false;
      onlineRecoveryCountRef.current++;
      retryLoad();
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [noLoad, mediaHash, mediaFormat, mediaData, isHtmlAllowed, failedMediaHash, retryLoad]);

  useEffect(() => {
    if (!mediaHash) return undefined;
    const release = mediaLoader.retainMedia(mediaHash, mediaFormat, isHtmlAllowed);
    return () => {
      mediaLoader.removeCallback(mediaHash, id, mediaFormat, isHtmlAllowed);
      release();
    };
  }, [id, mediaHash, mediaFormat, isHtmlAllowed]);

  const hasLoadError = Boolean(!noLoad && !mediaData && mediaHash && failedMediaHash === mediaHash);
  return {
    mediaData, loadProgress, hasLoadError, retryLoad,
  };
}
