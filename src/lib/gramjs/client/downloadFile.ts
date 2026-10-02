import type TelegramClient from './TelegramClient';
import type { SizeType } from './TelegramClient';

import { getDcBandwidthManager } from '../../../util/dcBandwithManager';
import waitForMediaTransfer from '../../../util/waitForMediaTransfer';
import { FloodPremiumWaitError, FloodWaitError, RPCError } from '../errors';
import Api from '../tl/api';

import LocalUpdatePremiumFloodWait from '../../../api/gramjs/updates/UpdatePremiumFloodWait';
import { sleep } from '../Helpers';
import { getDownloadPartSize } from '../Utils';

interface OnProgress {
  isCanceled?: boolean;
  (
    progress: number, // Float between 0 and 1.
    ...args: any[]
  ): void;
}

export interface DownloadFileParams {
  fileSize?: number;
  workers?: number;
  partSizeKb?: number;
  start?: number;
  end?: number;
  progressCallback?: OnProgress;
  isPriority?: boolean;
  isResearchRequest?: boolean;
}

export type DownloadFileWithDcParams = DownloadFileParams & { dcId: number };

export interface DownloadMediaParams {
  sizeType?: SizeType;
  progressCallback?: OnProgress;
}

// Chunk sizes for `upload.getFile` must be multiple of the smallest size
const MIN_CHUNK_SIZE = 4096;
const DEFAULT_CHUNK_SIZE = 1024; // KB
const ONE_MB = 1024 * 1024;
const DISCONNECT_SLEEP = 1000;

// when the sender requests hangs for 60 second we will reimport
const SENDER_TIMEOUT = 60 * 1000;
// Telegram may have server issues so we try several times
const SENDER_RETRIES = 5;

class FileView {
  private type: 'memory' | 'opfs';

  private size?: number;

  private buffer?: Uint8Array;

  private largeFile?: FileSystemFileHandle;

  private largeFileAccessHandle?: FileSystemSyncAccessHandle;

  private downloadsFolder?: FileSystemDirectoryHandle;

  private largeFileName?: string;

  private chunks: Uint8Array[] = [];

  constructor(size?: number) {
    this.size = size;

    this.type = (size && size > (self as any).maxBufferSize) ? 'opfs' : 'memory';
  }

  async init() {
    if (this.type === 'opfs') {
      if (typeof FileSystemFileHandle === 'undefined' || !FileSystemFileHandle.prototype.createSyncAccessHandle) {
        throw new Error('`createSyncAccessHandle` is not available. Cannot download files larger than 2GB.');
      }
      const directory = await navigator.storage.getDirectory();
      this.downloadsFolder = await directory.getDirectoryHandle('downloads', { create: true });
      this.largeFileName = Math.random().toString();
      this.largeFile = await this.downloadsFolder.getFileHandle(this.largeFileName, { create: true });
      this.largeFileAccessHandle = await this.largeFile.createSyncAccessHandle();
    } else {
      this.buffer = new Uint8Array(this.size || 0);
    }
  }

  write(data: Uint8Array, offset: number) {
    if (this.type === 'opfs') {
      let writtenTotal = 0;
      while (writtenTotal < data.byteLength) {
        const remaining = data.subarray(writtenTotal);
        const writtenBytes = this.largeFileAccessHandle!.write(remaining, { at: offset + writtenTotal });
        if (!Number.isSafeInteger(writtenBytes) || writtenBytes <= 0 || writtenBytes > remaining.byteLength) {
          throw new Error('DOWNLOAD_INCOMPLETE_WRITE');
        }
        writtenTotal += writtenBytes;
      }
      return;
    }

    if (this.size) {
      const endOffset = offset + data.length;
      if (endOffset > this.buffer!.length) { // Slow path for potential overflow
        if (offset >= this.buffer!.length) return; // Ignore writes past the end
        const writeLength = this.buffer!.length - offset;
        this.buffer!.set(data.subarray(0, writeLength), offset);
        return;
      }

      this.buffer!.set(data, offset);
      return;
    }

    this.chunks.push(data);
  }

