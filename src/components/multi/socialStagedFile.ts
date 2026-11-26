import type { ApiAttachment } from '../../api/types';

const CHUNK_BYTES = 1024 * 1024;
const DIRECTORY_NAME = 'relay-social-upload';
const KEY_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type StagedFile = { handle: string; fileName: string; mimeType: string; size: number; sha256: string };
const stagedFiles = new WeakMap<Blob, { sha256: string; release: () => Promise<void> }>();
let storageDirectory: Promise<FileSystemDirectoryHandle> | undefined;

async function openStorageDirectory() {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(DIRECTORY_NAME, { create: true });
  for await (const entry of directory.values()) {
    if (entry.kind !== 'file' || !KEY_PATTERN.test(entry.name)) continue;
    const file = await (entry as FileSystemFileHandle).getFile().catch(() => undefined);
    if (file && Date.now() - file.lastModified > MAX_AGE_MS) await directory.removeEntry(entry.name).catch(() => {});
  }
  return directory;
}

export async function createStagedAttachment(
  requestId: string,
  index: number,
  maximumBytes: number,
  isCanceled: () => boolean,
  onProgress: (loaded: number, total: number) => void,
): Promise<ApiAttachment> {
  if (!navigator.storage?.getDirectory) throw new Error('MEDIA_STORAGE_UNAVAILABLE');
  storageDirectory ||= openStorageDirectory().catch((error) => {
    storageDirectory = undefined;
    throw error;
  });
  const directory = await storageDirectory;
  const { invoke } = await import('@tauri-apps/api/core');
  if (isCanceled()) throw new Error('SOCIAL_SHARE_CANCELED');
  const staged = await invoke<StagedFile>('relay_social_stage_file', { requestId, index, maximumBytes });
  const { handle, fileName, mimeType, size, sha256 } = staged;
  if (!KEY_PATTERN.test(handle)) throw new Error('SOCIAL_SHARE_INVALID_MEDIA');
  let isRetained = false;
  const remove = () => directory.removeEntry(handle).catch(() => undefined);
  try {
    if (!Number.isSafeInteger(size) || size < 1 || size > maximumBytes
      || !/^[a-z\d.-]{1,96}$/i.test(fileName) || fileName.includes('..') || !/^[a-f\d]{64}$/.test(sha256)
      || !/^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm))$/.test(mimeType)) {
      throw new Error('SOCIAL_SHARE_INVALID_MEDIA');
    }
    const entry = await directory.getFileHandle(handle, { create: true });
    const writable = await entry.createWritable();
    try {
      onProgress(0, size);
      for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
        if (isCanceled()) throw new Error('SOCIAL_SHARE_CANCELED');
        const length = Math.min(CHUNK_BYTES, size - offset);
        const bytes = await invoke<ArrayBuffer>('relay_social_read_staged_chunk', { handle, offset, length });
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== length) throw new Error('MEDIA_PARTIAL_BODY');
        await writable.write(bytes);
        onProgress(offset + length, size);
      }
      if (isCanceled()) throw new Error('SOCIAL_SHARE_CANCELED');
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    const stored = await entry.getFile();
    if (stored.size !== size) throw new Error('MEDIA_PARTIAL_BODY');
    const file = new File([stored], fileName, { type: mimeType });
    const blobUrl = URL.createObjectURL(file);
    stagedFiles.set(file, { sha256, release: remove });
    isRetained = true;
    return {
      blob: file, blobUrl, filename: fileName, size, mimeType, shouldSendAsFile: true,
      uploadResumeKey: `social:${requestId}:${index}:${sha256}`,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new Error('MEDIA_DISK_FULL', { cause: error });
    }
    throw error;
  } finally {
    if (!isRetained) await remove();
    await invoke('relay_social_release_staged_file', { handle }).catch(() => undefined);
  }
}

export function getStagedFingerprint(blob: Blob) {
  return stagedFiles.get(blob)?.sha256;
}

export function releaseStagedFile(blob: Blob) {
  const staged = stagedFiles.get(blob);
  if (!staged) return;
  stagedFiles.delete(blob);
  return staged.release();
}
