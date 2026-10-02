import {
  memo, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from '../../lib/teact/teact';
import { getActions } from '../../global';

import type { DocumentPreview, DocumentPreviewErrorCode } from '../../util/documentPreview';
import type { DocumentReaderState } from '../../util/documentReaderState';
import { ApiMediaFormat } from '../../api/types';

import { getDocumentMediaHash } from '../../global/helpers';
import captureKeyboardListeners from '../../util/captureKeyboardListeners';
import { copyTextToClipboardFromPromise } from '../../util/clipboard';
import { disableDirectTextInput, enableDirectTextInput } from '../../util/directInputManager';
import buildDocumentClipboardText from '../../util/documentClipboard';
import {
  buildDocumentSearchPattern, decodeDocumentPreviewText, DocumentPreviewError, getDocumentPreviewLimit,
  highlightDocumentHtml,
  isTextDocumentExtension, limitDocumentPreview, MAX_DOCUMENT_SEARCH_MATCHES, parseDocxPreview,
  parseMarkdownPreview, readDocumentPreviewBytes,
} from '../../util/documentPreview';
import {
  closeDocumentReader, getDocumentReaderState, subscribeToDocumentReader,
} from '../../util/documentReaderState';
import * as mediaLoader from '../../util/mediaLoader';
import { formatFileSize } from '../../util/textFormat';
import trapFocus from '../../util/trapFocus';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useUniqueId from '../../hooks/useUniqueId';

import Spinner from '../ui/Spinner';
import Icon from './icons/Icon';

import styles from './DocumentReaderModal.module.scss';

type LoadedDocument = {
  document: DocumentReaderState['document'];
  extension: string;
  preview?: DocumentPreview;
  pdfUrl?: string;
  error?: DocumentPreviewErrorCode;
};
const MAX_SEARCH_QUERY_LENGTH = 256;

const DocumentReaderModal = () => {
  const lang = useLang();
  const titleId = useUniqueId();
  const [state, setState] = useState<DocumentReaderState>(getDocumentReaderState);
  const [loaded, setLoaded] = useState<LoadedDocument>();
  const [searchQuery, setSearchQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>();

  const { isOpen, document, message, blobUrl, extension, fileName, size } = state;
  const current = loaded?.document === document && loaded?.extension === extension ? loaded : undefined;
  const isLoading = Boolean(isOpen && !current);
  const isCodeOrText = isTextDocumentExtension(extension);
  const isMarkdown = extension === 'md' || extension === 'markdown';
  const canSearch = isCodeOrText || isMarkdown || extension === 'docx';
  const content = current?.preview?.content || '';
  const isTruncated = current?.preview?.isTruncated;
  const handleClose = useLastCallback(closeDocumentReader);
  const handleRetry = useLastCallback(() => setReloadKey((previous) => previous + 1));
  const handleBackdropClick = useLastCallback((event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) handleClose();
  });
  const handleCancel = useLastCallback((event: React.SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    handleClose();
  });

  useEffect(() => subscribeToDocumentReader((nextState) => {
    if (!nextState.isOpen) setLoaded(undefined);
    setState(nextState);
  }), []);

  useEffect(() => {
    setSearchQuery('');
  }, [document, extension, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen || !dialogRef.current) return undefined;
    const dialog = dialogRef.current;
    const previousFocus = window.document.activeElement instanceof HTMLElement
      ? window.document.activeElement : undefined;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    disableDirectTextInput();
    const releaseFocus = trapFocus(dialogRef.current!);
    const releaseKeyboard = captureKeyboardListeners({
      onEsc: (event) => {
        event.preventDefault();
        handleClose();
      },
    });
    return () => {
      releaseKeyboard();
      releaseFocus();
      enableDirectTextInput();
    };
  }, [handleClose, isOpen]);

  useEffect(() => {
    if (!isOpen || !document) return undefined;
    const abortController = new AbortController();
    const { signal } = abortController;
    const mediaHash = getDocumentMediaHash(document, 'download');
    const releaseMedia = mediaHash ? mediaLoader.retainMedia(mediaHash, ApiMediaFormat.BlobUrl) : undefined;
    setLoaded(undefined);

    async function loadDocument() {
      try {
        const limit = getDocumentPreviewLimit(extension);
        if (size > limit) throw new DocumentPreviewError('tooLarge');
        const url = blobUrl || (mediaHash ? await mediaLoader.fetch(mediaHash, ApiMediaFormat.BlobUrl) : undefined);
        signal.throwIfAborted();
        if (!url) throw new DocumentPreviewError('unavailable');
        const bytes = await readDocumentPreviewBytes(url, limit, signal);
        signal.throwIfAborted();
        if (extension === 'pdf') {
          setLoaded({ document, extension, pdfUrl: url });
        } else {
          const preview = extension === 'docx' ? parseDocxPreview(bytes)
            : limitDocumentPreview(decodeDocumentPreviewText(bytes));
          setLoaded({ document, extension, preview });
        }
      } catch (err) {
        if (signal.aborted) return;
        setLoaded({
          document, extension, error: err instanceof DocumentPreviewError ? err.code : 'unavailable',
        });
      }
    }
    void loadDocument();
    return () => {
      abortController.abort();
      releaseMedia?.();
    };
  }, [blobUrl, document, extension, isOpen, reloadKey, size]);

  const formattedContent = useMemo(() => {
    if (!isMarkdown && extension !== 'docx') return undefined;
    return highlightDocumentHtml(
      isMarkdown ? parseMarkdownPreview(content) : content,
      searchQuery,
      styles.highlight,
    );
  }, [content, extension, isMarkdown, searchQuery]);

  const textPreview = useMemo(() => {
    if (!isCodeOrText) return undefined;
    let count = 0;
    const pattern = searchQuery.trim() ? buildDocumentSearchPattern(searchQuery) : undefined;
    const lines = content.split('\n');
    const rendered = lines.map((line, index) => {
      if (!pattern || count >= MAX_DOCUMENT_SEARCH_MATCHES) {
        return <div key={index} className={styles.lineRow}>{line || ' '}</div>;
      }
      const parts: React.ReactNode[] = [];
      let offset = 0;
      for (const match of line.matchAll(pattern)) {
        if (count >= MAX_DOCUMENT_SEARCH_MATCHES) break;
        parts.push(line.slice(offset, match.index));
        parts.push(<mark key={match.index} className={styles.highlight}>{match[0]}</mark>);
        offset = match.index + match[0].length;
        count++;
      }
      parts.push(line.slice(offset) || ' ');
      return <div key={index} className={styles.lineRow}>{parts}</div>;
    });
    return { rendered, lineCount: lines.length, count };
  }, [content, isCodeOrText, searchQuery]);
  const plainContent = useMemo(() => buildDocumentClipboardText(content, extension), [content, extension]);
  const hasText = Boolean(plainContent.trim());
  const searchMatches = formattedContent?.count ?? textPreview?.count ?? 0;

  const handleCopy = useLastCallback(() => {
    if (!hasText) return;
    void copyTextToClipboardFromPromise(
      Promise.resolve(plainContent),
      () => getActions().showNotification({ message: { key: isTruncated ? 'RelayReaderCopyDone' : 'TextCopied' } }),
      () => getActions().showNotification({ message: { key: 'GeneralError' } }),
      'plainText',
    );
  });
  const handleDownload = useLastCallback(() => {
    if (document) getActions().downloadMedia({ media: document, originMessage: message });
  });

  if (!isOpen) return undefined;

  return (
    <dialog
      ref={dialogRef}
      className={styles.backdrop}
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={handleBackdropClick}
      onCancel={handleCancel}
    >
      <div className={styles.modal}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.fileBadge}>{extension}</span>
            <span id={titleId} className={styles.title} title={fileName} dir="auto">{fileName}</span>
            {Boolean(size) && <span className={styles.sizeBadge}>{formatFileSize(lang, size)}</span>}
          </div>
          <div className={styles.headerRight}>
            {canSearch && (
              <div className={styles.searchBox}>
                <Icon name="search" className={styles.searchIcon} />
                <input
                  className={styles.searchInput}
                  type="search"
                  placeholder={lang('RelayReaderSearch')}
                  aria-label={lang('RelayReaderSearch')}
                  maxLength={MAX_SEARCH_QUERY_LENGTH}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.currentTarget.value)}
                />
              </div>
            )}
            {hasText && (
              <button
                type="button"
                className={styles.actionBtn}
                title={lang(isTruncated ? 'RelayReaderCopyPreview' : 'RelayReaderCopy')}
                aria-label={lang(isTruncated ? 'RelayReaderCopyPreview' : 'RelayReaderCopy')}
                onClick={handleCopy}
              >
                <Icon name="copy" className={styles.btnIcon} />
                <span className={styles.actionLabel}>{lang('RelayReaderCopy')}</span>
              </button>
            )}
            <button
              type="button"
              className={styles.actionBtn}
              title={lang('RelayReaderDownload')}
              aria-label={lang('RelayReaderDownload')}
              onClick={handleDownload}
            >
              <Icon name="download" className={styles.btnIcon} />
              <span className={styles.actionLabel}>{lang('RelayReaderDownload')}</span>
            </button>
            <button
              type="button"
              className={styles.closeBtn}
              title={lang('RelayReaderClose')}
              aria-label={lang('RelayReaderClose')}
              onClick={handleClose}
            >
              <Icon name="close" className={styles.closeIcon} />
            </button>
          </div>
        </div>
        {(isTruncated || Boolean(searchQuery.trim())) && (
          <div className={styles.notices} role="status" aria-live="polite">
            {isTruncated && <p className={styles.notice}>{lang('RelayReaderTruncated')}</p>}
            {searchQuery.trim() && (
              <p className={styles.notice}>{lang('RelayReaderSearchMatches', { count: lang.number(searchMatches) })}</p>
            )}
          </div>
        )}
        <div className={styles.body} aria-busy={isLoading}>
          {isLoading && (
            <div className={styles.loadingContainer} role="status">
              <Spinner color="white" />
              <span>{lang('RelayReaderLoading')}</span>
            </div>
          )}
          {current?.error && (
            <div className={styles.errorContainer} role="alert">
              <p className={styles.notice}>
                {lang(current.error === 'tooLarge' ? 'RelayReaderTooLarge'
                  : current.error === 'invalidDocx' ? 'RelayReaderInvalidDocx' : 'RelayReaderUnavailable')}
              </p>
              {current.error === 'unavailable' && (
                <button type="button" className={styles.actionBtn} onClick={handleRetry}>
                  {lang('RelayReaderRetry')}
                </button>
              )}
              <button type="button" className={styles.actionBtn} onClick={handleDownload}>
                <Icon name="download" className={styles.btnIcon} />
                {lang('RelayReaderDownload')}
              </button>
            </div>
          )}
          {current?.pdfUrl && (
            <iframe src={current.pdfUrl} className={styles.pdfFrame} title={fileName} />
          )}
          {current?.preview && !hasText && (
            <div className={styles.loadingContainer} role="status">{lang('RelayReaderEmpty')}</div>
          )}
          {current?.preview && hasText && (
            <div className={styles.scrollContainer} tabIndex={0}>
              {formattedContent && (
                <div
                  className={isMarkdown ? styles.markdownContent : styles.docxContent}
                  dangerouslySetInnerHTML={{ __html: formattedContent.content }}
                />
              )}
              {textPreview && (
                <div className={styles.textContent}>
                  <div className={styles.lineNumbers} aria-hidden="true">
                    {Array.from({ length: textPreview.lineCount }, (_, index) => (
                      <div key={index} className={styles.lineRow}>{index + 1}</div>
                    ))}
                  </div>
                  <div className={styles.textLines}>{textPreview.rendered}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
};

export default memo(DocumentReaderModal);
