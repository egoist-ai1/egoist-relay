import type { SocialShareMode } from './socialShare';

export type MediaOperationStage = 'queued' | 'resolving' | 'downloading' | 'writing' | 'preparing' | 'sending'
  | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'uncertain';
export type SavedMedia = {
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
  journalWarning?: string;
  width?: number;
  height?: number;
};
export type MediaOperationMetadata = Pick<SavedMedia, 'fileName' | 'mimeType' | 'size' | 'width' | 'height'>;
export type MediaOperationProgress = { loaded: number; total?: number; index?: number; count?: number };
export type MediaOperationSend = {
  accountId: string;
  peerId: string;
  threadId?: string;
  recipientName: string;
  confirmed: number;
  total: number;
  randomIds?: string[];
  fingerprints?: string[];
};
export type MediaOperation = {
  id: string;
  attempt: number;
  revision: number;
  kind: 'save' | 'send' | 'download';
  service: 'telegram' | 'x' | 'instagram';
  sourceUrl?: string;
  fileName?: string;
  itemCount?: number;
  mode?: SocialShareMode;
  stage: MediaOperationStage;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  files: SavedMedia[];
  media?: MediaOperationMetadata[];
  send?: MediaOperationSend;
  progress?: MediaOperationProgress;
  error?: string;
  journalWarning?: string;
};
export type NewMediaOperation = Pick<MediaOperation, 'id' | 'kind' | 'service' | 'sourceUrl' | 'fileName' | 'mode'
  | 'send' | 'itemCount'>;
export type MediaOperationPatch = Partial<Pick<MediaOperation,
  'stage' | 'progress' | 'error' | 'sourceUrl' | 'fileName' | 'media'>>
  & { confirmed?: number; total?: number; randomIds?: string[]; fingerprints?: string[] };
export type MediaOperationsSnapshot = {
  epoch?: number;
  operations: MediaOperation[];
  isLocked: boolean;
  error?: string;
};
export type MediaOperationAction =
  { type: 'register'; operation: NewMediaOperation }
  | { type: 'update'; id: string; attempt: number; revision: number; patch: MediaOperationPatch }
  | { type: 'cancel' | 'remove'; id: string }
  | { type: 'retry'; id: string; accountId?: string }
  | { type: 'clear' }
  | { type: 'lock'; isLocked: boolean }
  | { type: 'open' | 'reveal'; id: string; index?: number };

export function isMediaOperationActive(operation: MediaOperation): boolean {
  return ['queued', 'resolving', 'downloading', 'writing', 'preparing', 'sending',
    'cancelling'].includes(operation.stage);
}

export function getMediaOperationPercent(operation: MediaOperation): number | undefined {
  const { loaded, total } = operation.progress || { loaded: 0 };
  return total && total > 0 ? Math.min(100, Math.max(0, Math.floor(loaded / total * 100))) : undefined;
}
