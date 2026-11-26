import { memo, useRef } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type {
  ApiDimensions, ApiMessage, ApiPageCaption, ApiSponsoredMessage,
} from '../../api/types';
import type { MediaViewerOrigin, ThreadId } from '../../types';
import type { MediaViewerItem, ViewableMedia } from './helpers/getViewableMedia';
import type { MediaContextAction } from './MediaContextMenu';
import { ApiMediaFormat, MAIN_THREAD_ID } from '../../api/types';

import { MEDIA_TIMESTAMP_SAVE_MINIMUM_DURATION } from '../../config';
import { getMediaHash, isChatChannel, isChatSuperGroup, isMessageLocal } from '../../global/helpers';
import { hasRichText } from '../../global/helpers/richMessage';
import {
  selectChat, selectIsMessageProtected, selectTabState,
} from '../../global/selectors';
import { selectMessageTimestampableDuration } from '../../global/selectors/media';
import { IS_TAURI } from '../../util/browser/globalEnvironment';
import { IS_TOUCH_ENV, IS_WINDOWS } from '../../util/browser/windowEnvironment';
import buildClassName from '../../util/buildClassName';
import { CLIPBOARD_ITEM_SUPPORTED, copyImageToClipboard, copyTextToClipboardFromPromise } from '../../util/clipboard';
import * as mediaLoader from '../../util/mediaLoader';
import stopEvent from '../../util/stopEvent';
import { calculateMediaViewerDimensions } from '../common/helpers/mediaDimensions';
import { renderMessageText } from '../common/helpers/renderMessageText';
import selectViewableMedia from './helpers/getViewableMedia';

import useAppLayout from '../../hooks/useAppLayout';
import useCurrentTimeSignal from '../../hooks/useCurrentTimeSignal';
import useLastCallback from '../../hooks/useLastCallback';
import useOldLang from '../../hooks/useOldLang';
import { useSignalEffect } from '../../hooks/useSignalEffect';
import useThrottledCallback from '../../hooks/useThrottledCallback';
import useUniqueId from '../../hooks/useUniqueId';
import useControlsSignal from './hooks/useControlsSignal';
import { useMediaProps } from './hooks/useMediaProps';

import RichText from '../iv/RichText';
import Spinner from '../ui/Spinner';
import MediaContextMenu from './MediaContextMenu';
import MediaLoadError from './MediaLoadError';
import MediaViewerFooter from './MediaViewerFooter';
import VideoPlayer from './VideoPlayer';

import './MediaViewerContent.scss';

type OwnProps = {
  item: MediaViewerItem;
  isActive?: boolean;
  withAnimation?: boolean;
  isMoving?: boolean;
  onClose: () => void;
  onFooterClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  handleSponsoredClick: () => void;
};

type StateProps = {
  viewableMedia?: ViewableMedia;
  textMessage?: ApiMessage | ApiSponsoredMessage;
  origin?: MediaViewerOrigin;
  isProtected?: boolean;
  canCopyMessageLink?: boolean;
  volume: number;
  isMuted: boolean;
  isHidden?: boolean;
  playbackRate: number;
  threadId?: ThreadId;
  timestamp?: number;
  maxTimestamp?: number;
};

const ANIMATION_DURATION = 350;
const MOBILE_VERSION_CONTROL_WIDTH = 350;
const PLAYBACK_SAVE_INTERVAL = 1000;

