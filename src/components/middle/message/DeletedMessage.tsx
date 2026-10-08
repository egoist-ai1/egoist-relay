import { memo, useState } from '../../../lib/teact/teact';
import { withGlobal } from '../../../global';

import type { ApiMessage, ApiPeer } from '../../../api/types';

import { getMessageHtmlId } from '../../../global/helpers';
import { getMediaThumbUri } from '../../../global/helpers/messageMedia';
import { getPeerTitle } from '../../../global/helpers/peers';
import { selectSender } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import { formatDateTime } from '../../../util/localization/dateFormat';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import MessageSummary from '../../common/MessageSummary';

import styles from './DeletedMessage.module.scss';

type OwnProps = {
  message: ApiMessage;
  isLastInList?: boolean;
};

type StateProps = {
  sender?: ApiPeer;
};

const MS_IN_SECOND = 1000;
const MAX_SUMMARY_LENGTH = 4096;

const DeletedMessage = ({ message, sender, isLastInList }: OwnProps & StateProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const lang = useLang();

  const handleToggle = useLastCallback(() => {
    setIsExpanded((current) => !current);
  });

  const { content, deletedAt, hasNoDeletedCopy } = message;
  const panelId = `${getMessageHtmlId(message.id)}-deleted`;
  const media = content.photo || content.video || content.document || content.sticker;
  const thumbnailUri = media && getMediaThumbUri(media);
  const deletedDate = new Date(deletedAt! * MS_IN_SECOND);
  const deletedTime = formatDateTime(lang, deletedDate, { date: 'short', time: 'short' });

  const sentTime = formatDateTime(lang, new Date(message.date * MS_IN_SECOND), { time: 'short' });

  const summary = (
    <>
      <Icon name="delete" className={styles.icon} />
      <span className={styles.label}>{lang('RelayDeletedMessage')}</span>
      <span className={styles.time}>{deletedTime}</span>
      {!hasNoDeletedCopy && <Icon name="down" className={buildClassName(styles.chevron, isExpanded && styles.open)} />}
    </>
  );

  return (
    <div
      id={getMessageHtmlId(message.id)}
      className={buildClassName(
        'DeletedMessage',
        'message-list-item',
        styles.root,
        isLastInList && 'last-in-list',
      )}
      data-message-id={message.id}
    >
      {hasNoDeletedCopy ? (
        <div className={styles.summary} title={lang('RelayDeletedMessageNoCopy')}>{summary}</div>
      ) : (
        <button
          type="button"
          className={buildClassName(styles.summary, styles.interactive)}
          aria-expanded={isExpanded}
          aria-controls={panelId}
          onClick={handleToggle}
        >
          {summary}
        </button>
      )}
      {isExpanded && !hasNoDeletedCopy && (
        <div id={panelId} className={styles.panel} role="group" aria-label={lang('RelayDeletedMessage')}>
          <div className={styles.meta}>
            <span className={styles.author}>
              {sender ? getPeerTitle(lang, sender) : lang('RelayDeletedMessageUnknownSender')}
            </span>
            <span>{lang('RelayDeletedMessageSent', { time: sentTime })}</span>
            <span className={styles.badge}>{lang('RelayDeletedMessageMark')}</span>
          </div>
          {thumbnailUri && <img src={thumbnailUri} alt="" className={styles.thumbnail} draggable={false} />}
          <div className={styles.content} dir="auto">
            <MessageSummary message={message} noEmoji truncateLength={MAX_SUMMARY_LENGTH} />
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { message }): Complete<StateProps> => {
    return {
      sender: selectSender(global, message),
    };
  },
)(DeletedMessage));
