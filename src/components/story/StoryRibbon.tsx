import { memo, useCallback, useRef, useState } from '../../lib/teact/teact';
import { withGlobal } from '../../global';

import type { ApiChat, ApiUser } from '../../api/types';

import buildClassName from '../../util/buildClassName';

import { getIsMobile } from '../../hooks/useAppLayout';
import useHorizontalScroll from '../../hooks/useHorizontalScroll';
import useLang from '../../hooks/useLang';

import Icon from '../common/icons/Icon';
import StoryPublisherModal from './StoryPublisherModal';
import StoryRibbonButton from './StoryRibbonButton';

import styles from './StoryRibbon.module.scss';

interface OwnProps {
  isArchived?: boolean;
  className?: string;
  isClosing?: boolean;
}

interface StateProps {
  orderedPeerIds: string[];
  stealthModeActiveUntil?: number;
  usersById: Record<string, ApiUser>;
  chatsById: Record<string, ApiChat>;
}

function StoryRibbon({
  isArchived,
  className,
  orderedPeerIds,
  stealthModeActiveUntil,
  usersById,
  chatsById,
  isClosing,
}: OwnProps & StateProps) {
  const lang = useLang();
  const [selectedFile, setSelectedFile] = useState<File | undefined>();
  const [isPublisherOpen, setIsPublisherOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>();

  const fullClassName = buildClassName(
    styles.root,
    isClosing && styles.closing,
    className,
    'no-scrollbar',
  );

  const ref = useRef<HTMLDivElement>();

  useHorizontalScroll(ref, getIsMobile());

  const handleOpenStoryPicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: any) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setIsPublisherOpen(true);
    }
    if (e.target) {
      e.target.value = '';
    }
  }, []);

  const handleClosePublisher = useCallback(() => {
    setIsPublisherOpen(false);
    setSelectedFile(undefined);
  }, []);

  return (
    <div
      ref={ref}
      id="StoryRibbon"
      className={fullClassName}
      dir={lang.isRtl ? 'rtl' : undefined}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        className="hidden-file-input"
        style="display: none !important;"
        onChange={handleFileChange}
      />

      <div
        role="button"
        tabIndex={0}
        className={buildClassName(styles.peer, styles.addStoryPeer)}
        onClick={handleOpenStoryPicker}
        title="Опубликовать историю в Telegram"
      >
        <div className={styles.addStoryCircle}>
          <Icon name="add" className={styles.addStoryIcon} />
        </div>
        <div className={styles.name}>
          Создать
        </div>
      </div>

      {orderedPeerIds.map((peerId) => {
        const peer = usersById[peerId] || chatsById[peerId];

        if (!peer) {
          return undefined;
        }

        return (
          <StoryRibbonButton
            key={peerId}
            peer={peer}
            isArchived={isArchived}
            stealthModeActiveUntil={stealthModeActiveUntil}
          />
        );
      })}

      <StoryPublisherModal
        isOpen={isPublisherOpen}
        file={selectedFile}
        onClose={handleClosePublisher}
      />
    </div>
  );
}

export default memo(withGlobal<OwnProps>(
  (global, { isArchived }): Complete<StateProps> => {
    const { orderedPeerIds: { active, archived } } = global.stories;
    const usersById = global.users.byId;
    const chatsById = global.chats.byId;

    const stealthMode = global.stories.stealthMode;

    return {
      orderedPeerIds: isArchived ? archived : active,
      stealthModeActiveUntil: stealthMode.activeUntil,
      usersById,
      chatsById,
    };
  },
)(StoryRibbon));
