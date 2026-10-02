import type TelegramClient from './TelegramClient';

import { getDcBandwidthManager } from '../../../util/dcBandwithManager';
import waitForMediaTransfer from '../../../util/waitForMediaTransfer';
import { FloodPremiumWaitError, FloodWaitError } from '../errors';
import Api from '../tl/api';

import LocalUpdatePremiumFloodWait from '../../../api/gramjs/updates/UpdatePremiumFloodWait';
import { generateRandomBytes, readBigIntFromBuffer, sleep } from '../Helpers';
import { getUploadPartSize } from '../Utils';

interface OnProgress {
  isCanceled?: boolean;

  // Float between 0 and 1
  (progress: number): void;
}

export interface UploadFileParams {
  file: File;
  workers: number;
  onProgress?: OnProgress;
}

const KB_TO_BYTES = 1024;
const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024;
const DISCONNECT_SLEEP = 1000;
const SENDER_TIMEOUT = 60 * 1000;
const SENDER_RETRIES = 5;

export async function uploadFile(
  client: TelegramClient,
  fileParams: UploadFileParams,
  shouldDebugExportedSenders?: boolean,
): Promise<Api.InputFile | Api.InputFileBig> {
  const { file, onProgress } = fileParams;
  const isPremium = Boolean(client.isPremium);
  const { name, size } = file;
  if (!size) throw new Error('UPLOAD_EMPTY_FILE');
  const fileId = readBigIntFromBuffer(generateRandomBytes(8), true, true);
  const isLarge = size > LARGE_FILE_THRESHOLD;
  const partSize = getUploadPartSize(size) * KB_TO_BYTES;
  const partCount = Math.ceil(size / partSize);
  const dcManager = getDcBandwidthManager(client.session.dcId, isPremium);
  const promises: Promise<void>[] = [];
  let uploadedParts = 0;
  let uploadError: Error | undefined;
  let isPremiumFloodWaitSent = false;
  const isCanceled = () => Boolean(onProgress?.isCanceled) || uploadError !== undefined;

  onProgress?.(0);

  try {
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      if (isCanceled()) throw uploadError ?? new Error('USER_CANCELED');
      const senderIndex = await waitForMediaTransfer(
        dcManager.requestWorker(false, partSize), isCanceled, undefined, undefined,
        (index) => dcManager.releaseWorker(index, partSize),
      );
      const blobSlice = file.slice(partIndex * partSize, (partIndex + 1) * partSize);
      const partPromise = (async () => {
        try {
          const partBytes = new Uint8Array(await waitForMediaTransfer(blobSlice.arrayBuffer(), isCanceled));
          let retryCount = 0;
          while (true) {
            if (isCanceled()) throw new Error('USER_CANCELED');
            let sender;
            const abortController = new AbortController();
            try {
              sender = await waitForMediaTransfer(
                client.getSender(client.session.dcId, senderIndex, isPremium), isCanceled, SENDER_TIMEOUT, undefined,
                (lateSender) => client.releaseExportedSender(lateSender), 'UPLOAD_TIMEOUT',
              );
              if (isCanceled()) throw new Error('USER_CANCELED');
              const wasSaved = await waitForMediaTransfer(sender.send(
                isLarge ? new Api.upload.SaveBigFilePart({
                  fileId, filePart: partIndex, fileTotalParts: partCount, bytes: partBytes,
                }) : new Api.upload.SaveFilePart({ fileId, filePart: partIndex, bytes: partBytes }),
                abortController.signal,
              )!, isCanceled, SENDER_TIMEOUT, () => abortController.abort(), undefined, 'UPLOAD_TIMEOUT');
              if (isCanceled()) throw new Error('USER_CANCELED');
              if (wasSaved !== true) throw new Error('UPLOAD_PART_REJECTED');
              uploadedParts++;
              onProgress?.(uploadedParts / partCount);
              return;
            } catch (err) {
              if (shouldDebugExportedSenders) {
                // eslint-disable-next-line no-console
                console.log('Upload part failed', { partIndex, senderIndex });
              }
              if (isCanceled() || (err instanceof Error && err.message === 'USER_CANCELED')) throw err;
              if (err instanceof FloodWaitError) {
                if (err instanceof FloodPremiumWaitError && !isPremiumFloodWaitSent) {
                  sender?._updateCallback(new LocalUpdatePremiumFloodWait(true));
                  isPremiumFloodWaitSent = true;
                }
                await waitForMediaTransfer(sleep(err.seconds * 1000), isCanceled);
                continue;
              }
              if ((sender && !sender.isConnected()) || (err instanceof Error && err.message === 'UPLOAD_TIMEOUT')) {
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
          uploadError ??= err instanceof Error ? err : new Error('UPLOAD_FAILED', { cause: err });
        } finally {
          dcManager.releaseWorker(senderIndex, partSize);
        }
      })();
      promises.push(partPromise);
    }
    await Promise.all(promises);
    if (isCanceled()) throw uploadError ?? new Error('USER_CANCELED');

    return isLarge ? new Api.InputFileBig({ id: fileId, parts: partCount, name })
      : new Api.InputFile({ id: fileId, parts: partCount, name, md5Checksum: '' });
  } catch (err) {
    if (uploadError) throw uploadError;
    throw err;
  } finally {
    uploadError ??= new Error('USER_CANCELED');
    await Promise.all(promises);
  }
}
