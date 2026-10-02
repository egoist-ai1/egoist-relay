import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { ApiAvailableReaction, ApiReaction } from '../../../api/types';
import type { ObserveFn } from '../../../hooks/useIntersectionObserver';

import { isSameReaction } from '../../../global/helpers';
import buildClassName from '../../../util/buildClassName';

import useThumbnail from '../../../hooks/media/useThumbnail';
import useLastCallback from '../../../hooks/useLastCallback';
import useMedia from '../../../hooks/useMedia';
import useMediaTransition from '../../../hooks/useMediaTransition';

import CustomEmoji from '../CustomEmoji';
import Icon from '../icons/Icon';

import './ReactionStaticEmoji.scss';

import blankUrl from '../../../assets/blank.png';

type OwnProps = {
  reaction: ApiReaction;
  availableReactions?: ApiAvailableReaction[];
  className?: string;
  size?: number;
  withIconHeart?: boolean;
  observeIntersection?: ObserveFn;
};

const ReactionStaticEmoji = ({
  reaction,
  availableReactions,
  className,
  size,
  withIconHeart,
  observeIntersection,
}: OwnProps) => {
  const availableReaction = useMemo(() => (
    availableReactions?.find((available) => isSameReaction(available.reaction, reaction))
  ), [availableReactions, reaction]);
  const staticIcon = availableReaction?.staticIcon;
  const staticIconId = staticIcon?.id;
  const mediaHash = staticIconId ? `document${staticIconId}` : undefined;
  const cacheBuster = availableReaction?.isLocalCache ? 0 : 1;
  const mediaData = useMedia(mediaHash, false, undefined, undefined, cacheBuster);
  const thumbDataUri = useThumbnail(staticIcon?.thumbnail);

  const [failedMediaSource, setFailedMediaSource] = useState<string>();
  const [failedThumbSource, setFailedThumbSource] = useState<string>();
  const [loadedMediaSource, setLoadedMediaSource] = useState<string>();
  const [loadedThumbSource, setLoadedThumbSource] = useState<string>();
  const hasMediaData = Boolean(mediaData && mediaData !== failedMediaSource);
  const hasThumbData = Boolean(thumbDataUri && thumbDataUri !== failedThumbSource);
  const isMediaLoaded = hasMediaData && loadedMediaSource === mediaData;
  const isThumbLoaded = hasThumbData && loadedThumbSource === thumbDataUri;
  const isThumbVisible = isThumbLoaded && !hasMediaData;

  const { ref: thumbRef } = useMediaTransition<HTMLImageElement>({
    hasMediaData: isThumbVisible,
  });
  const { ref: mediaRef } = useMediaTransition<HTMLImageElement>({
    hasMediaData: isMediaLoaded,
  });

  const handleMediaError = useLastCallback(() => {
    setFailedMediaSource(mediaData);
  });
  const handleMediaLoad = useLastCallback(() => {
    setLoadedMediaSource(mediaData);
  });
  const handleThumbError = useLastCallback(() => {
    setFailedThumbSource(thumbDataUri);
  });
  const handleThumbLoad = useLastCallback(() => {
    setLoadedThumbSource(thumbDataUri);
  });

  const shouldApplySizeFix = reaction.type === 'emoji' && reaction.emoticon === '🦄';
  const shouldReplaceWithHeartIcon = withIconHeart && reaction.type === 'emoji' && reaction.emoticon === '❤';

  if (reaction.type === 'custom') {
    return (
      <CustomEmoji
        documentId={reaction.documentId}
        className={buildClassName('ReactionStaticEmoji', className)}
        size={size}
        observeIntersectionForPlaying={observeIntersection}
      />
    );
  }

  if (shouldReplaceWithHeartIcon) {
    return (
      <Icon name="heart" className="ReactionStaticEmoji" style={`font-size: ${size}px; width: ${size}px`} />
    );
  }

  return (
    <div
      className={buildClassName('ReactionStaticEmoji', className)}
      style={size
        ? `--reaction-static-emoji-size: ${size}px; width: ${size}px; height: ${size}px`
        : undefined}
      role="img"
      aria-label={availableReaction?.title || reaction.emoticon}
    >
      <span
        className={buildClassName(
          'ReactionStaticEmoji__fallback',
          (isMediaLoaded || isThumbVisible) && 'is-loaded',
        )}
        aria-hidden
      >
        {reaction.emoticon}
      </span>
      <img
        ref={thumbRef}
        className="thumb"
        src={hasThumbData ? thumbDataUri : undefined}
        alt=""
        draggable={false}
        onLoad={handleThumbLoad}
        onError={handleThumbError}
      />
      <img
        ref={mediaRef}
        className={buildClassName('media', shouldApplySizeFix && 'with-unicorn-fix')}
        src={hasMediaData ? mediaData : blankUrl}
        alt=""
        draggable={false}
        onLoad={handleMediaLoad}
        onError={handleMediaError}
      />
    </div>
  );
};

export default memo(ReactionStaticEmoji);
