import type TelegramClient from './TelegramClient';

import { getDcBandwidthManager } from '../../../util/dcBandwithManager';
import waitForMediaTransfer from '../../../util/waitForMediaTransfer';
import {
  FloodPremiumWaitError, FloodWaitError, RPCError, ServerError, TimedOutError,
} from '../errors';
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
  // Стабильный ключ файла (например, blobUrl вложения): повторная загрузка с тем же ключом
  // продолжится с уже сохранённых частей, а не начнётся заново
  resumeKey?: string;
  // Необязательный клиентский предел числа частей (серверный лимит аккаунта); по умолчанию предела нет
  maxParts?: number;
}

interface ResumeState {
  fileId: bigint;
  partSize: number;
  partCount: number;
  done: Set<number>;
  expiresAt: number;
}

const KB_TO_BYTES = 1024;
const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024;
const DISCONNECT_SLEEP = 1000;
const SENDER_TIMEOUT = 60 * 1000;
const SENDER_RETRIES = 5;
const RESUME_TTL = 30 * 60 * 1000;
const RESUME_MAX_ENTRIES = 8;
const TRANSIENT_RPC_ERRORS = new Set([
  'RPC_CALL_FAIL', 'RPC_MCGET_FAIL', 'INTERNAL', 'WORKER_BUSY_TOO_LONG_RETRY', 'MSGID_DECREASE_RETRY',
]);
const FILE_TOO_BIG_ERRORS = /^(FILE_PARTS_INVALID|FILE_PART_TOO_BIG)$/;

const resumeStates = new Map<string, ResumeState>();

export function clearUploadResumeState(resumeKey?: string) {
  if (resumeKey === undefined) resumeStates.clear();
  else resumeStates.delete(resumeKey);
}

function getResumeState(
  resumeKey: string | undefined, partSize: number, partCount: number,
): ResumeState | undefined {
  if (resumeKey === undefined) return undefined;
  const now = Date.now();
  for (const [key, state] of resumeStates) {
    if (state.expiresAt <= now) resumeStates.delete(key);
  }
  let state = resumeStates.get(resumeKey);
  if (state && (state.partSize !== partSize || state.partCount !== partCount)) state = undefined;
  if (!state) {
    state = {
      fileId: readBigIntFromBuffer(generateRandomBytes(8), true, true),
      partSize, partCount, done: new Set(), expiresAt: now + RESUME_TTL,
    };
  }
  // Повторная вставка двигает запись в конец: вытесняется самая старая
  resumeStates.delete(resumeKey);
  resumeStates.set(resumeKey, state);
  while (resumeStates.size > RESUME_MAX_ENTRIES) {
    resumeStates.delete(resumeStates.keys().next().value!);
  }
  return state;
}

function isTransientError(err: unknown) {
  if (err instanceof ServerError || err instanceof TimedOutError) return true;
  return err instanceof RPCError && (TRANSIENT_RPC_ERRORS.has(err.errorMessage) || err.code >= 500);
}

export async function uploadFile(
  client: TelegramClient,
  fileParams: UploadFileParams,
  shouldDebugExportedSenders?: boolean,
): Promise<Api.InputFile | Api.InputFileBig> {
  const {
    file, onProgress, resumeKey, maxParts,
  } = fileParams;
  const isPremium = Boolean(client.isPremium);
  const { name, size } = file;
  if (!size) throw new Error('UPLOAD_EMPTY_FILE');
  const isLarge = size > LARGE_FILE_THRESHOLD;
  const partSize = getUploadPartSize(size) * KB_TO_BYTES;
  const partCount = Math.ceil(size / partSize);
  if (maxParts !== undefined && partCount > maxParts) throw new Error('UPLOAD_FILE_TOO_BIG');
  const resume = getResumeState(resumeKey, partSize, partCount);
  const fileId = resume?.fileId ?? readBigIntFromBuffer(generateRandomBytes(8), true, true);
  const dcManager = getDcBandwidthManager(client.session.dcId, isPremium);
  const promises: Promise<void>[] = [];
  let uploadedParts = resume?.done.size ?? 0;
  let uploadError: Error | undefined;
  let isPremiumFloodWaitSent = false;
  const isCanceled = () => Boolean(onProgress?.isCanceled) || uploadError !== undefined;

  onProgress?.(uploadedParts / partCount);

  try {
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      if (isCanceled()) throw uploadError ?? new Error('USER_CANCELED');
      if (resume?.done.has(partIndex)) continue;
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
              resume?.done.add(partIndex);
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
              if (err instanceof RPCError && FILE_TOO_BIG_ERRORS.test(err.errorMessage)) {
                throw new Error('UPLOAD_FILE_TOO_BIG', { cause: err });
              }
              if (isTransientError(err)) {
                if (++retryCount < SENDER_RETRIES) {
                  await waitForMediaTransfer(sleep(DISCONNECT_SLEEP * retryCount), isCanceled);
                  continue;
                }
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
    if (resumeKey !== undefined) resumeStates.delete(resumeKey);

    return isLarge ? new Api.InputFileBig({ id: fileId, parts: partCount, name })
      : new Api.InputFile({ id: fileId, parts: partCount, name, md5Checksum: '' });
  } catch (err) {
    const finalError = uploadError ?? err;
    // Отмена пользователем сбрасывает возобновление; обрыв и сетевые ошибки оставляют уже сохранённые части
    if (resumeKey !== undefined && finalError instanceof Error && finalError.message === 'USER_CANCELED') {
      resumeStates.delete(resumeKey);
    }
    throw finalError;
  } finally {
    uploadError ??= new Error('USER_CANCELED');
    await Promise.all(promises);
  }
}
