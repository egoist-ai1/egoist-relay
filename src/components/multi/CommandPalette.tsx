import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { memo, useEffect, useMemo, useRef, useState } from '../../lib/teact/teact';
import { getGlobal } from '../../global';

import type { AppId } from './AppSidebar';
import type { PaletteEntry, PaletteGroup, PalettePayload } from './commandPalette.index';

import { isDeletedUser } from '../../global/helpers';
import { getPeerFullTitle, isApiPeerUser } from '../../global/helpers/peers';
import { selectPeer } from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import { unique } from '../../util/iteratees';
import { getTranslationFn } from '../../util/localization';
import sortChatIds from '../common/helpers/sortChatIds';
import { buildPaletteIndex, PALETTE_GROUPS, queryPalette } from './commandPalette.index';
import { buildSavedEntries } from './commandPalette.saved';
import { getMediaOperationsSnapshot } from './mediaOperations';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Avatar from '../common/Avatar';
import Modal from '../ui/Modal';

import styles from './CommandPalette.module.scss';

type OwnProps = {
  isOpen: boolean;
  hiddenApps: AppId[];
  sleepingApps: AppId[];
  onClose: NoneToVoidFunction;
  onRun: (payload: PalettePayload, isSecondary: boolean) => void;
};

type Entry = PaletteEntry<PalettePayload>;

const SEARCH_ENTRY_ID = 'telegram-search';
const APP_IDS: AppId[] = ['telegram', 'x', 'instagram'];
const APP_SWITCH_KEYS = {
  telegram: 'RelaySwitchTelegram', x: 'RelaySwitchX', instagram: 'RelaySwitchInstagram',
} as const;
const APP_TITLE_KEYS = { telegram: 'RelayTelegramTitle', x: 'RelayXTitle', instagram: 'RelayInstagramTitle' } as const;
const GROUP_TITLE_KEYS: Record<PaletteGroup, 'RelayPaletteGroupActions' | 'RelayPaletteGroupTelegram'
  | 'RelayPaletteGroupSaved'> = {
  actions: 'RelayPaletteGroupActions', telegram: 'RelayPaletteGroupTelegram', saved: 'RelayPaletteGroupSaved',
};
const ACTION_ICONS: Record<PalettePayload['type'], string> = {
  app: 'arrow-right',
  operations: 'download',
  relaySettings: 'settings',
  telegramSettings: 'settings',
  chat: 'arrow-right',
  file: 'document',
  telegramSearch: 'search',
};

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function buildTelegramEntries(): Entry[] {
  const global = getGlobal();
  const lang = getTranslationFn();
  const { currentUserId } = global;
  const listIds = global.chats.listIds;
  const ids = unique([
    ...(currentUserId ? [currentUserId] : []),
    ...sortChatIds([...(listIds.active || []), ...(listIds.archived || [])], false, undefined, currentUserId)
      .filter((id) => id !== currentUserId),
    ...(global.contactList?.userIds || []),
  ]);
  const entries: Entry[] = [];
  // Избранное — первым: ищется по «избранное» и «saved», остальные чаты идут в порядке списка
  const savedTitle = lang('SavedMessages');
  for (const id of ids) {
    const peer = selectPeer(global, id);
    if (!peer || (isApiPeerUser(peer) && isDeletedUser(peer))) continue;
    const isSelf = id === currentUserId;
    const title = isSelf ? savedTitle : getPeerFullTitle(lang, peer);
    if (!title) continue;
    const usernames = (peer.usernames || []).map(({ username }) => username);
    entries.push({
      id: `chat:${id}`,
      group: 'telegram',
      title,
      subtitle: usernames[0] ? `@${usernames[0]}` : undefined,
      keywords: isSelf ? [...usernames, 'saved messages', 'избранное'] : usernames,
      payload: { type: 'chat', id },
    });
  }
  return entries;
}

