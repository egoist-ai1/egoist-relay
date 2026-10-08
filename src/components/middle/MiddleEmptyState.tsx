import { memo } from '../../lib/teact/teact';

import useLang from '../../hooks/useLang';

import SennitMark from '../common/SennitMark';

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
      <SennitMark size={MARK_SIZE} className={styles.mark} />
      <p className={styles.title}>{lang('RelayEmptyChatTitle')}</p>
      <p className={styles.note}>{lang('RelayEmptyChatNote')}</p>
    </div>
  );
};

export default memo(MiddleEmptyState);
