// Журнал аудита: только добавление, цепочка хэшей, ротация по месяцам. Содержимое сообщений, токены и cookie
// не записываются: только имена операций, хэши аргументов, коды, счётчики исходящих запросов и решения политики.
import fs from 'node:fs';
import path from 'node:path';
import { assertSafeDirectory } from './job-store.mjs';
import { looksSecret, sha256, isObject, createAccountAlias } from './orch-core.mjs';
import { realClock } from './clock.mjs';

const GENESIS = '0'.repeat(64);
const FILE = /^audit-\d{4}-\d{2}\.jsonl$/;

function sanitize(value, depth = 0) {
  if (typeof value === 'string') return looksSecret(value) ? '[redacted]' : value.length > 200 ? value.slice(0, 200) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth >= 3) return undefined;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitize(item, depth + 1));
  if (isObject(value)) {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) { const clean = sanitize(item, depth + 1); if (clean !== undefined) result[key.slice(0, 60)] = clean; }
    return result;
  }
  return undefined;
}

// Находит последнюю целую запись. Оборванная запись (kill -9 посреди записи) отсекается, цепочка остаётся проверяемой.
function recoverTail(file) {
  const size = fs.statSync(file).size;
  if (!size) return undefined;
  const fd = fs.openSync(file, 'r+');
  try {
    const length = Math.min(size, 262144);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // Последний элемент — остаток после последнего перевода строки: пустой у целого файла, иначе оборванная запись.
    const rest = lines.pop();
    let end = size - Buffer.byteLength(rest);
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const parsed = JSON.parse(lines[index]);
        if (/^[a-f0-9]{64}$/.test(parsed.hash ?? '') && Number.isSafeInteger(parsed.seq)) {
          if (end < size) fs.ftruncateSync(fd, end);
          return parsed;
        }
      } catch { /* смотрим предыдущую запись */ }
      end -= Buffer.byteLength(lines[index]) + 1;
    }
    return undefined;
  } finally { fs.closeSync(fd); }
}

export async function createAudit({ directory, clock = realClock, durable = true, accountAlias = createAccountAlias() } = {}) {
  await assertSafeDirectory(directory, { create: true });
  let prev = GENESIS; let seq = 0; let fd; let openName; let failures = 0; let closed = false;
  const counters = new Map(); let lastFlush = clock.now();

  const tail = fs.readdirSync(directory).filter(name => FILE.test(name)).sort().at(-1);
  if (tail) {
    const parsed = recoverTail(path.join(directory, tail));
    if (parsed) { prev = parsed.hash; seq = parsed.seq; }
  }
  const monthName = () => `audit-${new Date(clock.now()).toISOString().slice(0, 7)}.jsonl`;

  function write(kind, data, strict) {
    if (closed) return false;
    try {
      const name = monthName();
      if (name !== openName) {
        if (fd !== undefined) fs.closeSync(fd);
        fd = fs.openSync(path.join(directory, name), 'a', 0o600);
        openName = name;
      }
      // Сырой accountRef в журнал не пишется: только локальный алиас.
      const safe = typeof data?.account === 'string' ? { ...data, account: accountAlias(data.account) } : data;
      const record = { seq: seq + 1, ts: new Date(clock.now()).toISOString(), kind, data: sanitize(safe) ?? {}, prev };
      const hash = sha256(prev + JSON.stringify(record));
      fs.writeSync(fd, JSON.stringify({ ...record, hash }) + '\n');
      if (durable) fs.fsyncSync(fd);
      prev = hash; seq += 1;
      return true;
    } catch (error) {
      failures++;
      if (strict) throw error;
      return false;
    }
  }

  const audit = {
    append(kind, data = {}) { return write(kind, data, false); },
    /** Для действий, которые нельзя выполнять без следа (вступление в группу): сбой записи — отказ действия. */
    appendStrict(kind, data = {}) { write(kind, data, true); return true; },
    count(account, cls, method, amount = 1) {
      const key = `${accountAlias(account)}\u0000${cls}\u0000${method}`;
      counters.set(key, (counters.get(key) ?? 0) + amount);
      if (clock.now() - lastFlush >= 60000) audit.flush();
    },
    flush() {
      lastFlush = clock.now();
      if (!counters.size) return;
      const rows = [...counters].map(([key, count]) => { const [account, cls, method] = key.split('\u0000'); return { account, class: cls, method, count }; });
      counters.clear();
      write('requests', { rows: rows.slice(0, 40), omitted: Math.max(0, rows.length - 40) }, false);
    },
    accountAlias,
    get failures() { return failures; },
    get lastHash() { return prev; },
    close() { audit.flush(); closed = true; if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* уже закрыт */ } fd = undefined; } },
  };
  return audit;
}

/** Проверка цепочки без демона: читает все файлы каталога в порядке имён. */
export function verifyAuditChain(directory) {
  let prev = GENESIS; let lines = 0; let files = 0;
  let names;
  try { names = fs.readdirSync(directory).filter(name => FILE.test(name)).sort(); } catch { return { ok: true, files: 0, lines: 0 }; }
  for (const name of names) {
    files++;
    const rows = fs.readFileSync(path.join(directory, name), 'utf8').split('\n').filter(Boolean);
    for (let index = 0; index < rows.length; index++) {
      let value;
      try { value = JSON.parse(rows[index]); } catch { return { ok: false, files, lines, brokenAt: { file: name, line: index + 1 }, reason: 'json_invalid' }; }
      const { hash, ...record } = value;
      if (record.prev !== prev) return { ok: false, files, lines, brokenAt: { file: name, line: index + 1 }, reason: 'prev_mismatch' };
      if (hash !== sha256(prev + JSON.stringify(record))) return { ok: false, files, lines, brokenAt: { file: name, line: index + 1 }, reason: 'hash_mismatch' };
      prev = hash; lines++;
    }
  }
  return { ok: true, files, lines, lastHash: prev };
}
