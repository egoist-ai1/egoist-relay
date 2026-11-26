import { memo, useEffect, useMemo, useRef, useState } from '../../lib/teact/teact';

import type { RegularLangKey } from '../../types/language';
import type { LibraryEntry, LibrarySnapshot } from './mediaLibrarySource';

import buildClassName from '../../util/buildClassName';
import { formatFileSize } from '../../util/textFormat';
import { getSourceUrl } from './mediaLibrarySource';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import SafeLink from '../common/SafeLink';

import styles from './MediaOperationsPanel.module.scss';

type FileType = 'all' | 'link' | 'photo' | 'video' | 'audio' | 'file';
type OwnProps = { isLocked: boolean; refreshKey: string };

const PAGE_SIZE = 50;
const LOADING_DELAY = 100;
const FILE_TYPE_KEYS: Record<FileType, RegularLangKey> = {
  all: 'RelayLibraryAllTypes', link: 'RelayLibraryLinks', photo: 'RelayLibraryPhotos', video: 'RelayLibraryVideos',
  audio: 'RelayLibraryAudio', file: 'RelayLibraryFiles',
};
const SERVICE_KEYS = {
  telegram: 'RelayTelegramTitle', x: 'RelayXTitle', instagram: 'RelayInstagramTitle',
} as const;

