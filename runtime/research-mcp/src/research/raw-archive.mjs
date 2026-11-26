// Сырой проверяемый архив: JSONL-сегменты по платформам (raw/<provider>/seg-NNNN.jsonl) с ротацией по размеру.
// Запись идёт ДО транзакции SQLite и сначала fsync; в БД сохраняется только подтверждённая длина сегмента.
// После kill -9 «хвост» сверх подтверждённой длины отсекается при открытии — локаторы в БД никогда не висят в пустоте.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { assertSafeDirectory } from './job-store.mjs';
import { OrchError } from './orch-core.mjs';

export const SEGMENT_BYTES = 64 * 1024 ** 2;
const segmentName = seq => `seg-${String(seq).padStart(4, '0')}.jsonl`;

async function fileSha(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function createRawArchive({ directory, maxSegmentBytes = SEGMENT_BYTES, sync = true } = {}) {
  const state = new Map(); // provider -> { seq, name, handle, committed, pos, damaged }
  let readHandles = new Map();

  async function ensureDirectory(provider) {
    const dir = path.join(directory, provider);
    await assertSafeDirectory(dir, { create: true });
    return dir;
  }
  async function openCurrent(provider, seq, committed, create) {
    const dir = await ensureDirectory(provider);
    const name = segmentName(seq);
    const file = path.join(dir, name);
    let handle; let damaged = false;
    if (create) handle = await fs.open(file, 'w', 0o600);
    else {
      try { handle = await fs.open(file, 'r+'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; handle = await fs.open(file, 'w', 0o600); damaged = committed > 0; }
      const size = (await handle.stat()).size;
      if (size > committed) await handle.truncate(committed);
      else if (size < committed) damaged = true;
    }
    const position = damaged ? (await handle.stat()).size : committed;
    return { seq, name, handle, committed: position, pos: position, damaged };
  }

  return {
    /** segments: строки таблицы segments { provider, seq, committed_bytes, sealed }. */
    async open(segments) {
      for (const provider of new Set(segments.map(row => row.provider))) {
        const rows = segments.filter(row => row.provider === provider).sort((a, b) => a.seq - b.seq);
        const current = rows.at(-1);
        if (current.sealed) state.set(provider, await openCurrent(provider, current.seq + 1, 0, true));
        else state.set(provider, await openCurrent(provider, current.seq, current.committed_bytes, false));
      }
      return [...state].filter(([, item]) => item.damaged).map(([provider, item]) => ({ provider, seq: item.seq }));
    },
    /** Текущие позиции для вставки строк segments новой платформы. */
    async ensure(provider) {
      if (!state.has(provider)) state.set(provider, await openCurrent(provider, 1, 0, true));
      return { seq: state.get(provider).seq, name: state.get(provider).name };
    },
    /**
     * Дописывает строки (Buffer без перевода строки). Возвращает локаторы и сведения о ротации/позиции для БД.
     * Подтверждение длины — отдельный шаг commit() после успешной транзакции SQLite.
     */
    async append(provider, lines) {
      await this.ensure(provider);
      let current = state.get(provider);
      const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
      const rotated = [];
      if (current.pos > 0 && current.pos + total > maxSegmentBytes) {
        await current.handle.sync();
        const file = path.join(directory, provider, current.name);
        rotated.push({ provider, seq: current.seq, name: current.name, bytes: current.pos, sha256: await fileSha(file) });
        await current.handle.close();
        current = await openCurrent(provider, current.seq + 1, 0, true);
        state.set(provider, current);
      }
      const buffer = Buffer.concat(lines.flatMap(line => [line, Buffer.from('\n')]));
      const locators = []; let offset = current.pos;
      for (const line of lines) { locators.push({ seq: current.seq, name: current.name, offset, length: line.length }); offset += line.length + 1; }
      try {
        let written = 0;
        while (written < buffer.length) {
          const { bytesWritten } = await current.handle.write(buffer, written, buffer.length - written, current.pos + written);
          written += bytesWritten;
        }
        if (sync) await current.handle.sync();
      } catch (error) {
        await this.rollback(provider).catch(() => {});
        throw error;
      }
      current.pos += buffer.length;
      return { locators, rotated, tail: { seq: current.seq, name: current.name, bytes: current.pos } };
    },
    /** Транзакция SQLite зафиксирована: подтверждённая длина сегмента догоняет записанную. */
    commit(provider) { const current = state.get(provider); if (current) current.committed = current.pos; },
    /** Транзакция не удалась: отбрасываем записанное сверх подтверждённого. */
    async rollback(provider) {
      const current = state.get(provider);
      if (!current) return;
      current.pos = current.committed;
      await current.handle.truncate(current.committed);
    },
    tail(provider) { const current = state.get(provider); return current ? { seq: current.seq, name: current.name, bytes: current.committed } : undefined; },
    async read(provider, name, offset, length) {
      if (!/^seg-\d{4,}\.jsonl$/.test(name) || !['telegram', 'x', 'instagram'].includes(provider) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 0 || length > 16 * 1024 ** 2) throw new OrchError('NOT_FOUND', 'Raw locator is invalid.');
      const key = `${provider}/${name}`;
      let handle = readHandles.get(key);
      if (!handle) { handle = await fs.open(path.join(directory, provider, name), 'r'); readHandles.set(key, handle); if (readHandles.size > 8) { const [first] = readHandles; readHandles.delete(first[0]); await first[1].close(); } }
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    },
    async close() {
      for (const item of state.values()) await item.handle.close().catch(() => {});
      for (const handle of readHandles.values()) await handle.close().catch(() => {});
      state.clear(); readHandles = new Map();
    },
  };
}
