// Тесты загрузки файлов: части, параллелизм, возобновление, отмена, ошибки, отсутствие потолков.
// Транспорт подменён; настоящий Telegram не используется
/* eslint-disable @typescript-eslint/require-await */
import { afterEach, describe, expect, test, vi } from 'vitest';

import type TelegramClient from './TelegramClient';

import { MAX_UPLOAD_FILEPART_SIZE } from '../../../config';
import { getDcBandwidthManager } from '../../../util/dcBandwithManager';
import { DEFAULT_LIMITS } from '../../../limits';
import { RPCError } from '../errors';
import Api from '../tl/api';
import { clearUploadResumeState, uploadFile } from './uploadFile';

import { getUploadPartSize } from '../Utils';

const KIB = 1024;
const MIB = KIB * KIB;
const PART = 512 * KIB;
let nextDcId = 20000;

type SaveRequest = Api.upload.SaveFilePart | Api.upload.SaveBigFilePart;

// Файл-заглушка: размер любой, байты частей крошечные, чтобы не выделять гигабайты
function createFile(size: number, name = 'fixture.bin', fullBytes = false) {
  let reads = 0;
  const file = {
    name,
    size,
    slice(start: number, end: number) {
      return {
        arrayBuffer: async () => {
          reads++;
          return new Uint8Array(fullBytes ? end - start : 1).fill((start / PART) % 251).buffer;
        },
      };
    },
  } as unknown as File;
  return { file, getReads: () => reads };
}

function createClient(send: (request: SaveRequest) => Promise<unknown>, isPremium = false) {
  const dcId = nextDcId++;
  const sender = {
    send: vi.fn((request: SaveRequest) => send(request)),
    isConnected: () => true,
    _updateCallback: vi.fn(),
  };
  const client = {
    isPremium,
    session: { dcId },
    getSender: vi.fn(async () => sender),
    releaseExportedSender: vi.fn(),
  } as unknown as TelegramClient;
  return { client, sender, manager: getDcBandwidthManager(dcId, isPremium) };
}

afterEach(() => {
  clearUploadResumeState();
  vi.useRealTimers();
});

describe('Выбор размера части', () => {
  test.each([
    [1, 128], [256 * KIB, 128], [256 * KIB + 1, 256], [MIB, 256], [MIB + 1, 512], [4 * 1024 * MIB, 512],
  ])('файл %i байт -> часть %i КиБ', (size, expected) => {
    expect(getUploadPartSize(size)).toBe(expected);
  });

  test('часть никогда не больше 512 КиБ и делит 512 КиБ без остатка', () => {
    for (const size of [1, 1000, 300 * KIB, 5 * MIB, 3000 * MIB]) {
      const bytes = getUploadPartSize(size) * KIB;
      expect(bytes).toBeLessThanOrEqual(MAX_UPLOAD_FILEPART_SIZE);
      expect(MAX_UPLOAD_FILEPART_SIZE % bytes).toBe(0);
    }
  });
});

