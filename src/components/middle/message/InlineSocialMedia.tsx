import { memo, useEffect, useRef, useState, useUnmountCleanup } from '../../../lib/teact/teact';

import type { RegularLangKey } from '../../../types/language';
import type { InlineSocialMediaSource } from '../../../util/inlineSocialMedia';

import { requestMutation } from '../../../lib/fasterdom/fasterdom';
import buildClassName from '../../../util/buildClassName';
import {
  buildInlineSocialMediaEmbedUrl, INLINE_MEDIA_SERVICE_EVENT,
} from '../../../util/inlineSocialMedia';
import resolveInlineMedia, { saveInlineMedia } from '../../../util/resolveInlineMedia';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useUniqueId from '../../../hooks/useUniqueId';

import styles from './InlineSocialMedia.module.scss';

type OwnProps = {
  source: InlineSocialMediaSource;
  activationKey?: number;
  canAutoLoad?: boolean;
  canAutoPlay?: boolean;
  isMessageListActive?: boolean;
  onLayoutChange?: (url: string, isVertical: boolean, aspectRatio: number) => void;
};

type PlayerSession = { key: number; canPlay: boolean; mode: 'embed' | 'native' };
type PlayerState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'error';

const LOAD_TIMEOUT_MS = 20000;
const API_HANDSHAKE_INTERVAL_MS = 500;
const MIN_VISIBLE_RATIO = 0.5;
const YOUTUBE_ORIGIN = 'https://www.youtube-nocookie.com';
const PROVIDER_NAMES = { youtube: 'YouTube', instagram: 'Instagram', x: 'X' };
const MEDIA_ERROR_CODES = new Set([
  'MEDIA_AUTH_REQUIRED', 'MEDIA_SESSION_LIMIT', 'MEDIA_PROXY_FAILED', 'MEDIA_PROXY_DENIED', 'MEDIA_TLS_FAILED',
  'MEDIA_FETCH_FAILED', 'MEDIA_TIMEOUT', 'MEDIA_FORMAT_UNAVAILABLE', 'MEDIA_DURATION_LIMIT', 'MEDIA_DURATION_UNKNOWN',
  'MEDIA_TOO_LARGE', 'MEDIA_PARTIAL_BODY', 'MEDIA_BUSY', 'MEDIA_RUNTIME_UNAVAILABLE', 'MEDIA_UNAVAILABLE',
  'MEDIA_CLEANUP_FAILED', 'MEDIA_CANCELLED', 'MEDIA_URL_DENIED', 'MEDIA_INPUT_DENIED', 'MEDIA_PATH_DENIED',
  'MEDIA_METADATA_INVALID', 'MEDIA_METADATA_TOO_LARGE', 'MEDIA_MULTIPLE_ITEMS', 'MEDIA_SOURCE_DENIED',
  'MEDIA_BOT_CHECK', 'MEDIA_GEO_BLOCKED', 'MEDIA_RATE_LIMITED', 'MEDIA_HTTP_FORBIDDEN', 'MEDIA_PLAYBACK_FAILED',
]);
const RECOVERABLE_EMBED_ERROR_CODES = new Set([
  'MEDIA_PLAYBACK_FAILED', 'MEDIA_CLIENT_IDENTITY', 'MEDIA_FETCH_FAILED', 'MEDIA_TIMEOUT',
]);
const YOUTUBE_ERROR_CODES: Record<number, string> = {
  2: 'MEDIA_INPUT_DENIED',
  5: 'MEDIA_PLAYBACK_FAILED',
  100: 'MEDIA_UNAVAILABLE',
  101: 'MEDIA_EMBED_DENIED',
  150: 'MEDIA_EMBED_DENIED',
  153: 'MEDIA_CLIENT_IDENTITY',
};
const MEDIA_ERROR_LANG_KEYS: Record<string, RegularLangKey> = {
  MEDIA_PROXY_FAILED: 'RelayInlineMediaConnection',
  MEDIA_PROXY_DENIED: 'RelayInlineMediaConnection',
  MEDIA_TLS_FAILED: 'RelayInlineMediaConnection',
  MEDIA_FETCH_FAILED: 'RelayInlineMediaConnection',
  MEDIA_TIMEOUT: 'RelayInlineMediaConnection',
  MEDIA_TOO_LARGE: 'RelayInlineMediaLimit',
  MEDIA_DURATION_LIMIT: 'RelayInlineMediaLimit',
  MEDIA_BOT_CHECK: 'RelayInlineMediaBotCheck',
  MEDIA_GEO_BLOCKED: 'RelayInlineMediaGeoBlocked',
  MEDIA_RATE_LIMITED: 'RelayInlineMediaRateLimited',
  MEDIA_HTTP_FORBIDDEN: 'RelayInlineMediaForbidden',
  MEDIA_EMBED_DENIED: 'RelayInlineMediaEmbedDenied',
  MEDIA_CLIENT_IDENTITY: 'RelayInlineMediaIdentity',
  MEDIA_PLAYBACK_FAILED: 'RelayInlineMediaPlayback',
};
let activePlayer: { id: string; stop: NoneToVoidFunction } | undefined;

