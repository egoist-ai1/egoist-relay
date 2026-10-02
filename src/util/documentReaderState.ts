import type { ApiDocument, ApiMessage } from '../api/types';

import { getDocumentExtension } from '../components/common/helpers/documentInfo';

export interface DocumentReaderState {
  isOpen: boolean;
  document?: ApiDocument;
  message?: ApiMessage;
  blobUrl?: string;
  extension: string;
  fileName: string;
  size: number;
}

export const READABLE_EXTENSIONS = new Set([
  'md', 'markdown',
  'pdf',
  'docx',
  'txt', 'text', 'log',
  'json', 'csv', 'tsv',
  'xml', 'html', 'htm', 'css',
  'js', 'jsx', 'ts', 'tsx',
  'py', 'rs', 'c', 'cpp', 'h', 'hpp', 'java', 'go', 'php', 'rb', 'sh', 'bat', 'ps1',
  'yaml', 'yml', 'toml', 'ini', 'env', 'conf', 'config', 'sql',
]);

export function isReadableDocument(document: ApiDocument): boolean {
  const ext = (getDocumentExtension(document) || '').toLowerCase();
  return READABLE_EXTENSIONS.has(ext);
}

type Listener = (state: DocumentReaderState) => void;

let currentState: DocumentReaderState = {
  isOpen: false,
  extension: '',
  fileName: '',
  size: 0,
};

const listeners = new Set<Listener>();

export function getDocumentReaderState(): DocumentReaderState {
  return currentState;
}

export function subscribeToDocumentReader(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  listeners.forEach((listener) => listener(currentState));
}

export function openDocumentReader(params: {
  document: ApiDocument;
  message?: ApiMessage;
  blobUrl?: string;
}) {
  const ext = (getDocumentExtension(params.document) || '').toLowerCase();
  currentState = {
    isOpen: true,
    document: params.document,
    message: params.message,
    blobUrl: params.blobUrl,
    extension: ext,
    fileName: params.document.fileName || 'Документ',
    size: params.document.size || 0,
  };
  notify();
}

export function updateDocumentReaderBlobUrl(blobUrl: string) {
  if (!currentState.isOpen) return;
  currentState = {
    ...currentState,
    blobUrl,
  };
  notify();
}

export function closeDocumentReader() {
  currentState = {
    isOpen: false,
    extension: '',
    fileName: '',
    size: 0,
  };
  notify();
}
