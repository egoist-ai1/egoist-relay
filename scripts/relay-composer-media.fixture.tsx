/** @jsxImportSource @teact */
import './relay-ui-audit.fixture';
import { useState } from '../src/lib/teact/teact';
import TeactDOM from '../src/lib/teact/teact-dom';
import { getActions, getGlobal } from '../src/global';
import { requestMutation } from '../src/lib/fasterdom/fasterdom';
import { closeDocumentReader, openDocumentReader } from '../src/util/documentReaderState';
import Document from '../src/components/common/Document';
import Modal from '../src/components/ui/Modal';
import useAttachmentModal from '../src/components/middle/composer/hooks/useAttachmentModal';
import type { ApiDocument, ApiAttachment } from '../src/api/types';
const events: {
    name: string;
    detail?: unknown;
}[] = [];
const sends: unknown[] = [];
let pendingCapture: Promise<void> = Promise.resolve();
const documentFile: ApiDocument = {
    id: '990000001', mediaType: 'document', mimeType: 'application/octet-stream', fileName: 'Owned synthetic document — длинное имя.bin', size: 65537
};
async function hashBlob(blob: Blob) {
    const bytes = await blob.arrayBuffer();
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function record(name: string, detail?: unknown) {
    events.push({ name, detail });
}
function protectActions() {
    const actions = getActions() as any;
    ['sendMessage', 'editMessage'].forEach((name) => {
        actions[name] = (payload: {
            attachments?: ApiAttachment[];
            text?: string;
            shouldGroupMessages?: boolean;
            isInvertedMedia?: boolean;
        }) => {
            record(name, { text: payload.text, count: payload.attachments?.length });
            pendingCapture = pendingCapture.then(async () => {
                const attachments = await Promise.all((payload.attachments || []).map(async (attachment) => {
                    const selectedBlob = await (await fetch(attachment.blobUrl)).blob();
                    const bitmap = attachment.mimeType.startsWith('image/') ? await createImageBitmap(selectedBlob) : undefined;
                    const dimensions = bitmap ? { width: bitmap.width, height: bitmap.height } : undefined;
                    bitmap?.close();
                    return {
                        filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size,
                        quick: attachment.quick, audio: attachment.audio, shouldSendAsFile: Boolean(attachment.shouldSendAsFile),
                        shouldSendAsSpoiler: Boolean(attachment.shouldSendAsSpoiler), shouldSendInHighQuality: Boolean(attachment.shouldSendInHighQuality),
                        sourceSha256: attachment.blob ? await hashBlob(attachment.blob) : undefined,
                        selectedSha256: await hashBlob(selectedBlob),
                        selectedBytes: selectedBlob.size, selectedDimensions: dimensions,
                    };
                }));
                sends.push({
                    name, text: payload.text, grouped: payload.shouldGroupMessages, inverted: payload.isInvertedMedia, attachments
                });
            });
        };
    });
    ['cancelUploadMedia', 'deleteMessages', 'deleteScheduledMessages', 'downloadMedia', 'cancelMediaDownload', 'showNotification', 'openLimitReachedModal', 'showAllowedMessageTypesNotification'].forEach((name) => {
        actions[name] = (payload: any) => record(name, { mediaId: payload?.media?.id, limit: payload?.limit, message: payload?.message });
    });
}
const audit: any = (window as any).__relayComposerMedia = {
    events, sends, protect: protectActions, captures: async () => {
        await pendingCapture;
        return sends;
    },
    settings: () => getGlobal().attachmentSettings,
    setGrouped: (shouldSendGrouped: boolean) => getActions().updateAttachmentSettings({ shouldSendGrouped }),
    setInverted: () => getActions().updateAttachmentSettings({ isInvertedMedia: true }),
    resetSettings: () => getActions().updateAttachmentSettings({
        shouldCompress: true, shouldSendGrouped: true, shouldSendInHighQuality: false, isInvertedMedia: undefined
    }),
    openDraft: () => {
        protectActions();
        getActions().openChat({ id: '101' });
    },
    openReader: (mode: string) => {
        protectActions();
        openDocumentReader({ document: {
                ...documentFile, mimeType: 'text/plain', fileName: 'owned-research.txt', size: 72
            }, blobUrl: `${window.location.origin}/composer-owned/reader?mode=${mode}` });
    },
    closeReader: closeDocumentReader,
};
function TransferControls() {
    const [kind, setKind] = useState<string>();
    const [progress, setProgress] = useState<number | undefined>();
    audit.openTransfer = (next: string, value?: number) => {
        protectActions();
        setProgress(value);
        setKind(next);
    };
    audit.closeTransfer = () => setKind(undefined);
    if (!kind)
        return undefined;
    return <Modal isOpen title="Owned actual document transfer controls" hasCloseButton onClose={() => setKind(undefined)}>
    <Document key={kind} id="composer-owned-document" document={documentFile} uploadProgress={kind === 'upload' ? progress : undefined} isDownloading={kind === 'download'} canAutoLoad={false} onCancelUpload={() => record('cancelOwnedUpload')}/>
  </Modal>;
}
function SelectionHookProbe() {
    const [attachments, setAttachments] = useState<ApiAttachment[]>([]);
    const handlers = useAttachmentModal({ attachments, setAttachments, chatId: '101', fileSizeLimit: 16 * 1024 * 1024, canAttachFiles: true, canSendAudios: true, canSendVideos: true, canSendPhotos: true, canSendDocuments: true, editedMessage: undefined });
    audit.hookProbeSelect = handlers.handleFileSelect;
    audit.hookProbeAttachments = () => attachments;
    audit.hookProbeClear = () => {
      for (const attachment of attachments) {
        for (const url of [attachment.blobUrl, attachment.previewBlobUrl, attachment.compressedBlobUrl]) {
          if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
        }
      }
      handlers.handleClearAttachments();
    };
    return undefined;
}
const root = document.createElement('div');
root.id = 'relay-composer-media-root';
document.body.append(root);
protectActions();
requestMutation(() => TeactDOM.render(<><TransferControls /><SelectionHookProbe /></>, root));
