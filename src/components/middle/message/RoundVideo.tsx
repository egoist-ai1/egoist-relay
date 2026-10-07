import type { FC } from '../../../lib/teact/teact';
import {
  useEffect, useLayoutEffect,
  useRef, useSignal, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ApiMessage } from '../../../api/types';
import type { ObserveFn } from '../../../hooks/useIntersectionObserver';
import { ApiMediaFormat } from '../../../api/types';

import {
  getMediaFormat,
  getVideoMediaHash,
  hasMessageTtl,
} from '../../../global/helpers';
import { stopCurrentAudio } from '../../../util/audioPlayer';
import { IS_TAURI } from '../../../util/browser/globalEnvironment';
import buildClassName from '../../../util/buildClassName';
import { formatMediaDuration } from '../../../util/dates/oldDateFormat';
import safePlay from '../../../util/safePlay';
import { ROUND_VIDEO_DIMENSIONS_PX } from '../../common/helpers/mediaDimensions';

import useThumbnail from '../../../hooks/media/useThumbnail';
import { useThrottledSignal } from '../../../hooks/useAsyncResolvers';
import useFlag from '../../../hooks/useFlag';
import { useIsIntersecting } from '../../../hooks/useIntersectionObserver';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useMediaTransition from '../../../hooks/useMediaTransition';
import useMediaWithLoadProgress from '../../../hooks/useMediaWithLoadProgress';
import usePreviousDeprecated from '../../../hooks/usePreviousDeprecated';
import useShowTransition from '../../../hooks/useShowTransition';
import useBlurredMediaThumbRef from './hooks/useBlurredMediaThumbRef';

import Icon from '../../common/icons/Icon';
import MediaSpoiler from '../../common/MediaSpoiler';
import Button from '../../ui/Button';
import OptimizedVideo from '../../ui/OptimizedVideo';
import ProgressSpinner from '../../ui/ProgressSpinner';
import MediaBadge from './MediaBadge';

import './RoundVideo.scss';
import styles from './media.module.scss';

type OwnProps = {
  message: ApiMessage;
  className?: string;
  canAutoLoad?: boolean;
  isDownloading?: boolean;
  origin?: 'oneTimeModal';
  observeIntersection?: ObserveFn;
  onStop?: NoneToVoidFunction;
  onReadMedia?: NoneToVoidFunction;
  onHideTranscription?: (isHidden: boolean) => void;
  isTranscriptionError?: boolean;
  canTranscribe?: boolean;
  isTranscribed?: boolean;
  isTranscriptionHidden?: boolean;
  isTranscribing?: boolean;
};

const PROGRESS_CENTER = ROUND_VIDEO_DIMENSIONS_PX / 2;
const PROGRESS_MARGIN = 6;
const PROGRESS_CIRCUMFERENCE = (PROGRESS_CENTER - PROGRESS_MARGIN) * 2 * Math.PI;
const PROGRESS_THROTTLE = 16; // Min period needed for `playerEl.currentTime` to update

let stopPrevious: NoneToVoidFunction;