  async getData(): Promise<Uint8Array | File> {
    if (this.type === 'opfs') {
      this.largeFileAccessHandle!.flush();
      this.largeFileAccessHandle!.close();
      this.largeFileAccessHandle = undefined;
      return this.largeFile!.getFile();
    }
    if (this.size !== undefined) return this.buffer!;
    const size = this.chunks.reduce((total, chunk) => total + chunk.length, 0);
    const buffer = new Uint8Array(size);
    let offset = 0;
    this.chunks.forEach((chunk) => {
      buffer.set(chunk, offset);
      offset += chunk.length;
    });
    return buffer;
  }

  async dispose(shouldRemove: boolean) {
    this.largeFileAccessHandle?.close();
    this.largeFileAccessHandle = undefined;
    if (shouldRemove && this.downloadsFolder && this.largeFileName) {
      await this.downloadsFolder.removeEntry(this.largeFileName);
    }
  }
}

export async function downloadFile(
  client: TelegramClient,
  inputLocation: Api.TypeInputFileLocation,
  fileParams: DownloadFileWithDcParams,
  shouldDebugExportedSenders?: boolean,
) {
  const { dcId } = fileParams;
  for (let i = 0; i < SENDER_RETRIES; i++) {
    try {
      return await downloadFile2(client, inputLocation, fileParams, shouldDebugExportedSenders);
    } catch (err: unknown) {
      if (fileParams.isResearchRequest) throw err;
      if (err instanceof RPCError && (
        err.errorMessage.startsWith('SESSION_REVOKED')
        || err.errorMessage.startsWith('CONNECTION_NOT_INITED')
      ) && i < SENDER_RETRIES - 1) {
        await client._cleanupExportedSenders(dcId);
      } else {
        throw err;
      }
    }
  }

  return undefined;
}