const CommandPalette = ({
  isOpen, hiddenApps, sleepingApps, onClose, onRun,
}: OwnProps) => {
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();
  const listRef = useRef<HTMLDivElement>();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  // Индекс собирается при открытии из уже загруженных данных и нигде не сохраняется
  const index = useMemo(() => {
    if (!isOpen) return undefined;
    const actions: Entry[] = [
      ...APP_IDS.filter((app) => !hiddenApps.includes(app)).map((app): Entry => ({
        id: `app:${app}`,
        group: 'actions',
        title: lang(APP_SWITCH_KEYS[app]),
        subtitle: sleepingApps.includes(app) ? lang('RelayServiceSleeping') : undefined,
        keywords: [lang(APP_TITLE_KEYS[app])],
        payload: { type: 'app', app },
      })),
      {
        id: 'operations', group: 'actions', title: lang('RelayPaletteOpenOperations'),
        keywords: [lang('RelayOperationTitle')], payload: { type: 'operations' },
      },
      {
        id: 'relay-settings', group: 'actions', title: lang('RelayAppSettingsOpen'), payload: { type: 'relaySettings' },
      },
      {
        id: 'telegram-settings', group: 'actions', title: lang('RelayPaletteTelegramSettings'),
        payload: { type: 'telegramSettings' },
      },
    ];
    const { operations, isLocked } = getMediaOperationsSnapshot();
    const saved = isLocked ? [] : buildSavedEntries(operations, {
      getServiceTitle: (service) => lang(APP_TITLE_KEYS[service]),
      formatDate,
    });
    return buildPaletteIndex<PalettePayload>([...actions, ...buildTelegramEntries(), ...saved]);
  }, [isOpen, hiddenApps, sleepingApps, lang]);

  const trimmedQuery = query.trim();
  const results = useMemo(() => {
    if (!index) return [];
    const found = queryPalette(index, query);
    if (!trimmedQuery) return found;
    // Поиск по тексту сообщений идёт на сервере Telegram: запрос уходит туда только по Enter
    const searchEntry: Entry = {
      id: SEARCH_ENTRY_ID,
      group: 'actions',
      title: lang('RelayPaletteSearchTelegram', { query: trimmedQuery }),
      payload: { type: 'telegramSearch', query: trimmedQuery },
    };
    const actionsCount = found.filter((entry) => entry.group === 'actions').length;
    return [...found.slice(0, actionsCount), searchEntry, ...found.slice(actionsCount)];
  }, [index, query, trimmedQuery, lang]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    }
  }, [isOpen]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, activeIndex, results]);

  const handleInput = useLastCallback((event: React.InputEvent<HTMLInputElement>) => {
    setQuery(event.currentTarget.value);
  });

  const runEntry = useLastCallback((entry: Entry | undefined, isSecondary: boolean) => {
    if (!entry) return;
    onRun(entry.payload, isSecondary);
  });

  const handleKeyDown = useLastCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.isComposing) return;
    const count = results.length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (count) setActiveIndex((current) => (current + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (count) setActiveIndex((current) => (current - 1 + count) % count);
        break;
      case 'Enter':
        event.preventDefault();
        runEntry(results[activeIndex], event.shiftKey);
        break;
      default:
        break;
    }
  });

  const matchCount = results.filter((entry) => entry.id !== SEARCH_ENTRY_ID).length;
  const sections = PALETTE_GROUPS.map((group) => ({
    group,
    items: results.map((entry, position) => ({ entry, position })).filter(({ entry }) => entry.group === group),
  })).filter(({ items }) => items.length > 0);

  const activeId = results[activeIndex] ? `relay-palette-option-${activeIndex}` : undefined;

  function renderLeading(entry: Entry) {
    if (entry.payload.type === 'chat') {
      const peer = selectPeer(getGlobal(), entry.payload.id);
      return (
        <Avatar
          peer={peer}
          isSavedMessages={entry.payload.id === getGlobal().currentUserId}
          size="tiny"
        />
      );
    }
    return (
      <i
        className={buildClassName('icon', `icon-${ACTION_ICONS[entry.payload.type]}`, styles.glyph)}
        aria-hidden="true"
      />
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      ariaLabel={lang('RelayPaletteTitle')}
      className={styles.modal}
      contentClassName={styles.content}
      noTitleAutoFocus
      onClose={onClose}
    >
      <div className={styles.search}>
        <i className={buildClassName('icon icon-search', styles.searchIcon)} aria-hidden="true" />
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="relay-palette-list"
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label={lang('RelayPalettePlaceholder')}
          placeholder={lang('RelayPalettePlaceholder')}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div
        ref={listRef}
        id="relay-palette-list"
        className={styles.list}
        role="listbox"
        aria-label={lang('RelayPaletteTitle')}
      >
        {sections.map(({ group, items }) => (
          <div key={group} role="group" aria-labelledby={`relay-palette-group-${group}`}>
            <div id={`relay-palette-group-${group}`} className={styles.groupTitle} role="presentation">
              {lang(GROUP_TITLE_KEYS[group])}
            </div>
            {items.map(({ entry, position }) => (
              <div
                key={entry.id}
                id={`relay-palette-option-${position}`}
                className={buildClassName(styles.option, position === activeIndex && styles.active)}
                role="option"
                aria-selected={position === activeIndex}
                onMouseMove={() => setActiveIndex(position)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runEntry(entry, false)}
              >
                {renderLeading(entry)}
                <span className={styles.text}>
                  <span className={styles.title}>{entry.title}</span>
                  {entry.subtitle && <span className={styles.subtitle}>{entry.subtitle}</span>}
                </span>
              </div>
            ))}
          </div>
        ))}
        {Boolean(trimmedQuery) && !matchCount && <div className={styles.empty}>{lang('RelayPaletteNoResults')}</div>}
      </div>
      <div className={styles.footer}>{lang('RelayPaletteHint')}</div>
      <div className="visually-hidden" role="status" aria-live="polite">
        {trimmedQuery ? lang('RelayPaletteResultsCount', { count: matchCount }) : undefined}
      </div>
    </Modal>
  );
};

export default memo(CommandPalette);