const RoundVideo: FC<OwnProps> = ({
  message,
  className,
  canAutoLoad,
  isDownloading,
  origin,
  observeIntersection,
  onStop,
  onReadMedia,
  isTranscriptionError,
  isTranscribed,
  canTranscribe,
  onHideTranscription,
  isTranscriptionHidden,
  isTranscribing,
}) => {
  const ref = useRef<HTMLDivElement>();
  const playerRef = useRef<HTMLVideoElement>();
  const circleRef = useRef<SVGCircleElement>();

  const { cancelMediaDownload, openOneTimeMediaModal, transcribeAudio, cancelAudioTranscription } = getActions();
  const lang = useLang();

  const isIntersecting = useIsIntersecting(ref, observeIntersection);

  const video = message.content.video!;
  const isMediaUnread = message.isMediaUnread;

  const [isLoadAllowed, setIsLoadAllowed] = useState(canAutoLoad);
  const shouldLoad = Boolean(isLoadAllowed && isIntersecting);
  const { mediaData, loadProgress } = useMediaWithLoadProgress(
    getVideoMediaHash(video, 'inline'),
    !shouldLoad,
    getMediaFormat(video, 'inline'),
  );
  const fullMediaData = video.blobUrl || mediaData;

  const { loadProgress: downloadProgress } = useMediaWithLoadProgress(
    getVideoMediaHash(video, 'download'),
    !isDownloading,
    ApiMediaFormat.BlobUrl,
  );

  const [isPlayerReady, markPlayerReady] = useFlag();
  const hasTtl = hasMessageTtl(message);
  const isInOneTimeModal = origin === 'oneTimeModal';
  const shouldRenderSpoiler = hasTtl && !isInOneTimeModal;
  const thumbDataUri = useThumbnail(message);
  const hasThumb = Boolean(thumbDataUri);
  const noThumb = !hasThumb || isPlayerReady || shouldRenderSpoiler;
  const thumbRef = useBlurredMediaThumbRef(video, noThumb);
  useMediaTransition({ hasMediaData: !noThumb, ref: thumbRef });

  const isTransferring = (isLoadAllowed && !isPlayerReady) || isDownloading;
  const wasLoadDisabled = usePreviousDeprecated(isLoadAllowed) === false;

  const {
    ref: spinnerRef,
    shouldRender: shouldRenderSpinner,
  } = useShowTransition({
    isOpen: isTransferring,
    noMountTransition: wasLoadDisabled,
    withShouldRender: true,
  });

  const [isActivated, setIsActivated] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const [getProgress, setProgress] = useSignal(0);
  const getThrottledProgress = useThrottledSignal(getProgress, PROGRESS_THROTTLE);

  useEffect(() => {
    if (!isActivated) {
      return;
    }

    const playerEl = playerRef.current!;
    setProgress(playerEl.currentTime / playerEl.duration);
  }, [setProgress, isActivated, getThrottledProgress]);

  useLayoutEffect(() => {
    if (!isActivated || !circleRef.current) {
      return;
    }

    const strokeDashOffset = PROGRESS_CIRCUMFERENCE - getThrottledProgress() * PROGRESS_CIRCUMFERENCE;
    circleRef.current.setAttribute('stroke-dashoffset', strokeDashOffset.toString());
  }, [isActivated, getThrottledProgress]);

  const shouldPlay = Boolean(fullMediaData && isIntersecting);

  const stopPlaying = useLastCallback(() => {
    if (!playerRef.current) {
      return;
    }

    setIsActivated(false);
    setProgress(0);
    safePlay(playerRef.current);
  });

  const capturePlaying = useLastCallback(() => {
    stopPrevious?.();
    stopPrevious = stopPlaying;
  });

  const togglePlaying = useLastCallback(() => {
    const playerEl = playerRef.current!;
    if (isActivated) {
      if (playerEl.paused) {
        safePlay(playerEl);
        stopCurrentAudio();
      } else {
        playerEl.pause();
      }
    } else {
      capturePlaying();
      // Pause is a workaround for iOS Safari – otherwise it stops video after several frames
      playerEl.pause();
      playerEl.currentTime = 0;
      safePlay(playerEl);
      stopCurrentAudio();
      setIsActivated(true);
    }
  });

  useEffect(() => {
    if (!isInOneTimeModal) {
      return;
    }
    togglePlaying();
  }, [isInOneTimeModal]);

  const handleClick = useLastCallback((event) => {
    if (event.target.closest('.transcribe-button')) {
      return;
    }

    if (!fullMediaData) {
      setIsLoadAllowed((isAllowed) => !isAllowed);

      return;
    }

    if (isDownloading) {
      cancelMediaDownload({ media: video });
      return;
    }

    if (hasTtl && !isInOneTimeModal) {
      openOneTimeMediaModal({ message });
      onReadMedia?.();
      return;
    }

    togglePlaying();
  });

  useEffect(() => {
    if (onReadMedia && isMediaUnread && isActivated) {
      onReadMedia();
    }
  }, [isActivated, isMediaUnread, onReadMedia]);

  const handleTimeUpdate = useLastCallback((e: React.UIEvent<HTMLVideoElement>) => {
    const playerEl = e.currentTarget;
    setProgress(playerEl.currentTime / playerEl.duration);
    setCurrentTime(Math.floor(playerEl.currentTime));
  });

  const handleTranscribe = useLastCallback(() => {
    transcribeAudio({ chatId: message.chatId, messageId: message.id });
  });

  function renderPlayWrapper() {
    return (
      <div className="play-wrapper">
        <Button
          color="dark"
          round
          size="smaller"
          className="play"
          nonInteractive
          iconName="play"
          iconClassName="play-icon"
        />
        <Icon name="view-once" className="view-once-icon" />
      </div>
    );
  }

  const handleButtonClick = useLastCallback(() => {
    if (isTranscribing && IS_TAURI) {
      cancelAudioTranscription({ chatId: message.chatId, messageId: message.id });
    } else if (isTranscriptionError) {
      handleTranscribe();
    } else if (isTranscribed && onHideTranscription) {
      onHideTranscription(!isTranscriptionHidden);
    } else if (!isTranscribing) {
      handleTranscribe();
    }
  });

  return (
    <div
      ref={ref}
      className={buildClassName(
        'RoundVideo',
        'media-inner',
        isInOneTimeModal && 'non-interactive',
        className,
      )}
      onClick={handleClick}
    >
      {fullMediaData && (
        <div className="video-wrapper">
          {shouldRenderSpoiler && (
            <MediaSpoiler
              isVisible
              thumbDataUri={thumbDataUri}
              width={ROUND_VIDEO_DIMENSIONS_PX}
              height={ROUND_VIDEO_DIMENSIONS_PX}
              className="media-spoiler"
            />
          )}
          <OptimizedVideo
            canPlay={shouldPlay}
            ref={playerRef}
            src={fullMediaData}
            className="full-media"
            width={ROUND_VIDEO_DIMENSIONS_PX}
            height={ROUND_VIDEO_DIMENSIONS_PX}
            autoPlay={!shouldRenderSpoiler}
            disablePictureInPicture
            muted={!isActivated}
            defaultMuted
            loop={!isActivated}
            playsInline
            isPriority
            onEnded={isActivated ? onStop ?? stopPlaying : undefined}
            onTimeUpdate={isActivated ? handleTimeUpdate : undefined}
            onReady={markPlayerReady}
          />
        </div>
      )}
      {!shouldRenderSpoiler && (
        <canvas
          ref={thumbRef}
          className="thumbnail"
          style={`width: ${ROUND_VIDEO_DIMENSIONS_PX}px; height: ${ROUND_VIDEO_DIMENSIONS_PX}px`}
        />
      )}
      <div className="progress">
        {isActivated && (
          <svg width={ROUND_VIDEO_DIMENSIONS_PX} height={ROUND_VIDEO_DIMENSIONS_PX}>
            <circle
              ref={circleRef}
              cx={PROGRESS_CENTER}
              cy={PROGRESS_CENTER}
              r={PROGRESS_CENTER - PROGRESS_MARGIN}
              className="progress-circle"
              transform={`rotate(-90, ${PROGRESS_CENTER}, ${PROGRESS_CENTER})`}
              stroke-dasharray={PROGRESS_CIRCUMFERENCE}
              stroke-dashoffset={PROGRESS_CIRCUMFERENCE}
            />
          </svg>
        )}
      </div>
      {shouldRenderSpinner && (
        <div ref={spinnerRef} className={buildClassName('media-loading', styles.loading)}>
          <ProgressSpinner progress={isDownloading ? downloadProgress : loadProgress} />
        </div>
      )}
      {shouldRenderSpoiler && !shouldRenderSpinner && renderPlayWrapper()}
      {!fullMediaData && !isLoadAllowed && (
        <Icon name="download" className={buildClassName(styles.controlButton, styles.downloadButton)} />
      )}
      {!isInOneTimeModal && (
        <MediaBadge
          className={buildClassName(
            'message-media-duration', isMediaUnread && 'unread',
          )}
        >
          {isActivated ? formatMediaDuration(currentTime) : formatMediaDuration(video.duration)}
          {(!isActivated || playerRef.current!.paused) && <Icon name="muted" className="muted-icon" />}
        </MediaBadge>
      )}
      {canTranscribe && (
        <Button
          round
          size="tiny"
          color="translucent"
          onClick={handleButtonClick}
          className={buildClassName('transcribe-button', isTranscribing && 'is-transcribing')}
          ariaLabel={isTranscribing && IS_TAURI ? lang('RelayTranscribeCancel')
            : isTranscriptionError ? lang('RelayRetry')
              : IS_TAURI ? lang('RelayTranscribe') : lang('PremiumPreviewVoiceToText')}
        >
          {isTranscribed || isTranscriptionError ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          ) : isTranscribing ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transcribe-pulsing-icon"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transcribe-svg-icon"
            >
              <path d="M4 10v4" />
              <path d="M8 7v10" />
              <path d="M12 4v16" />
              <path d="M16 8h4" />
              <path d="M16 12h4" />
              <path d="M16 16h2.5" />
            </svg>
          )}
          {isTranscribing && (
            <svg viewBox="0 0 28 28" className="loading-svg">
              <circle
                className="loading-circle"
                fill="transparent"
                cx="14"
                cy="14"
                r="11"
                strokeWidth="2"
                stroke="white"
                strokeDasharray="24 45"
                strokeLinecap="round"
              />
            </svg>
          )}
        </Button>
      )}
    </div>
  );
};

export default RoundVideo;
