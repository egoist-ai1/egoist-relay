import { bufferToHex } from '../../../util/encoding/buffer';

const DIRECTORY_NAME = 'telegram-download-checkpoints-v1';
const CHECKPOINT_NAME = /^[a-f\d]{64}\.part$/;
const MAX_RETAINED_FILES = 3;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MEBIBYTE = 1024 * 1024;
const MIN_FILE_SIZE = 32 * MEBIBYTE;
const MAX_FILE_SIZE = 4096 * MEBIBYTE;
const CHECKPOINT_INTERVAL = 4 * MEBIBYTE;
const OFFSET_ALIGNMENT = 4096;
const RECORD_SIZE = 16;
const HEADER_SIZE = 2 * RECORD_SIZE;

export async function openResumableDownload(
  size: number, identity: readonly (string | number | boolean)[],
) {
  if (!Number.isSafeInteger(size) || size < MIN_FILE_SIZE || size > MAX_FILE_SIZE
    || !navigator.storage?.getDirectory || !navigator.locks
    || typeof FileSystemFileHandle === 'undefined' || !FileSystemFileHandle.prototype.createSyncAccessHandle) {
    return undefined;
  }

  try {
    const bytes = new TextEncoder().encode(JSON.stringify([size, ...identity]));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const name = `${bufferToHex(new Uint8Array(digest))}.part`;
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(DIRECTORY_NAME, { create: true });

    return await navigator.locks.request(DIRECTORY_NAME, async () => {
      let retained = 0;
      let existing: FileSystemFileHandle | undefined;
      for await (const entry of directory.values()) {
        if (entry.kind !== 'file' || !CHECKPOINT_NAME.test(entry.name)) continue;
        const file = entry as FileSystemFileHandle;
        const stat = await file.getFile().catch(() => undefined);
        if (stat && Date.now() - stat.lastModified > MAX_AGE_MS
          && await directory.removeEntry(entry.name).then(() => true, () => false)) continue;
        retained++;
        if (entry.name === name) existing = file;
      }
      if (!existing && retained >= MAX_RETAINED_FILES) return undefined;
      const file = existing ?? await directory.getFileHandle(name, { create: true });
      const access = await file.createSyncAccessHandle();
      try {
        const { offset: resumeFrom, nextRecord } = readCheckpoint(access, size);
        const expectedLength = resumeFrom ? HEADER_SIZE + resumeFrom : 0;
        if (access.getSize() !== expectedLength) access.truncate(expectedLength);
        if (resumeFrom && resumeFrom < size) {
          // Затёртая контрольная запись не станет действительной после увеличения файла
          writeAll(access, new Uint8Array(RECORD_SIZE), nextRecord);
        }
        return new ResumableDownload(directory, file, access, size, resumeFrom, nextRecord);
      } catch (error) {
        access.close();
        throw error;
      }
    });
  } catch {
    // Блокировка другой вкладкой, недоступное хранилище или квота оставляют обычную загрузку доступной
    return undefined;
  }
}

class ResumableDownload {
  private access?: FileSystemSyncAccessHandle;

  private committed: number;

  private contiguous: number;

  private readonly laterParts = new Map<number, number>();

  constructor(
    private readonly directory: FileSystemDirectoryHandle,
    private readonly file: FileSystemFileHandle,
    access: FileSystemSyncAccessHandle,
    private readonly size: number,
    readonly resumeFrom: number,
    private nextRecord: number,
  ) {
    this.access = access;
    this.contiguous = resumeFrom;
    this.committed = resumeFrom;
  }

  write(bytes: Uint8Array, offset: number) {
    writeAll(this.access!, bytes, HEADER_SIZE + offset);
    if (offset !== this.contiguous) {
      this.laterParts.set(offset, offset + bytes.byteLength);
      return;
    }

    this.contiguous += bytes.byteLength;
    while (this.laterParts.has(this.contiguous)) {
      const next = this.laterParts.get(this.contiguous)!;
      this.laterParts.delete(this.contiguous);
      this.contiguous = next;
    }
    if (this.contiguous - this.committed >= CHECKPOINT_INTERVAL) this.checkpoint();
  }

  async getData() {
    if (this.contiguous !== this.size) throw new Error('DOWNLOAD_INCOMPLETE');
    this.checkpoint();
    this.close();
    const file = await this.file.getFile();
    if (file.size !== HEADER_SIZE + this.size) throw new Error('DOWNLOAD_INCOMPLETE');
    return new File([file.slice(HEADER_SIZE)], file.name, { type: file.type });
  }

  async dispose(shouldRemove: boolean) {
    try {
      if (this.access && !shouldRemove) this.checkpoint();
    } catch {
      // Предыдущая успешно записанная точка остаётся пригодной для восстановления
    } finally {
      this.close();
    }
    if (shouldRemove || !this.committed) await this.directory.removeEntry(this.file.name).catch(() => undefined);
  }

  private close() {
    this.access?.close();
    this.access = undefined;
  }

  private checkpoint() {
    if (this.committed === this.contiguous) return;
    const access = this.access!;
    // Сначала сбрасываем данные, затем публикуем длину непрерывного участка и её контрольное значение
    access.flush();
    const header = new DataView(new ArrayBuffer(RECORD_SIZE));
    header.setFloat64(0, this.contiguous);
    header.setFloat64(8, -this.contiguous);
    writeAll(access, new Uint8Array(header.buffer), this.nextRecord);
    access.flush();
    this.committed = this.contiguous;
    this.nextRecord = RECORD_SIZE - this.nextRecord;
  }
}

function readCheckpoint(access: FileSystemSyncAccessHandle, size: number) {
  const bytes = new Uint8Array(HEADER_SIZE);
  const header = new DataView(bytes.buffer);
  const read = access.read(bytes, { at: 0 });
  const length = access.getSize();
  let offset = 0;
  let nextRecord = 0;
  for (let record = 0; record + RECORD_SIZE <= read; record += RECORD_SIZE) {
    const value = header.getFloat64(record);
    if (Number.isSafeInteger(value) && value > offset && value <= size
      && (value === size || value % OFFSET_ALIGNMENT === 0)
      && header.getFloat64(record + RECORD_SIZE / 2) === -value && length >= HEADER_SIZE + value) {
      offset = value;
      nextRecord = RECORD_SIZE - record;
    }
  }
  return { offset, nextRecord };
}

export function writeAll(access: FileSystemSyncAccessHandle, bytes: Uint8Array, offset: number) {
  let written = 0;
  while (written < bytes.byteLength) {
    const remaining = bytes.subarray(written);
    const count = access.write(remaining, { at: offset + written });
    if (!Number.isSafeInteger(count) || count <= 0 || count > remaining.byteLength) {
      throw new Error('DOWNLOAD_INCOMPLETE_WRITE');
    }
    written += count;
  }
}