const MediaViewerContent = ({
  item,
  viewableMedia,
  isActive,
  textMessage,
  origin,
  withAnimation,
  isProtected,
  canCopyMessageLink,
  volume,
  playbackRate,
  isMuted,
  isHidden,
  isMoving,
  threadId,
  timestamp,
  maxTimestamp,
  onClose,
  onFooterClick,
  handleSponsoredClick,
}: OwnProps & StateProps) => {
  const {
    updateLastPlaybackTimestamp, downloadMedia, copyMessageLink, showNotification,
  } = getActions();

  const lang = useOldLang();
  const captionContainerId = useUniqueId();

  const isAvatar = item.type === 'avatar';
  const isSponsoredMessage = item.type === 'sponsoredMessage';
  const { media, caption } = viewableMedia || {};

  const {
    isVideo,
    isPhoto,
    bestImageData,
    bestData,
    dimensions,
    isGif,
    isVideoAvatar,
    mediaSize,
    loadProgress,
    hasLoadError,
    retryLoad,
  } = useMediaProps({
    media, isAvatar, origin, delay: withAnimation ? ANIMATION_DURATION : false, noLoadFull: !isActive,
  });

  const [, toggleControls] = useControlsSignal();
  const [getCurrentTime] = useCurrentTimeSignal();

  const isOpen = Boolean(media);
  const { isMobile } = useAppLayout();

  const toggleControlsOnMove = useLastCallback(() => {
    toggleControls(true);
  });

  const updatePlaybackTimestamp = useThrottledCallback(() => {
    if (!isActive || !textMessage || media?.mediaType !== 'video') return;
    if (media.duration < MEDIA_TIMESTAMP_SAVE_MINIMUM_DURATION) return;

    const message = 'id' in textMessage ? textMessage : undefined;
    const currentTime = getCurrentTime();
    if (!currentTime || !message || message.isInAlbum) return;

    // Reset timestamp if we are close to the end of the video
    const newTimestamp = media.duration - currentTime > PLAYBACK_SAVE_INTERVAL / 1000 ? currentTime : undefined;
    updateLastPlaybackTimestamp({ chatId: message.chatId, messageId: message.id, timestamp: newTimestamp });
  }, [getCurrentTime, isActive, media, textMessage], PLAYBACK_SAVE_INTERVAL);

  useSignalEffect(updatePlaybackTimestamp, [getCurrentTime]);

  if (!media) return undefined;
  if (isActive && hasLoadError && !bestData) {
    return (
      <div className="MediaViewerContent">
        <MediaLoadError onRetry={retryLoad} />
      </div>
    );
  }
  const retryPhotoLoad = isActive && hasLoadError ? retryLoad : undefined;
  const contextActions: MediaContextAction[] = [];
  const originMessage = item.type === 'message' ? item.message : undefined;
  if (isActive && bestData && !isProtected && !isSponsoredMessage && !originMessage?.isEphemeral) {
    const localUrl = 'blobUrl' in media ? media.blobUrl : undefined;
    const downloadHash = getMediaHash(media, 'download');
    const fullImageHash = isPhoto && !isVideoAvatar && getMediaHash(media, 'full');
    if (localUrl || downloadHash) {
      contextActions.push({
        icon: 'download',
        label: 'RelayMediaSave',
        run: () => downloadMedia({ media, originMessage }),
      });
      if (IS_TAURI && IS_WINDOWS) {
        contextActions.push({
          icon: 'copy',
          label: 'RelayMediaCopyFile',
          run: () => downloadMedia({ media, originMessage, copyToClipboard: true }),
        });
      }
    }
    if (CLIPBOARD_ITEM_SUPPORTED && isPhoto && !isVideoAvatar && (localUrl || fullImageHash)) {
      contextActions.push({
        icon: 'photo',
        label: 'ContextCopyImage',
        run: async () => {
          const source = localUrl || (fullImageHash
            ? mediaLoader.fetch(fullImageHash, ApiMediaFormat.BlobUrl) : undefined);
          const copied = await copyImageToClipboard(source);
          showNotification({ message: { key: copied ? 'RelayImageCopied' : 'RelayCopyImageError' } });
        },
      });
    }
    const pageUrl = item.type === 'pageBlock' ? item.pageMedia.pageUrl : undefined;
    if (originMessage && canCopyMessageLink) {
      contextActions.push({
        icon: 'link',
        label: 'CopyLink',
        run: () => copyMessageLink({
          chatId: originMessage.chatId,
          messageId: originMessage.id,
          shouldIncludeThread: Boolean(threadId && threadId !== MAIN_THREAD_ID),
          shouldIncludeGrouped: false,
        }),
      });
    } else if (pageUrl) {
      contextActions.push({
        icon: 'link',
        label: 'CopyLink',
        run: () => void copyTextToClipboardFromPromise(
          Promise.resolve(pageUrl),
          () => showNotification({ message: { key: 'LinkCopied' } }),
          () => showNotification({ message: lang('ErrorOccurred') }),
        ),
      });
    }
  }

  if (item.type === 'avatar') {
    if (!isVideoAvatar) {
      return (
        <div key={media.id} className="MediaViewerContent">
          <MediaViewerPhoto
            blobUrl={bestData}
            imageSize={calculateMediaViewerDimensions(dimensions!, false)}
            canDrag={!isMobile && !isProtected}
            isProtected={isProtected}
            onRetry={retryPhotoLoad}
            contextActions={contextActions}
          />
        </div>
      );
    } else {
      return (
        <div key={media.id} className="MediaViewerContent">
          <VideoPlayer
            key={media.id}
            url={bestData}
            isGif
            posterData={bestImageData}
            posterSize={calculateMediaViewerDimensions(dimensions!, false, true)}
            loadProgress={loadProgress}
            fileSize={mediaSize!}
            isMediaViewerOpen={isOpen && isActive}
            isProtected={isProtected}
            contextActions={contextActions}
            noPlay={!isActive}
            onClose={onClose}
            isMuted
            shouldCloseOnClick
            volume={0}
            isClickDisabled={isMoving}
            playbackRate={1}
            isSponsoredMessage={isSponsoredMessage}
            handleSponsoredClick={handleSponsoredClick}
          />
        </div>
      );
    }
  }

  const textParts = textMessage && (
    textMessage.content.action
      ? (textMessage.content.action.type === 'suggestProfilePhoto'
        ? lang('Conversation.SuggestedPhotoTitle') : undefined)
      : renderMessageText({
        message: textMessage, maxTimestamp, threadId, forcePlayback: true, isForMediaViewer: true,
      }));
  const captionParts = caption && renderPageCaption(
    caption,
    lang('PageContentUnsupported'),
    captionContainerId,
    item.type === 'pageBlock' ? item.pageMedia.pageUrl : undefined,
    item.type === 'pageBlock' ? item.pageMedia.chatId : undefined,
    item.type === 'pageBlock' ? item.pageMedia.messageId : undefined,
    item.type === 'pageBlock' ? item.pageMedia.threadId : undefined,
  );
  const buttonText = textMessage && 'buttonText' in textMessage ? textMessage.buttonText : undefined;
  const hasFooter = Boolean(textParts || captionParts);
  const posterSize = calculateMediaViewerDimensions(dimensions!, hasFooter, isVideo);
  const isForceMobileVersion = isMobile || shouldForceMobileVersion(posterSize);

  return (
    <div
      className={buildClassName('MediaViewerContent', hasFooter && 'has-footer')}
      onMouseMove={isForceMobileVersion && !IS_TOUCH_ENV ? toggleControlsOnMove : undefined}
    >
      {isPhoto && (
        <MediaViewerPhoto
          key={media.id}
          blobUrl={bestData}
          imageSize={posterSize}
          canDrag={!isMobile && !isProtected}
          isProtected={isProtected}
          onRetry={retryPhotoLoad}
          contextActions={contextActions}
        />
      )}
      {isVideo && (!isActive ? renderVideoPreview(
        bestImageData,
        posterSize,
        !isMobile && !isProtected,
        isProtected,
      ) : (
        <VideoPlayer
          key={media.id}
          url={bestData}
          storyboardInfo={'storyboardInfo' in media ? media.storyboardInfo : undefined}
          isGif={isGif}
          posterData={bestImageData}
          posterSize={posterSize}
          loadProgress={loadProgress}
          fileSize={mediaSize!}
          isMediaViewerOpen={isOpen && isActive}
          noPlay={!isActive}
          onClose={onClose}
          isMuted={isMuted}
          isHidden={isHidden}
          isForceMobileVersion={isForceMobileVersion}
          isProtected={isProtected}
          contextActions={contextActions}
          volume={volume}
          isClickDisabled={isMoving}
          playbackRate={playbackRate}
          isSponsoredMessage={isSponsoredMessage}
          handleSponsoredClick={handleSponsoredClick}
          timestamp={timestamp}
        />
      ))}
      {(textParts || captionParts) && (
        <MediaViewerFooter
          text={textParts || captionParts!}
          buttonText={buttonText}
          onClick={onFooterClick}
          isProtected={isProtected}
          isForceMobileVersion={isForceMobileVersion}
          isForVideo={isVideo && !isGif}
          handleSponsoredClick={handleSponsoredClick}
        />
      )}
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { item }): Complete<StateProps> => {
    const {
      volume,
      isMuted,
      playbackRate,
      isHidden,
      origin,
      timestamp,
      threadId,
    } = selectTabState(global).mediaViewer;
    const message = item.type === 'message' ? item.message : undefined;
    const chat = message && selectChat(global, message.chatId);
    const sponsoredMessage = item.type === 'sponsoredMessage' ? item.message : undefined;
    const textMessage = message || sponsoredMessage;
    const pageMedia = item.type === 'pageBlock' ? item.pageMedia : undefined;
    const viewableMedia = selectViewableMedia(global, origin, item);

    const maxTimestamp = message && selectMessageTimestampableDuration(global, message, true);

    return {
      origin,
      textMessage,
      isProtected: pageMedia?.isProtected || (message && selectIsMessageProtected(global, message)),
      canCopyMessageLink: message && chat && !isMessageLocal(message)
        && !chat.isMonoforum && (isChatChannel(chat) || isChatSuperGroup(chat)),
      volume,
      isMuted,
      isHidden,
      playbackRate,
      threadId,
      timestamp,
      maxTimestamp,
      viewableMedia,
    };
  },
)(MediaViewerContent));