async function downloadFile2(
  client: TelegramClient,
  inputLocation: Api.TypeInputFileLocation,
  fileParams: DownloadFileWithDcParams,
  shouldDebugExportedSenders?: boolean,
) {
  let { partSizeKb, end } = fileParams;
  const {
    fileSize, dcId, progressCallback, isPriority, isResearchRequest, start = 0,
  } = fileParams;

  const fileId = 'id' in inputLocation ? inputLocation.id : undefined;
  const logWithId = (...args: any[]) => {
    if (!shouldDebugExportedSenders) return;
    // eslint-disable-next-line no-console
    console.log(`⬇️ [${fileId?.toString()}/${fileParams.dcId}]`, ...args);
  };

  logWithId('Downloading file...');
  const isPremium = Boolean(client.isPremium);

  if (!Number.isSafeInteger(start) || start < 0
    || (end !== undefined && (!Number.isSafeInteger(end) || end < start))
    || (fileSize !== undefined && (!Number.isSafeInteger(fileSize) || fileSize < 0))) {
    throw new Error('Invalid download range');
  }
  if (fileSize !== undefined) {
    if (fileSize === 0 || start >= fileSize) return new Uint8Array(0);
    end = Math.min(end ?? fileSize - 1, fileSize - 1);
  }
  const rangeSize = end !== undefined ? end - start + 1 : undefined;

  if (!partSizeKb) {
    partSizeKb = fileSize ? getDownloadPartSize(rangeSize || fileSize) : DEFAULT_CHUNK_SIZE;
  }

  const partSize = partSizeKb * 1024;
  const noParallel = end === undefined;

  if (!Number.isSafeInteger(partSize) || partSize <= 0 || partSize > ONE_MB
    || partSize % MIN_CHUNK_SIZE !== 0 || ONE_MB % partSize !== 0) {
    throw new Error(`The part size must be evenly divisible by ${MIN_CHUNK_SIZE}`);
  }

  client._log.info(`Downloading file in chunks of ${partSize} bytes`);

  const fileView = new FileView(rangeSize);
  const promises: Promise<void>[] = [];
  let offset = start;
  // Used for files with unknown size and for manual cancellations
  let hasEnded = false;

  let downloadedSize = 0;
  progressCallback?.(0);

  // Limit updates to one per file
  let isPremiumFloodWaitSent = false;

  const dcManager = getDcBandwidthManager(dcId, isPremium);
  let downloadError: Error | undefined;
  let isCompleted = false;
  const isCanceled = () => Boolean(progressCallback?.isCanceled) || downloadError !== undefined;

  try {
    await fileView.init();
    while (!hasEnded && (end === undefined || offset <= end)) {
      if (isCanceled()) throw downloadError ?? new Error('USER_CANCELED');

      // Telegram ranges align to 1 KB and stay inside a single 1 MB boundary
      const requestOffset = Math.floor(offset / MIN_CHUNK_SIZE) * MIN_CHUNK_SIZE;
      const limit = Math.min(partSize, ONE_MB - (requestOffset % ONE_MB));
      const isPrecise = ONE_MB % limit !== 0;
      const partStart = offset;
      const partEnd = Math.min(requestOffset + limit - 1, end ?? Infinity);
      const senderIndex = await waitForMediaTransfer(
        dcManager.requestWorker(Boolean(isPriority), limit), isCanceled, undefined, undefined,
        (index) => dcManager.releaseWorker(index, limit),
      );

      const partPromise = (async () => {
        try {
          let retryCount = 0;
          while (true) {
            if (isCanceled()) throw new Error('USER_CANCELED');
            let sender;
            const abortController = new AbortController();
            try {
              sender = await waitForMediaTransfer(
                client.getSender(dcId, senderIndex, isPremium), isCanceled, SENDER_TIMEOUT, undefined,
                (lateSender) => client.releaseExportedSender(lateSender),
              );
              if (isCanceled()) throw new Error('USER_CANCELED');
              const result = await waitForMediaTransfer(sender.send(new Api.upload.GetFile({
                location: inputLocation,
                offset: BigInt(requestOffset),
                limit,
                precise: isPrecise || undefined,
              }), abortController.signal, false, isResearchRequest)!, isCanceled,
              SENDER_TIMEOUT, () => abortController.abort());

              if (!result) throw new Error('DOWNLOAD_EMPTY_RESPONSE');
              if (result instanceof Api.upload.FileCdnRedirect) throw new Error('CDN download not supported');
              if (isCanceled()) throw new Error('USER_CANCELED');

              const bytes = result.bytes.subarray(partStart - requestOffset, partEnd - requestOffset + 1);
              if (rangeSize !== undefined && bytes.length !== partEnd - partStart + 1) {
                throw new Error('DOWNLOAD_INCOMPLETE');
              }
              fileView.write(bytes, partStart - start);
              downloadedSize += bytes.length;
              if (noParallel && result.bytes.length < limit) hasEnded = true;
              const progress = rangeSize !== undefined ? Math.min(downloadedSize / rangeSize, 1) : (hasEnded ? 1 : 0);
              progressCallback?.(progress);
              logWithId(`[${senderIndex}/${dcId}]`, `Downloaded ${downloadedSize} bytes`);
              return;
            } catch (err) {
              if (isCanceled() || (err instanceof Error && err.message === 'USER_CANCELED')) throw err;
              if (isResearchRequest) throw err;
              if (err instanceof FloodWaitError) {
                if (err instanceof FloodPremiumWaitError && !isPremiumFloodWaitSent) {
                  sender?._updateCallback(new LocalUpdatePremiumFloodWait(false));
                  isPremiumFloodWaitSent = true;
                }
                await waitForMediaTransfer(sleep(err.seconds * 1000), isCanceled);
                continue;
              }
              if ((sender && !sender.isConnected()) || (err instanceof Error && err.message === 'DOWNLOAD_TIMEOUT')) {
                if (++retryCount < SENDER_RETRIES) {
                  await waitForMediaTransfer(sleep(DISCONNECT_SLEEP), isCanceled);
                  continue;
                }
              }
              throw err;
            } finally {
              if (sender) client.releaseExportedSender(sender);
            }
          }
        } catch (err) {
          downloadError ??= err instanceof Error ? err : new Error('DOWNLOAD_FAILED', { cause: err });
        } finally {
          dcManager.releaseWorker(senderIndex, limit);
        }
      })();

      promises.push(partPromise);
      offset = partEnd + 1;
      if (noParallel) await partPromise;
    }
    await Promise.all(promises);
    if (isCanceled()) throw downloadError ?? new Error('USER_CANCELED');
    const data = await fileView.getData();
    isCompleted = true;
    return data;
  } catch (err) {
    if (downloadError) throw downloadError;
    throw err;
  } finally {
    downloadError ??= new Error('USER_CANCELED');
    await Promise.all(promises);
    await fileView.dispose(!isCompleted);
  }
}