describe('Отсутствие клиентских потолков', () => {
  test('предел размера задаётся лимитом аккаунта: 4000 частей = ~2 ГБ, 8000 = ~4 ГБ', () => {
    const [regular, premium] = DEFAULT_LIMITS.uploadMaxFileparts;
    expect(regular * MAX_UPLOAD_FILEPART_SIZE).toBe(2000 * MIB);
    expect(premium * MAX_UPLOAD_FILEPART_SIZE).toBe(4000 * MIB);
  });

  test('файл больше 2 ГБ (4001 часть) и ровно 4 ГБ (8000 частей) уходят без отказа клиента', async () => {
    for (const size of [4000 * PART + 1, 8000 * PART]) {
      const parts = new Set<number>();
      const { client, manager } = createClient(async (request) => {
        parts.add((request as Api.upload.SaveBigFilePart).filePart);
        return true;
      }, true);
      const { file } = createFile(size);
      const result = await uploadFile(client, { file, workers: 32 });
      expect(result).toBeInstanceOf(Api.InputFileBig);
      expect(result.parts).toBe(Math.ceil(size / PART));
      expect(parts.size).toBe(result.parts);
      expect(manager.activeRequestSize).toBe(0);
    }
  }, 60000);

  test('maxParts отклоняет заранее и ничего не отправляет', async () => {
    const { client, sender } = createClient(async () => true);
    await expect(uploadFile(client, { file: createFile(10 * PART).file, workers: 4, maxParts: 9 }))
      .rejects.toThrow('UPLOAD_FILE_TOO_BIG');
    expect(sender.send).not.toHaveBeenCalled();
  });

  test('FILE_PARTS_INVALID от сервера превращается в UPLOAD_FILE_TOO_BIG без повторов', async () => {
    const { client, sender } = createClient(async (request) => {
      throw new RPCError('FILE_PARTS_INVALID', request, 400);
    });
    await expect(uploadFile(client, { file: createFile(3 * PART).file, workers: 4 }))
      .rejects.toThrow('UPLOAD_FILE_TOO_BIG');
    expect(sender.send.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('Возобновление', () => {
  test('повтор с тем же ключом шлёт только недостающие части под тем же fileId', async () => {
    const key = 'blob:resume-1';
    const total = 40;
    const firstRun = new Set<number>();
    let firstId: bigint | undefined;
    const first = createClient(async (request) => {
      const big = request as Api.upload.SaveBigFilePart;
      firstId = big.fileId;
      if (big.filePart === 20) throw new Error('BOOM');
      firstRun.add(big.filePart);
      return true;
    });
    await expect(uploadFile(first.client, { file: createFile(total * PART).file, workers: 32, resumeKey: key }))
      .rejects.toThrow('BOOM');
    expect(firstRun.has(20)).toBe(false);

    const secondRun = new Set<number>();
    const second = createClient(async (request) => {
      secondRun.add((request as Api.upload.SaveBigFilePart).filePart);
      return true;
    });
    const progress = vi.fn();
    const result = await uploadFile(second.client, {
      file: createFile(total * PART).file, workers: 32, resumeKey: key, onProgress: progress,
    });
    expect(result.parts).toBe(total);
    expect(result.id).toBe(firstId);
    for (const part of secondRun) expect(firstRun.has(part)).toBe(false);
    expect(new Set([...firstRun, ...secondRun]).size).toBe(total);
    expect(secondRun.has(20)).toBe(true);
    expect(progress.mock.calls[0][0]).toBeCloseTo(firstRun.size / total);
    expect(progress.mock.calls.at(-1)![0]).toBe(1);
  });

  test('успешная загрузка и отмена сбрасывают состояние: следующая начинается заново', async () => {
    const key = 'blob:resume-2';
    let sent = 0;
    const run = async (isCanceled = false) => {
      const { client } = createClient(async () => {
        sent++;
        return true;
      });
      const onProgress = Object.assign(vi.fn(), { isCanceled });
      return uploadFile(client, {
        file: createFile(12 * PART).file, workers: 8, resumeKey: key, onProgress,
      });
    };
    const done = await run();
    expect(sent).toBe(12);
    await expect(run(true)).rejects.toThrow('USER_CANCELED');
    sent = 0;
    const afterCancel = await run();
    expect(sent).toBe(12);
    expect(afterCancel.id).not.toBe(done.id);
  });

  test('без ключа ничего не запоминается', async () => {
    let calls = 0;
    const { client } = createClient(async () => {
      if (++calls === 3) throw new Error('BOOM');
      return true;
    });
    await expect(uploadFile(client, { file: createFile(8 * PART).file, workers: 8 })).rejects.toThrow('BOOM');
    const second = createClient(async () => true);
    await uploadFile(second.client, { file: createFile(8 * PART).file, workers: 8 });
    expect(second.sender.send).toHaveBeenCalledTimes(8);
  });
});

describe('Ошибки и отмена', () => {
  test('временная ошибка RPC повторяется и заканчивается успехом', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { client, manager } = createClient(async (request) => {
      if (++attempts === 1) throw new RPCError('RPC_CALL_FAIL', request, 500);
      return true;
    });
    const result = uploadFile(client, { file: createFile(100 * KIB, 'one.bin', true).file, workers: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toBeInstanceOf(Api.InputFile);
    expect(attempts).toBe(2);
    expect(manager.activeRequestSize).toBe(0);
  });

  test('постоянная ошибка 500 исчерпывает бюджет повторов', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { client } = createClient(async (request) => {
      attempts++;
      throw new RPCError('INTERNAL', request, 500);
    });
    const result = uploadFile(client, { file: createFile(100 * KIB).file, workers: 1 });
    const assertion = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
    expect(attempts).toBe(5);
  });

  test('невосстановимая ошибка части (FILE_PART_INVALID) не повторяется', async () => {
    const { client, sender } = createClient(async (request) => {
      throw new RPCError('FILE_PART_INVALID', request, 400);
    });
    await expect(uploadFile(client, { file: createFile(100 * KIB).file, workers: 1 })).rejects.toThrow();
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  test('отмена в полёте освобождает пропускную способность и все соединения', async () => {
    const onProgress = Object.assign(vi.fn(), { isCanceled: false });
    const { client, manager } = createClient(async () => {
      onProgress.isCanceled = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    });
    await expect(uploadFile(client, { file: createFile(100 * PART).file, workers: 32, onProgress }))
      .rejects.toThrow('USER_CANCELED');
    expect(manager.activeRequestSize).toBe(0);
    expect(manager.queueLength).toBe(0);
    expect((client.releaseExportedSender as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBe((client.getSender as ReturnType<typeof vi.fn>).mock.calls.length);
  });

  test('чтение с диска идёт по частям: каждая часть читается один раз', async () => {
    const { client } = createClient(async () => true);
    const fixture = createFile(25 * PART);
    await uploadFile(client, { file: fixture.file, workers: 32 });
    expect(fixture.getReads()).toBe(25);
  });
});

describe('Синтетический бенч транспорта (задержка 20 мс на часть)', () => {
  test.each([false, true])('128 частей (64 МиБ), премиум=%s: против последовательной отправки', async (premium) => {
    const latency = 20;
    let active = 0;
    let peak = 0;
    const { client } = createClient(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, latency));
      active--;
      return true;
    }, premium);
    const started = performance.now();
    await uploadFile(client, { file: createFile(128 * PART).file, workers: 32 });
    const elapsed = performance.now() - started;
    const serial = 128 * latency;
    // eslint-disable-next-line no-console
    console.log(`bench premium=${premium}: peak in flight=${peak}, ${Math.round(elapsed)} ms vs serial ${serial} ms`);
    expect(peak).toBeGreaterThanOrEqual(premium ? 30 : 15);
    expect(elapsed).toBeLessThan(serial / 3);
  });
});
