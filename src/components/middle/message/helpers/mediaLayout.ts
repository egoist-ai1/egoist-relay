import type {
  ApiMediaExtendedPreview, ApiMessageWebPage, ApiPhoto, ApiVideo, ApiWebPage, ApiWebPageFull,
} from '../../../../api/types';
import type { WebPageMediaSize } from '../../../../types';
import type { InlineSocialMediaSource } from '../../../../util/inlineSocialMedia';

import { getMediaDimensions, getPhotoFullDimensions } from '../../../../global/helpers';

const PORTRAIT_ASPECT_RATIO = 9 / 16;
const LANDSCAPE_ASPECT_RATIO = 16 / 9;
const NON_ADAPTIVE_WEBPAGE_TYPES = new Set([
  'telegram_story', 'telegram_nft', 'telegram_auction', 'telegram_aicomposetone',
]);

export function getMessageMediaLayout({
  photo,
  video,
  isAlbum,
  webPage,
  messageWebPage,
  inlineSource,
  isInlineMediaVertical,
  inlineMediaAspectRatio,
}: {
  photo?: ApiPhoto | ApiMediaExtendedPreview;
  video?: ApiVideo | ApiMediaExtendedPreview;
  isAlbum?: boolean;
  webPage?: ApiWebPage;
  messageWebPage?: ApiMessageWebPage;
  inlineSource?: InlineSocialMediaSource;
  isInlineMediaVertical?: boolean;
  inlineMediaAspectRatio?: number;
}) {
  if (isAlbum) return { isPortrait: false };
  if (video?.mediaType === 'video' && video.isRound) return undefined;

  if (inlineSource) {
    const aspectRatio = inlineMediaAspectRatio && Number.isFinite(inlineMediaAspectRatio) && inlineMediaAspectRatio > 0
      ? inlineMediaAspectRatio : isInlineMediaVertical ? PORTRAIT_ASPECT_RATIO : LANDSCAPE_ASPECT_RATIO;
    return { isPortrait: aspectRatio < 1, aspectRatio };
  }

  let media = video || photo;
  let isWebPage = false;
  if (!media && webPage?.webpageType === 'full') {
    if (NON_ADAPTIVE_WEBPAGE_TYPES.has(webPage.type || '') || webPage.stickers || webPage.document) return undefined;
    if (webPage.video) {
      media = webPage.video;
    } else if (webPage.photo && !((webPage.title || webPage.description || webPage.siteName)
      && getIsSmallWebPagePhoto(webPage, messageWebPage?.mediaSize))) {
      media = webPage.photo;
    }
    isWebPage = Boolean(media);
  }

  if (!media) return undefined;
  const { width, height } = getMediaDimensions(media);
  return { isPortrait: width < height, aspectRatio: width / height, isWebPage };
}

export function getIsSmallWebPagePhoto(webPage: ApiWebPageFull, mediaSize?: WebPageMediaSize) {
  if (!webPage.photo) return false;
  if (mediaSize === 'small') return true;
  if (mediaSize === 'large') return false;

  const { width, height } = getPhotoFullDimensions(webPage.photo) || {};
  if (!width || !height) return false;

  return width === height && !webPage.hasLargeMedia;
}
