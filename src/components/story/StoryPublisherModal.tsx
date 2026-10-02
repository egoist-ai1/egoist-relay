import { memo, useCallback, useEffect, useState } from '../../lib/teact/teact';
import { getActions } from '../../global';

import { formatFileSize } from '../../util/textFormat';

import useLang from '../../hooks/useLang';

import Button from '../ui/Button';
import InputText from '../ui/InputText';
import Modal from '../ui/Modal';

import styles from './StoryPublisherModal.module.scss';

interface OwnProps {
  isOpen: boolean;
  file?: File;
  onClose: () => void;
}

function StoryPublisherModal({
  isOpen,
  file,
  onClose,
}: OwnProps) {
  const { postStory } = getActions();
  const lang = useLang();

  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const [caption, setCaption] = useState<string>('');
  const [isPinned, setIsPinned] = useState<boolean>(false);
  const [isPublishing, setIsPublishing] = useState<boolean>(false);

  const isVideo = Boolean(file && (file.type.startsWith('video/') || file.name.endsWith('.mp4')));

  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    } else {
      setPreviewUrl(undefined);
      setCaption('');
      setIsPinned(false);
      setIsPublishing(false);
    }
    return undefined;
  }, [file]);

  const handleCaptionChange = useCallback((e: any) => {
    setCaption(e.target.value);
  }, []);

  const handleTogglePinned = useCallback(() => {
    setIsPinned((prev) => !prev);
  }, []);

  const handlePublish = useCallback(() => {
    if (!file || isPublishing) return;
    setIsPublishing(true);
    try {
      postStory({
        file,
        caption: caption.trim() || undefined,
        pinned: isPinned,
      });
      onClose();
    } finally {
      setIsPublishing(false);
    }
  }, [file, isPublishing, postStory, caption, isPinned, onClose]);

  if (!file || !previewUrl) {
    return undefined;
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      hasCloseButton
      className={styles.root}
      title="Новая история (PC Ultra Quality)"
    >
      <div className={styles.content}>
        <div className={styles.previewContainer}>
          {isVideo ? (
            <video
              src={previewUrl}
              className={styles.mediaPreview}
              autoPlay
              controls
              loop
              playsInline
            />
          ) : (
            <img
              src={previewUrl}
              alt="Story preview"
              className={styles.mediaPreview}
            />
          )}
          <div className={styles.qualityBadge}>
            ⚡ Без сжатия (Original Bitrate)
          </div>
        </div>

        <div className={styles.fileMeta}>
          <span>{file.name}</span>
          <span>{formatFileSize(lang, file.size)}</span>
        </div>

        <div className={styles.captionWrapper}>
          <InputText
            value={caption}
            placeholder="Добавьте подпись к истории..."
            onChange={handleCaptionChange}
            disabled={isPublishing}
          />
        </div>

        <label className={styles.optionsRow}>
          <span>Сохранить в профиле (Pinned)</span>
          <input
            type="checkbox"
            checked={isPinned}
            onChange={handleTogglePinned}
            disabled={isPublishing}
          />
        </label>

        <div className={styles.actions}>
          <Button
            className={styles.cancelBtn}
            onClick={onClose}
            disabled={isPublishing}
          >
            Отмена
          </Button>
          <Button
            className={styles.publishBtn}
            onClick={handlePublish}
            disabled={isPublishing}
            isLoading={isPublishing}
          >
            {isPublishing ? 'Загрузка...' : 'Опубликовать'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default memo(StoryPublisherModal);