function renderPageCaption(
  caption: ApiPageCaption,
  unsupportedText: string,
  containerId: string,
  pageUrl?: string,
  chatId?: string,
  messageId?: number,
  threadId?: ThreadId,
) {
  const hasText = hasRichText(caption.text);
  const hasCredit = hasRichText(caption.credit);
  if (!hasText && !hasCredit) {
    return undefined;
  }

  return (
    <>
      {hasText && (
        <RichText
          text={caption.text}
          unsupportedText={unsupportedText}
          containerId={containerId}
          pageUrl={pageUrl}
          chatId={chatId}
          messageId={messageId}
          threadId={threadId}
        />
      )}
      {hasText && hasCredit && <br />}
      {hasCredit && (
        <RichText
          text={caption.credit}
          unsupportedText={unsupportedText}
          containerId={containerId}
          pageUrl={pageUrl}
          chatId={chatId}
          messageId={messageId}
          threadId={threadId}
        />
      )}
    </>
  );
}

function MediaViewerPhoto({
  blobUrl, imageSize, canDrag, isProtected, onRetry, contextActions,
}: {
  blobUrl?: string;
  imageSize: ApiDimensions;
  canDrag?: boolean;
  isProtected?: boolean;
  onRetry?: NoneToVoidFunction;
  contextActions: MediaContextAction[];
}) {
  const imageRef = useRef<HTMLImageElement>();
  const hasContextMenu = Boolean(contextActions.length);
  return (
    <div
      className="MediaViewerPhoto"
      style={`width: ${imageSize.width}px; height: ${imageSize.height}px`}
    >
      {blobUrl ? (
        <>
          {isProtected && <div onContextMenu={stopEvent} className="protector" />}
          <img
            ref={imageRef}
            src={blobUrl}
            alt=""
            className={buildClassName('MediaViewerPhotoImage', isProtected && 'is-protected')}
            draggable={Boolean(canDrag)}
            tabIndex={hasContextMenu ? 0 : undefined}
          />
          {hasContextMenu && <MediaContextMenu mediaRef={imageRef} actions={contextActions} />}
        </>
      ) : (
        <Spinner color="white" />
      )}
      {onRetry && <MediaLoadError onRetry={onRetry} />}
    </div>
  );
}

function renderVideoPreview(blobUrl?: string, imageSize?: ApiDimensions, canDrag?: boolean, isProtected?: boolean) {
  const wrapperStyle = imageSize && `width: ${imageSize.width}px; height: ${imageSize.height}px`;
  const videoStyle = `background-image: url(${blobUrl})`;
  return blobUrl
    ? (
      <div
        className="VideoPlayer"
      >
        {isProtected && <div onContextMenu={stopEvent} className="protector" />}
        <div
          style={wrapperStyle}
        >
          <video
            style={videoStyle}
            className={buildClassName(isProtected && 'is-protected')}
            draggable={Boolean(canDrag)}
          />
        </div>
      </div>
    )
    : (
      <div
        className="spinner-wrapper"
        style={imageSize ? `width: ${imageSize.width}px` : ''}
      >
        <Spinner color="white" />
      </div>
    );
}

function shouldForceMobileVersion(posterSize?: { width: number; height: number }) {
  if (!posterSize) return false;
  return posterSize.width < MOBILE_VERSION_CONTROL_WIDTH;
}
