import { memo } from '../../lib/teact/teact';

import useLang from '../../hooks/useLang';

import BrandMark from '../common/BrandMark';

import styles from './MiddleEmptyState.module.scss';

const MARK_SIZE = 40;

const MiddleEmptyState = () => {
  const lang = useLang();

  return (
    <div className={styles.root} role="status">
      <span className={styles.cross} data-corner="start-top" aria-hidden="true" />
      <span className={styles.cross} data-corner="end-top" aria-hidden="true" />
      <span className={styles.cross} data-corner="start-bottom" aria-hidden="true" />
      <span className={styles.cross} data-corner="end-bottom" aria-hidden="true" />
      <BrandMark size={MARK_SIZE} className={styles.mark} />
      <p className={styles.title}>{lang('RelayEmptyChatTitle')}</p>
      <p className={styles.note}>{lang('RelayEmptyChatNote')}</p>
    </div>
  );
};

export default memo(MiddleEmptyState);
