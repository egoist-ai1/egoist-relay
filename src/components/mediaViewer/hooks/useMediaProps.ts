import { useMemo } from '../../../lib/teact/teact';

import type { MediaViewerMedia } from '../../../types';
import { ApiMediaFormat } from '../../../api/types';
import { MediaViewerOrigin } from '../../../types';

import {
  getMediaFileSize,
  getMediaFormat,
  getMediaHash,
  getMediaSearchType,
  getMediaThumbUri,
  getPhotoFullDimensions,
  getProfilePhotoMediaHash,
  getVideoDimensions,
  getVideoProfilePhotoMediaHash,
  isDocumentPhoto,
  isDocumentVideo,
} from '../../../global/helpers';
import { AVATAR_FULL_DIMENSIONS, VIDEO_AVATAR_FULL_DIMENSIONS } from '../../common/helpers/mediaDimensions';

import useBlurSync from '../../../hooks/useBlurSync';
import useMedia from '../../../hooks/useMedia';
import useMediaWithLoadProgress from '../../../hooks/useMediaWithLoadProgress';

const FALLBACK_DIMENSIONS = AVATAR_FULL_DIMENSIONS;

type UseMediaProps = {
  media?: MediaViewerMedia;
  isAvatar?: boolean;
  origin?: MediaViewerOrigin;
  delay: number | false;
  noLoadFull?: boolean;
};

export const useMediaProps = ({
  media,
  isAvatar,
  origin,
  delay,
  noLoadFull,
}: UseMediaProps) => {
  const isPhotoAvatar = isAvatar && media?.mediaType === 'photo' && !media.isVideo;
  const isVideoAvatar = isAvatar && media?.mediaType === 'photo' && media.isVideo;
  const isDocument = media?.mediaType === 'document';
  const isVideo = (media?.mediaType === 'video' && !media.isRound) || (isDocument && isDocumentVideo(media));
  const isPhoto = media?.mediaType === 'photo' || (isDocument && isDocumentPhoto(media));
  const isGif = media?.mediaType === 'video' && media.isGif;
  const isFromSharedMedia = origin === MediaViewerOrigin.SharedMedia;
  const isFromSearch = origin === MediaViewerOrigin.SearchResult;

  const contentType = media && getMediaSearchType(media);

  const getMediaOrAvatarHash = useMemo(() => (isFull?: boolean) => {
    if (!media) return undefined;

    if ((isPhotoAvatar || isVideoAvatar) && !isFull) {
      return getProfilePhotoMediaHash(media);
    }

    if (isVideoAvatar && isFull) {
      return getVideoProfilePhotoMediaHash(media);
    }

    return getMediaHash(media, isFull ? 'full' : 'preview');
  }, [isVideoAvatar, isPhotoAvatar, media]);

  const localBlobUrl = media && 'blobUrl' in media ? media.blobUrl : undefined;
  const {
    mediaData: fullMediaBlobUrl,
    loadProgress,
    hasLoadError,
    retryLoad,
  } = useMediaWithLoadProgress(
    getMediaOrAvatarHash(true),
    Boolean(noLoadFull || localBlobUrl),
    media && getMediaFormat(media, 'full'),
    delay,
    false,
    !noLoadFull,
  );

  const hasPhoto = !isVideo && !isVideoAvatar && Boolean(localBlobUrl || fullMediaBlobUrl);
  const previewBlobUrl = useMedia(getMediaOrAvatarHash(), hasPhoto, ApiMediaFormat.BlobUrl, delay);
  // Миниатюру из сетки берём из кеша, чтобы она не конкурировала с открытым фото
  const pictogramBlobUrl = useMedia(
    media && (isFromSharedMedia || isFromSearch || isDocument) && getMediaHash(media, 'pictogram'),
    true,
  );
  let bestImageData = (!isVideo && (localBlobUrl || fullMediaBlobUrl)) || previewBlobUrl || pictogramBlobUrl;
  const thumbDataUri = useBlurSync(!bestImageData && media && getMediaThumbUri(media));
  if (!bestImageData && origin !== MediaViewerOrigin.SearchResult) {
    bestImageData = thumbDataUri;
  }
  if (isVideoAvatar && previewBlobUrl) {
    bestImageData = previewBlobUrl;
  }
  const bestData = localBlobUrl || fullMediaBlobUrl || (
    (!isVideoAvatar && !isVideo) ? (previewBlobUrl || pictogramBlobUrl || bestImageData) : undefined
  );

  const mediaSize = media && getMediaFileSize(media);

  const dimensions = useMemo(() => {
    if (isAvatar) {
      return isVideoAvatar ? VIDEO_AVATAR_FULL_DIMENSIONS : AVATAR_FULL_DIMENSIONS;
    }

    if (isDocument) {
      return media.mediaSize || FALLBACK_DIMENSIONS;
    }

    if (isPhoto) {
      return getPhotoFullDimensions(media);
    }

    if (isVideo) {
      return getVideoDimensions(media);
    }

    return FALLBACK_DIMENSIONS;
  }, [isAvatar, isDocument, isPhoto, isVideo, isVideoAvatar, media]);

  return {
    getMediaHash: getMediaOrAvatarHash,
    media,
    isVideo,
    isPhoto,
    isGif,
    isDocument,
    bestImageData,
    bestData,
    dimensions,
    contentType,
    isVideoAvatar,
    loadProgress,
    hasLoadError,
    retryLoad,
    mediaSize,
  };
};