export function stopInlineSocialMedia() {
  activePlayer?.stop();
}

const InlineSocialMedia = ({
  source, activationKey, canAutoLoad, canAutoPlay, isMessageListActive, onLayoutChange,
}: OwnProps) => {
  const lang = useLang();
  const id = useUniqueId();
  const containerRef = useRef<HTMLDivElement>();
  const frameRef = useRef<HTMLIFrameElement>();
  const videoRef = useRef<HTMLVideoElement>();
  const hasNativeLoadedRef = useRef(false);
  const nativeCleanupRef = useRef<NoneToVoidFunction>();
  const playButtonRef = useRef<HTMLButtonElement>();
  const shouldFocusPlayRef = useRef(false);
  const sequenceRef = useRef(0);
  const downloadControllerRef = useRef<AbortController>();
  const [hasDownloadDiskError, setHasDownloadDiskError] = useState(false);
  const [downloadState, setDownloadState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [session, setSession] = useState<PlayerSession>();
  const [nativeUrl, setNativeUrl] = useState<string>();
  const [nativeAspectRatio, setNativeAspectRatio] = useState<number>();
  const [state, setState] = useState<PlayerState>('idle');
  const [errorCode, setErrorCode] = useState<string>();
  const [isVisible, setIsVisible] = useState(false);
  const [hasObservedVisibility, setHasObservedVisibility] = useState(false);
  const [isForeground, setIsForeground] = useState(!document.hidden);
  const [isTelegramActive, setIsTelegramActive] = useState(
    !document.documentElement.dataset.relayActiveApp || document.documentElement.dataset.relayActiveApp === 'telegram',
  );
  const [isRequested, setIsRequested] = useState(false);
  const [isStopped, setIsStopped] = useState(false);
  const isEligible = isVisible && isForeground && isTelegramActive && isMessageListActive !== false;
  const hasPlayerError = state === 'error';

  const handleSaveOriginal = useLastCallback(async () => {
    if (downloadControllerRef.current) {
      downloadControllerRef.current.abort();
      downloadControllerRef.current = undefined;
      setDownloadState('idle');
      return;
    }
    const controller = new AbortController();
    downloadControllerRef.current = controller;
    setHasDownloadDiskError(false);
    setDownloadState('saving');
    try {
      await saveInlineMedia(source, controller.signal);
      if (downloadControllerRef.current === controller) setDownloadState('saved');
    } catch (err) {
      if (downloadControllerRef.current === controller && !controller.signal.aborted) {
        setHasDownloadDiskError(String(err).includes('MEDIA_DISK_FULL'));
        setDownloadState('error');
      }
    } finally {
      if (downloadControllerRef.current === controller) downloadControllerRef.current = undefined;
    }
  });

  const sendYouTubeCommand = useLastCallback((func: string) => {
    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args: [], id }), YOUTUBE_ORIGIN,
    );
  });

  const playNativeVideo = useLastCallback(() => {
    const video = videoRef.current;
    if (!video || !session || sequenceRef.current !== session.key || !isEligible) return;
    const sessionKey = session.key;
    video.muted = true;
    void video.play().catch(() => {
      if (sequenceRef.current === sessionKey && videoRef.current === video) {
        setState((current) => current === 'idle' || current === 'error' ? current : 'paused');
      }
    });
  });

  const stopPlayer = useLastCallback(() => {
    sequenceRef.current++;
    sendYouTubeCommand('pauseVideo');
    videoRef.current?.pause();
    nativeCleanupRef.current?.();
    if (activePlayer?.id === id) activePlayer = undefined;
    setSession(undefined);
    setIsRequested(false);
    setIsStopped(true);
    setState((current) => current === 'error' ? current : 'idle');
  });

  const requestPlayer = useLastCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (session && !hasPlayerError && state !== 'loading') {
      if (activePlayer?.id !== id) activePlayer?.stop();
      activePlayer = { id, stop: stopPlayer };
      setIsRequested(true);
      if (session.mode === 'embed') {
        sendYouTubeCommand('mute');
        sendYouTubeCommand('playVideo');
      } else playNativeVideo();
      return;
    }
    setErrorCode(undefined);
    setState('idle');
    setIsStopped(false);
    setIsRequested(true);
    if (session) {
      stopPlayer();
      setIsStopped(false);
      setIsRequested(true);
    }
  });

  const handlePlayerError = useLastCallback((code?: string) => {
    if (!session || sequenceRef.current !== session.key || !isEligible || hasPlayerError) return;
    sequenceRef.current++;
    const canTryNative = source.provider === 'youtube' && session.mode === 'embed'
      && code && RECOVERABLE_EMBED_ERROR_CODES.has(code)
      && (session.canPlay || !activePlayer || activePlayer.id === id);
    if (canTryNative) {
      sendYouTubeCommand('pauseVideo');
      if (activePlayer?.id !== id) activePlayer?.stop();
      activePlayer = { id, stop: stopPlayer };
      setErrorCode(undefined);
      setState('loading');
      setSession({ key: sequenceRef.current, canPlay: session.canPlay, mode: 'native' });
      return;
    }
    setErrorCode(code);
    setState('error');
  });
  const handleFrameError = useLastCallback(() => {
    handlePlayerError(session?.mode === 'embed' ? 'MEDIA_FETCH_FAILED' : 'MEDIA_PLAYBACK_FAILED');
  });
  const handleNativeMetadata = useLastCallback(() => {
    if (!session || sequenceRef.current !== session.key) return;
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return;
    const aspectRatio = video.videoWidth / video.videoHeight;
    if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return;
    setNativeAspectRatio(aspectRatio);
    onLayoutChange?.(source.canonicalUrl, aspectRatio < 1, aspectRatio);
  });
  const handleNativeReady = useLastCallback(() => {
    if (!session || sequenceRef.current !== session.key || !isEligible || hasNativeLoadedRef.current) return;
    hasNativeLoadedRef.current = true;
    setState('ready');
    if (session.canPlay) playNativeVideo();
  });
  const handleNativePlaying = useLastCallback(() => {
    if (!session || sequenceRef.current !== session.key || !isEligible) return;
    if (activePlayer?.id !== id) activePlayer?.stop();
    activePlayer = { id, stop: stopPlayer };
    setState('playing');
  });
  const handleNativePause = useLastCallback(() => {
    if (session && sequenceRef.current === session.key && isEligible && !hasPlayerError) setState('paused');
  });
  const handleStopClick = useLastCallback(() => {
    shouldFocusPlayRef.current = true;
    stopPlayer();
    setState('idle');
    setErrorCode(undefined);
  });

  useEffect(() => {
    if (!session && shouldFocusPlayRef.current) {
      shouldFocusPlayRef.current = false;
      if (isEligible) requestMutation(() => playButtonRef.current?.focus());
    }
  }, [session, isEligible]);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      const shouldBeVisible = entry.isIntersecting && entry.intersectionRatio >= MIN_VISIBLE_RATIO;
      setHasObservedVisibility(true);
      setIsVisible(shouldBeVisible);
      if (!shouldBeVisible) stopPlayer();
    }, { threshold: [0, MIN_VISIBLE_RATIO] });
    observer.observe(containerRef.current!);
    const handleVisibility = () => {
      setIsForeground(!document.hidden);
      if (document.hidden) stopPlayer();
    };
    const handleServiceChange = () => {
      const isActive = document.documentElement.dataset.relayActiveApp === 'telegram';
      setIsTelegramActive(isActive);
      if (!isActive) stopPlayer();
    };
    const handleNativeMediaPlay = (e: Event) => {
      if (e.target instanceof HTMLMediaElement && e.target !== videoRef.current && !e.target.muted && e.target.volume) {
        stopPlayer();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener(INLINE_MEDIA_SERVICE_EVENT, handleServiceChange);
    document.addEventListener('play', handleNativeMediaPlay, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener(INLINE_MEDIA_SERVICE_EVENT, handleServiceChange);
      document.removeEventListener('play', handleNativeMediaPlay, true);
    };
  }, []);

  useEffect(() => {
    stopPlayer();
    setState('idle');
    setErrorCode(undefined);
    setNativeAspectRatio(undefined);
    setIsStopped(false);
    downloadControllerRef.current?.abort();
    downloadControllerRef.current = undefined;
    setDownloadState('idle');
  }, [source.canonicalUrl]);

  useEffect(() => {
    if (activationKey) requestPlayer();
  }, [activationKey]);

  useEffect(() => {
    if (!isEligible) {
      if (!hasObservedVisibility && isForeground && isTelegramActive && isMessageListActive !== false) return;
      stopPlayer();
      setIsStopped(false);
      return;
    }
    if (hasPlayerError) {
      if (activePlayer?.id === id) activePlayer = undefined;
      return;
    }
    if (session) {
      if (!isRequested && (!canAutoLoad || (session.canPlay && !canAutoPlay))) stopPlayer();
      return;
    }
    if (isStopped) return;
    if (!isRequested && !(canAutoLoad && (source.provider === 'youtube' || !activePlayer))) return;
    const shouldAutoPlay = Boolean(canAutoPlay && !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const canPlay = isRequested || (shouldAutoPlay && !activePlayer);
    const mode = source.provider === 'youtube' ? 'embed' : 'native';
    if (isRequested || canPlay || mode === 'native') {
      if (activePlayer?.id !== id) activePlayer?.stop();
      activePlayer = { id, stop: stopPlayer };
    }
    sequenceRef.current++;
    setState('loading');
    setSession({ key: sequenceRef.current, canPlay, mode });
  }, [
    id, isEligible, hasObservedVisibility, isForeground, isTelegramActive, isMessageListActive,
    session, isStopped, hasPlayerError, isRequested, canAutoLoad, canAutoPlay, source.provider,
  ]);

  useEffect(() => {
    if (!session || session.mode !== 'native' || !isEligible || hasPlayerError) return undefined;
    const controller = new AbortController();
    hasNativeLoadedRef.current = false;
    let blobUrl: string | undefined;
    const cleanup = () => {
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = undefined;
      setNativeUrl(undefined);
    };
    nativeCleanupRef.current = cleanup;
    void resolveInlineMedia(source, controller.signal).then((blob) => {
      if (controller.signal.aborted || sequenceRef.current !== session.key) return;
      blobUrl = URL.createObjectURL(blob);
      setNativeUrl(blobUrl);
    }).catch((err: unknown) => {
      if (controller.signal.aborted) return;
      const code = err instanceof Error ? err.message : typeof err === 'string' ? err : undefined;
      handlePlayerError(code && MEDIA_ERROR_CODES.has(code) ? code : undefined);
    });
    return () => {
      cleanup();
      if (nativeCleanupRef.current === cleanup) nativeCleanupRef.current = undefined;
    };
  }, [session, isEligible, hasPlayerError, source]);

  useEffect(() => {
    if (!session || session.mode !== 'embed' || !isEligible || hasPlayerError) return undefined;
    let isDisposed = false;
    let hasReceivedReady = false;
    const isCurrentSession = () => !isDisposed && sequenceRef.current === session.key;
    const timeout = window.setTimeout(() => {
      if (!isCurrentSession() || hasReceivedReady) return;
      isDisposed = true;
      handlePlayerError('MEDIA_TIMEOUT');
    }, LOAD_TIMEOUT_MS);
    if (source.provider !== 'youtube') return () => window.clearTimeout(timeout);
    const sendHandshake = () => {
      if (!isCurrentSession()) return;
      frameRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id }), YOUTUBE_ORIGIN);
      ['onReady', 'onError', 'onStateChange', 'onAutoplayBlocked'].forEach((event) => {
        frameRef.current?.contentWindow?.postMessage(JSON.stringify({
          event: 'command', func: 'addEventListener', args: [event], id,
        }), YOUTUBE_ORIGIN);
      });
    };
    const handshake = window.setInterval(sendHandshake, API_HANDSHAKE_INTERVAL_MS);
    const handleProviderMessage = (e: MessageEvent) => {
      if (!isCurrentSession() || e.source !== frameRef.current?.contentWindow || e.origin !== YOUTUBE_ORIGIN) return;
      let data: { event?: string; info?: unknown };
      try {
        data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (!data || typeof data !== 'object') return;
      if (data.event === 'onReady' && !hasReceivedReady) {
        hasReceivedReady = true;
        window.clearInterval(handshake);
        window.clearTimeout(timeout);
        setState('ready');
        if (session.canPlay) {
          sendYouTubeCommand('mute');
          sendYouTubeCommand('playVideo');
        }
      } else if (data.event === 'onError' && typeof data.info === 'number') {
        isDisposed = true;
        window.clearInterval(handshake);
        window.clearTimeout(timeout);
        handlePlayerError(YOUTUBE_ERROR_CODES[data.info] || 'MEDIA_UNAVAILABLE');
      } else if (data.event === 'onStateChange' && data.info === 1) {
        window.clearTimeout(timeout);
        if (activePlayer?.id !== id) activePlayer?.stop();
        activePlayer = { id, stop: stopPlayer };
        setState('playing');
      } else if (data.event === 'onStateChange' && (data.info === 2 || data.info === 0)) {
        window.clearTimeout(timeout);
        setState('paused');
      } else if (data.event === 'onAutoplayBlocked') {
        window.clearTimeout(timeout);
        setState('ready');
      }
    };
    window.addEventListener('message', handleProviderMessage);
    sendHandshake();
    return () => {
      isDisposed = true;
      window.clearInterval(handshake);
      window.clearTimeout(timeout);
      window.removeEventListener('message', handleProviderMessage);
    };
  }, [id, session, isEligible, hasPlayerError, source.provider]);

  useUnmountCleanup(stopPlayer);
  useUnmountCleanup(() => downloadControllerRef.current?.abort());

  const shouldMount = Boolean(session && isEligible && state !== 'error');
  const label = lang('RelayInlineMediaTitle', { provider: PROVIDER_NAMES[source.provider] });
  const errorStatus = errorCode === 'MEDIA_AUTH_REQUIRED' || errorCode === 'MEDIA_SESSION_LIMIT'
    ? lang('RelayInlineMediaAuthRequired', { provider: PROVIDER_NAMES[source.provider] })
    : lang(MEDIA_ERROR_LANG_KEYS[errorCode || ''] || 'RelayInlineMediaUnavailable');
  const status = state === 'error' ? errorStatus
    : state === 'loading' ? lang('RelayInlineMediaLoading') : undefined;
  const canRequestPlayback = session && (state === 'ready' || state === 'paused');
  const isCompact = state === 'idle' || state === 'loading' || state === 'error';
  const isEmbedLoading = state === 'loading' && session?.mode === 'embed';

  return (
    <div
      ref={containerRef}
      className={buildClassName(
        styles.root, (nativeAspectRatio !== undefined ? nativeAspectRatio < 1 : source.isVertical) && styles.vertical,
        isCompact && styles.compact, isEmbedLoading && styles.embedLoading,
      )}
      style={nativeAspectRatio ? `--inline-media-aspect-ratio: ${nativeAspectRatio}` : undefined}
      data-inline-media-provider={source.provider}
      data-inline-media-state={state}
      data-inline-media-error={hasPlayerError ? errorCode : undefined}
      data-inline-media-mode={session?.mode}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
    >
      <div className={styles.header}>
        <span className={styles.provider}>{PROVIDER_NAMES[source.provider]}</span>
        <div className={styles.controls}>
          <button
            className={styles.control}
            type="button"
            onClick={handleSaveOriginal}
            title={lang(downloadState === 'saving' ? 'ContextCancelDownload' : 'RelayReaderDownload')}
            aria-label={lang(downloadState === 'saving' ? 'ContextCancelDownload' : 'RelayReaderDownload')}
          >
            <span aria-hidden="true">{downloadState === 'saving' ? '×' : '↓'}</span>
          </button>
          {canRequestPlayback && (
            <button
              className={styles.control}
              type="button"
              onClick={requestPlayer}
              title={lang('RelayInlineMediaPlay')}
              aria-label={lang('RelayInlineMediaPlay')}
            >
              <span aria-hidden="true">▶</span>
            </button>
          )}
          {session && (
            <button
              className={styles.control}
              type="button"
              onClick={handleStopClick}
              title={lang('RelayInlineMediaStop')}
              aria-label={lang('RelayInlineMediaStop')}
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>
      </div>
      {downloadState !== 'idle' && (
        <div className={styles.downloadStatus} role="status" aria-live="polite">
          {lang(downloadState === 'saving' ? 'RelayDownloadStarted'
            : downloadState === 'saved' ? 'RelayDownloadSaved'
              : hasDownloadDiskError ? 'RelayMediaDiskFull' : 'RelayDownloadFailed')}
        </div>
      )}
      <div className={styles.viewport}>
        {shouldMount && session?.mode === 'native' ? (
          nativeUrl ? (
            <video
              ref={videoRef}
              className={buildClassName(styles.frame, state === 'loading' && styles.frameLoading)}
              src={nativeUrl}
              controls
              playsInline
              muted
              controlsList="nodownload"
              onLoadedMetadata={handleNativeMetadata}
              onCanPlay={handleNativeReady}
              onPlaying={handleNativePlaying}
              onPause={handleNativePause}
              onEnded={handleNativePause}
              onError={handleFrameError}
            />
          ) : undefined
        ) : shouldMount ? (
          <iframe
            key={session!.key}
            ref={frameRef}
            className={buildClassName(styles.frame, state === 'loading' && styles.frameLoading)}
            title={label}
            src={buildInlineSocialMediaEmbedUrl(source, session!.canPlay, window.location.origin)}
            sandbox="allow-scripts allow-same-origin allow-presentation"
            allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            onError={handleFrameError}
          />
        ) : undefined}
        {isCompact && (
          <div className={styles.placeholder}>
            {state === 'loading' ? (
              <>
                <span className={styles.loading} aria-hidden="true" />
                <span className={styles.status} role="status" aria-live="polite">{status}</span>
              </>
            ) : (
              <>
                {hasPlayerError && (
                  <span className={styles.status} role="status" aria-live="polite">{status}</span>
                )}
                <button
                  ref={playButtonRef}
                  className={styles.play}
                  type="button"
                  onClick={requestPlayer}
                  aria-label={hasPlayerError ? lang('RelayInlineMediaRetry') : label}
                >
                  <span className={styles.playSymbol} aria-hidden="true">▶</span>
                  <span>{lang(hasPlayerError ? 'RelayInlineMediaRetry' : 'RelayInlineMediaPlay')}</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default memo(InlineSocialMedia);
