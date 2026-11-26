import { memo, useEffect, useState } from '../../lib/teact/teact';
import { getGlobal } from '../../global';

import { IS_TAURI } from '../../util/browser/globalEnvironment';
import { IS_WINDOWS } from '../../util/browser/windowEnvironment';
import { handleError } from '../../util/handleError';

import useLang from '../../hooks/useLang';

import Modal from '../ui/Modal';

import styles from './NoticeHistoryModal.module.scss';

const SERVICE_KEYS = {
  telegram: 'RelayTelegramTitle',
  x: 'RelayXTitle',
  instagram: 'RelayInstagramTitle',
} as const;

const MAX_RECENT = 24;
const RETENTION_MS = 15 * 60 * 1000;

type Service = keyof typeof SERVICE_KEYS;
type Entry = { service: Service; at: number };
type OwnProps = {
  isOpen: boolean;
  isLocked: boolean;
  hiddenServices?: readonly Service[];
  onClose: NoneToVoidFunction;
  onCloseAnimationEnd?: NoneToVoidFunction;
  onSelectService: (service: Service) => void;
};

function isService(value: unknown): value is Service {
  return typeof value === 'string' && Object.hasOwn(SERVICE_KEYS, value);
}

const NoticeHistoryModal = ({
  isOpen, isLocked, hiddenServices, onClose, onCloseAnimationEnd, onSelectService,
}: OwnProps) => {
  const lang = useLang();
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    if (!IS_TAURI || !IS_WINDOWS) return undefined;
    let isDisposed = false;
    let unlisten: VoidFunction | undefined;

    async function subscribe() {
      const { listen } = await import('@tauri-apps/api/event');
      if (isDisposed) return;
      const release = await listen<{ service?: unknown }>('relay-lagom-notice-delivered', ({ payload }) => {
        if (isDisposed || getGlobal().passcode?.isScreenLocked) return;
        const service = payload?.service;
        if (!isService(service)) return;
        const at = performance.now();
        setEntries((current) => [
          { service, at },
          ...current.filter((entry) => at - entry.at < RETENTION_MS).slice(0, MAX_RECENT - 1),
        ]);
      });
      if (isDisposed) release();
      else unlisten = release;
    }

    void subscribe().catch((error) => handleError(error));
    return () => {
      isDisposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!entries.length) return undefined;
    if (isLocked) {
      setEntries([]);
      return undefined;
    }
    const oldest = entries[entries.length - 1];
    const timeout = window.setTimeout(() => {
      const cutoff = performance.now() - RETENTION_MS;
      setEntries((current) => current.filter((entry) => entry.at > cutoff));
    }, Math.ceil(Math.max(0, oldest.at + RETENTION_MS - performance.now())));
    return () => window.clearTimeout(timeout);
  }, [entries, isLocked]);

  const counts = new Map<Service, number>();
  if (!isLocked) {
    entries.forEach(({ service }) => {
      if (!hiddenServices?.includes(service)) {
        counts.set(service, (counts.get(service) ?? 0) + 1);
      }
    });
  }

  return (
    <Modal
      isOpen={isOpen && !isLocked}
      title={lang('RelayNoticeHistory')}
      className={styles.modal}
      contentClassName={styles.content}
      hasCloseButton
      noFreezeOnClose
      onClose={onClose}
      onCloseAnimationEnd={onCloseAnimationEnd}
    >
      {!isLocked && (counts.size ? (
        <ul className={styles.list}>
          {Array.from(counts, ([service, count]) => {
            const name = lang(SERVICE_KEYS[service]);
            const descriptionId = `relay-notice-history-${service}`;
            return (
              <li key={service}>
                <button
                  type="button"
                  className={styles.service}
                  aria-label={lang('RelayNoticeHistoryOpenService', { service: name })}
                  aria-describedby={descriptionId}
                  onClick={() => {
                    if (!getGlobal().passcode?.isScreenLocked) onSelectService(service);
                  }}
                >
                  <span className={styles.name}>{name}</span>
                  <span id={descriptionId} className={styles.count}>{lang('RelayNoticeHistoryCount', { count })}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : <p className={styles.empty}>{lang('RelayNoticeHistoryEmpty')}</p>)}
    </Modal>
  );
};

export default memo(NoticeHistoryModal);