const MediaLibrary = ({ isLocked, refreshKey }: OwnProps) => {
  const lang = useLang();
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>();
  const linkInputRef = useRef<HTMLInputElement>();
  const addLinkRef = useRef<HTMLButtonElement>();
  const wasAddingLinkRef = useRef(false);
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>({ isLocked, entries: [] });
  const [query, setQuery] = useState('');
  const [service, setService] = useState<'all' | LibraryEntry['service']>('all');
  const [fileType, setFileType] = useState<FileType>('all');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [reload, setReload] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoadError, setHasLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const [actionError, setActionError] = useState<{ id: string; missingFile: boolean }>();
  const [hasRemovedEntry, setHasRemovedEntry] = useState(false);
  const [isAddingLink, setIsAddingLink] = useState(false);
  const [sourceLink, setSourceLink] = useState('');
  const [linkError, setLinkError] = useState<RegularLangKey>();
  const formatter = useMemo(() => new Intl.DateTimeFormat(lang.code, {
    month: 'short', day: 'numeric', year: 'numeric',
  }), [lang.code]);
  const entries = useMemo(() => snapshot.entries.map((entry) => {
    const sourceUrl = getSourceUrl(entry);
    return { ...entry, sourceUrl, searchText: `${entry.fileName} ${sourceUrl || ''}`.toLocaleLowerCase(lang.code) };
  }).sort((a, b) => b.savedAt - a.savedAt), [snapshot.entries, lang.code]);
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase(lang.code);
    return entries.filter((entry) => (service === 'all' || entry.service === service)
      && (fileType === 'all' || getFileType(entry) === fileType)
      && (!search || entry.searchText.includes(search)));
  }, [entries, query, lang.code, service, fileType]);
  const hasFilters = query.trim() || service !== 'all' || fileType !== 'all';

  useEffect(() => {
    const generation = ++generationRef.current;
    setHasLoadError(false);
    if (isLocked) {
      setSnapshot({ isLocked: true, entries: [] });
      setIsLoading(false);
      return undefined;
    }
    const timer = setTimeout(() => setIsLoading(true), LOADING_DELAY);
    void import('@tauri-apps/api/core').then(({ invoke }) => invoke<LibrarySnapshot>('relay_library_list'))
      .then((next) => {
        if (generationRef.current !== generation) return;
        setSnapshot(next);
        setHasLoadError(Boolean(next.error));
      })
      .catch(() => {
        if (generationRef.current === generation) setHasLoadError(true);
      })
      .finally(() => {
        clearTimeout(timer);
        if (generationRef.current === generation) setIsLoading(false);
      });
    return () => {
      clearTimeout(timer);
      generationRef.current = generation + 1;
    };
  }, [isLocked, refreshKey, reload]);

  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [query, service, fileType]);

  useEffect(() => {
    if (isAddingLink) linkInputRef.current?.focus();
    else if (wasAddingLinkRef.current) addLinkRef.current?.focus();
    wasAddingLinkRef.current = isAddingLink;
  }, [isAddingLink]);

  const runAction = useLastCallback(async (id: string, action: 'open' | 'reveal' | 'remove') => {
    if (isLocked || snapshot.isLocked || busyRef.current) return;
    busyRef.current = true;
    setBusyId(id);
    setActionError(undefined);
    setHasRemovedEntry(false);
    const generation = generationRef.current;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('relay_library_action', { id, action });
      if (action === 'remove') {
        setSnapshot((previous) => ({ ...previous, entries: previous.entries.filter((entry) => entry.id !== id) }));
        setHasRemovedEntry(true);
        setReload((previous) => previous + 1);
        searchRef.current?.focus();
      }
    } catch (error) {
      if (generation !== generationRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setActionError({ id, missingFile: /FILE_(?:MISSING|UNAVAILABLE|CHANGED)/.test(message) });
    } finally {
      busyRef.current = false;
      setBusyId(undefined);
    }
  });

  const handleSaveLink = useLastCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLocked || snapshot.isLocked || busyRef.current || !sourceLink.trim()) return;
    busyRef.current = true;
    setBusyId('new-link');
    setLinkError(undefined);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('relay_library_action', { action: 'save-link', sourceUrl: sourceLink });
      setSourceLink('');
      setIsAddingLink(false);
      setQuery('');
      setService('all');
      setFileType('all');
      setReload((previous) => previous + 1);
    } catch (error) {
      setLinkError(String(error).includes('MEDIA_SOURCE_DENIED')
        ? 'RelayLibraryInvalidLink' : 'RelayLibraryActionError');
    } finally {
      busyRef.current = false;
      setBusyId(undefined);
    }
  });

  if (isLocked || snapshot.isLocked) return <p className={styles.empty}>{lang('RelayLibraryLocked')}</p>;
  if (hasLoadError) {
    return (
      <div className={styles.libraryStatus}>
        <p className={styles.error} role="alert">{lang('RelayLibraryError')}</p>
        <button type="button" className={styles.actionButton} onClick={() => setReload(reload + 1)}>
          {lang('RelayOperationRetry')}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.library} data-relay-library="true">
      <div className={styles.libraryFilters}>
        <input
          ref={searchRef}
          className={styles.libraryInput}
          type="search"
          value={query}
          aria-label={lang('RelayLibrarySearch')}
          placeholder={lang('RelayLibrarySearch')}
          onInput={(event) => setQuery(event.currentTarget.value)}
          autoComplete="off"
        />
        <div className={styles.libraryFilterRow}>
          <select
            className={styles.librarySelect}
            value={service}
            aria-label={lang('RelayLibraryService')}
            onChange={(event) => setService(event.currentTarget.value as typeof service)}
          >
            <option value="all">{lang('RelayLibraryAllServices')}</option>
            {Object.entries(SERVICE_KEYS).map(([id, key]) => <option key={id} value={id}>{lang(key)}</option>)}
          </select>
          <select
            className={styles.librarySelect}
            value={fileType}
            aria-label={lang('RelayLibraryType')}
            onChange={(event) => setFileType(event.currentTarget.value as FileType)}
          >
            {Object.entries(FILE_TYPE_KEYS).map(([id, key]) => <option key={id} value={id}>{lang(key)}</option>)}
          </select>
        </div>
        {isAddingLink ? (
          <form onSubmit={handleSaveLink}>
            <input
              ref={linkInputRef}
              className={styles.libraryInput}
              type="url"
              value={sourceLink}
              aria-label={lang('RelayLibraryPostLink')}
              placeholder={lang('RelayLibraryPostLink')}
              onInput={(event) => setSourceLink(event.currentTarget.value)}
              maxLength={2048}
              required
            />
            {linkError && <p className={styles.error} role="alert">{lang(linkError)}</p>}
            <div className={styles.actions}>
              <button type="submit" className={styles.actionButton} disabled={Boolean(busyId)}>
                {lang('RelayOperationSave')}
              </button>
              <button
                type="button"
                className={styles.actionButton}
                disabled={Boolean(busyId)}
                onClick={() => setIsAddingLink(false)}
              >
                {lang('Cancel')}
              </button>
            </div>
          </form>
        ) : (
          <button
            ref={addLinkRef}
            type="button"
            className={styles.actionButton}
            onClick={() => setIsAddingLink(true)}
          >
            {lang('RelayLibraryAddLink')}
          </button>
        )}
      </div>
      {isLoading && <p className={styles.libraryStatus} role="status">{lang('RelayLibraryLoading')}</p>}
      {hasRemovedEntry && <p className={styles.libraryStatus} role="status">{lang('RelayLibraryRemoved')}</p>}
      {!filtered.length && !isLoading ? (
        <p className={styles.empty}>{lang(hasFilters ? 'RelayLibraryNoResults' : 'RelayLibraryEmpty')}</p>
      ) : (
        <ol className={styles.list}>
          {filtered.slice(0, limit).map((entry) => (
            <li key={entry.id} className={styles.operation} data-library-id={entry.id}>
              <div className={styles.row}>
                <span className={styles.source}>{lang(SERVICE_KEYS[entry.service])}</span>
                <time className={styles.timestamp} dateTime={new Date(entry.savedAt).toISOString()}>
                  {formatter.format(entry.savedAt)}
                </time>
              </div>
              {!entry.isLink && <h3 className={styles.operationTitle} dir="auto">{entry.fileName}</h3>}
              {!entry.isLink && <p className={styles.meta}>{formatFileSize(lang, entry.size)}</p>}
              {entry.sourceUrl && (
                <SafeLink
                  className={styles.librarySource}
                  url={entry.sourceUrl}
                  text={entry.sourceUrl}
                  shouldSkipModal
                />
              )}
              {actionError?.id === entry.id && (
                <p className={styles.error} role="alert">
                  {lang(actionError.missingFile ? 'RelayOperationMissingFile' : 'RelayLibraryActionError')}
                </p>
              )}
              <div className={styles.actions}>
                {!entry.isLink && (
                  <>
                    <button
                      type="button"
                      className={styles.actionButton}
                      disabled={Boolean(busyId)}
                      onClick={() => { void runAction(entry.id, 'open'); }}
                    >
                      {lang('RelayOperationOpen')}
                    </button>
                    <button
                      type="button"
                      className={styles.actionButton}
                      disabled={Boolean(busyId)}
                      onClick={() => { void runAction(entry.id, 'reveal'); }}
                    >
                      {lang('RelayOperationReveal')}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={styles.actionButton}
                  disabled={Boolean(busyId)}
                  onClick={() => { void runAction(entry.id, 'remove'); }}
                >
                  {lang('RelayLibraryRemove')}
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {filtered.length > limit && (
        <button
          type="button"
          className={buildClassName(styles.actionButton, styles.more)}
          onClick={() => setLimit(limit + PAGE_SIZE)}
        >
          {lang('RelayOperationMore')}
        </button>
      )}
    </div>
  );
};

function getFileType({ mimeType, fileName, isLink }: LibraryEntry): Exclude<FileType, 'all'> {
  if (isLink) return 'link';
  if (mimeType.startsWith('image/')) return 'photo';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/octet-stream') {
    if (/\.(?:jpe?g|png|webp|gif|avif|heic|bmp)$/i.test(fileName)) return 'photo';
    if (/\.(?:mp4|webm|mov|m4v|mkv|avi)$/i.test(fileName)) return 'video';
    if (/\.(?:mp3|m4a|ogg|opus|aac|wav|flac)$/i.test(fileName)) return 'audio';
  }
  return 'file';
}

export default memo(MediaLibrary);
