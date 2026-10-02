import type { FC } from '../../lib/teact/teact';
import { memo } from '../../lib/teact/teact';

import type { ApiTopic } from '../../api/types';
import type { ObserveFn } from '../../hooks/useIntersectionObserver';

import useCustomEmoji from './hooks/useCustomEmoji';

import CustomEmoji from './CustomEmoji';
import TopicDefaultIcon from './TopicDefaultIcon';

type OwnProps = {
  topic: Pick<ApiTopic, 'iconEmojiId' | 'iconColor' | 'title' | 'id'>;
  className?: string;
  letterClassName?: string;
  size?: number;
  noLoopLimit?: true;
  observeIntersection?: ObserveFn;
  onClick?: NoneToVoidFunction;
};

const LOOP_LIMIT = 2;
const DEFAULT_ICON_ID = '0';

const TopicIcon: FC<OwnProps> = ({
  topic,
  className,
  letterClassName,
  size,
  noLoopLimit,
  observeIntersection,
  onClick,
}) => {
  const hasEmojiId = Boolean(topic.iconEmojiId && topic.iconEmojiId !== DEFAULT_ICON_ID);
  const { customEmoji } = useCustomEmoji(hasEmojiId ? topic.iconEmojiId : undefined);

  if (hasEmojiId && customEmoji) {
    return (
      <CustomEmoji
        documentId={topic.iconEmojiId!}
        className={className}
        size={size}
        observeIntersectionForPlaying={observeIntersection}
        loopLimit={!noLoopLimit ? LOOP_LIMIT : undefined}
        onClick={onClick}
        forceAlways
        shouldPreloadPreview
      />
    );
  }

  if (hasEmojiId && !customEmoji) {
    // While loading custom emoji in background, show default icon as fallback with CustomEmoji triggered
    return (
      <>
        <div style="display: none;">
          <CustomEmoji documentId={topic.iconEmojiId!} noPlaceholder forceAlways shouldPreloadPreview />
        </div>
        <TopicDefaultIcon
          iconColor={topic.iconColor}
          title={topic.title}
          topicId={topic.id}
          className={className}
          letterClassName={letterClassName}
          onClick={onClick}
        />
      </>
    );
  }

  return (
    <TopicDefaultIcon
      iconColor={topic.iconColor}
      title={topic.title}
      topicId={topic.id}
      className={className}
      letterClassName={letterClassName}
      onClick={onClick}
    />
  );
};

export default memo(TopicIcon);
