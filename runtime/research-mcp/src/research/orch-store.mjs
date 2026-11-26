// SQLite-хранилище оркестратора (node:sqlite, WAL): источники, планы, задания, задачи, события, регулятор темпа,
// нормализованные записи с FTS5. Чекпоинт страницы — одна транзакция: записи + курсор + счётчики + события.
// Единственный писатель — демон; блокировка каталога защищает от второго владельца.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertSafeDirectory, assertSafeFile } from './job-store.mjs';
import { FOLD_VERSION, OrchError, foldText } from './orch-core.mjs';

const APP_ID = 0x45534f31;
const SCHEMA_VERSION = 3;

const SOURCES_SCHEMA = `CREATE TABLE sources (source_id TEXT PRIMARY KEY, provider TEXT NOT NULL, ref TEXT NOT NULL, canonical TEXT NOT NULL, kind TEXT, label TEXT,
     state TEXT NOT NULL DEFAULT 'new', state_reason TEXT, empty_confirmed INTEGER NOT NULL DEFAULT 0, items INTEGER NOT NULL DEFAULT 0,
     last_checked INTEGER, resume_cursor TEXT, resume_account TEXT, account_ref TEXT, UNIQUE(provider, canonical, account_ref))`;
const ITEMS_SCHEMA = `CREATE TABLE items (pk INTEGER PRIMARY KEY, provider TEXT NOT NULL, source_id TEXT NOT NULL, item_id TEXT NOT NULL, job_id TEXT NOT NULL,
     ts INTEGER NOT NULL, type TEXT NOT NULL, public_id TEXT NOT NULL, author_id TEXT, author_name TEXT, text TEXT, text_truncated INTEGER NOT NULL DEFAULT 0, lang TEXT,
     views INTEGER, forwards INTEGER, replies INTEGER, reactions INTEGER, likes INTEGER, reposts INTEGER, metrics_json TEXT,
     reply_to TEXT, thread_id TEXT, original_ref TEXT, has_media INTEGER NOT NULL DEFAULT 0, media_json TEXT, links_json TEXT, gaps_json TEXT,
     seg INTEGER NOT NULL, off INTEGER NOT NULL, len INTEGER NOT NULL, content_sha TEXT NOT NULL, text_fp TEXT,
     UNIQUE(provider, source_id, item_id, job_id))`;
const ITEM_INDEXES = [
  'CREATE INDEX items_ts ON items(ts)',
  'CREATE INDEX items_source_ts ON items(source_id, ts)',
  'CREATE INDEX items_job ON items(job_id, pk)',
];

const SCHEMA = [
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  SOURCES_SCHEMA,
  'CREATE INDEX sources_state ON sources(state)',
  'CREATE TABLE lists (list_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, total INTEGER NOT NULL)',
  'CREATE TABLE list_sources (list_id TEXT NOT NULL, ord INTEGER NOT NULL, source_id TEXT NOT NULL, kind TEXT, label TEXT, PRIMARY KEY(list_id, ord))',
  `CREATE TABLE plans (plan_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, list_id TEXT NOT NULL, goal_json TEXT NOT NULL,
     account_ref TEXT, estimate_json TEXT NOT NULL, risk_json TEXT NOT NULL, confirmation_json TEXT NOT NULL, spec_hash TEXT NOT NULL)`,
  `CREATE TABLE jobs (job_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, name TEXT, state TEXT NOT NULL, state_reason TEXT, priority INTEGER NOT NULL DEFAULT 1,
     paused INTEGER NOT NULL DEFAULT 0, ack_risk INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
     goal_json TEXT NOT NULL, est_items INTEGER, items_new INTEGER NOT NULL DEFAULT 0, items_dup INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
     last_served_at INTEGER NOT NULL DEFAULT 0, snapshot_version INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX jobs_state ON jobs(state)',
  `CREATE TABLE tasks (task_id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, source_id TEXT NOT NULL, provider TEXT NOT NULL, stage TEXT NOT NULL,
     state TEXT NOT NULL, cursor TEXT, cursor_account TEXT, attempts INTEGER NOT NULL DEFAULT 0, cursor_resets INTEGER NOT NULL DEFAULT 0,
     waiting_until INTEGER, waiting_reason TEXT, last_error TEXT, items INTEGER NOT NULL DEFAULT 0, new_items INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0,
     empty_confirmed INTEGER NOT NULL DEFAULT 0, partial INTEGER NOT NULL DEFAULT 0, gap_reason TEXT, limit_reached INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL, min_id INTEGER, oldest_ts INTEGER, offset_date INTEGER, UNIQUE(job_id, source_id, stage))`,
  'CREATE INDEX tasks_job ON tasks(job_id, task_id)',
  'CREATE INDEX tasks_state ON tasks(state)',
  ITEMS_SCHEMA,
  ...ITEM_INDEXES,
  "CREATE VIRTUAL TABLE items_fts USING fts5(text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')",
  'CREATE TABLE segments (provider TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, committed_bytes INTEGER NOT NULL, sealed INTEGER NOT NULL DEFAULT 0, sha256 TEXT, PRIMARY KEY(provider, seq))',
  'CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, job_id TEXT, source_id TEXT, kind TEXT NOT NULL, data_json TEXT)',
  'CREATE INDEX events_job ON events(job_id, seq)',
  `CREATE TABLE governor (account_key TEXT NOT NULL, class TEXT NOT NULL, interval_ms REAL NOT NULL, cooldown_until INTEGER NOT NULL DEFAULT 0, breaker_until INTEGER NOT NULL DEFAULT 0,
     last_error_at INTEGER NOT NULL DEFAULT 0, last_grow_at INTEGER NOT NULL DEFAULT 0, floods_json TEXT NOT NULL DEFAULT '[]', used_day TEXT, used_count INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY(account_key, class))`,
  'CREATE TABLE idempotency (key_hash TEXT NOT NULL, scope TEXT NOT NULL, ref_id TEXT NOT NULL, spec_hash TEXT NOT NULL, PRIMARY KEY(key_hash, scope))',
  'CREATE TABLE exports (export_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, spec_hash TEXT NOT NULL, result_json TEXT NOT NULL)',
];

// Пересборка FTS идёт в фоне (store.maintainFts) порциями, чтобы не держать единственный DatabaseSync одной долгой транзакцией.
// Прогресс лежит в meta и переживает перезапуск; fold_version записывается только последней транзакцией, поэтому
// прежняя версия кода, открыв такое хранилище посреди пересборки, пересоберёт индекс сама, синхронно.
const FTS_CHUNK_ROWS = 5000;
const FOLD_SENTINEL = 'rebuilding';
const K_UPTO = 'fts_rebuild_upto_pk'; const K_NEXT = 'fts_rebuild_next_pk'; const K_FOLD = 'fts_rebuild_fold';
// Точная сверка числа документов FTS с записями, у которых есть текст, на очень больших хранилищах дорога (около 0,85 с на 1 млн строк);
// выше порога проверяются только грубые признаки расхождения.
const EXACT_FTS_CHECK_ROWS = 2000000;
/** Причина, по которой индекс надо пересобрать, либо undefined. Не пишет в БД. */
function ftsMismatchReason(db) {
  const indexed = db.prepare('SELECT COUNT(*) AS n FROM items_fts_docsize').get().n;
  const items = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  if (indexed > items) return 'fts_ahead';
  if (items <= EXACT_FTS_CHECK_ROWS) return indexed !== db.prepare("SELECT COUNT(*) AS n FROM items WHERE text IS NOT NULL AND text <> ''").get().n ? 'fts_count' : undefined;
  if (indexed === 0 && db.prepare("SELECT 1 AS n FROM items WHERE text IS NOT NULL AND text <> '' LIMIT 1").get()) return 'fts_empty';
  return undefined;
}

async function acquireLock(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try { handle = await fs.open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await assertSafeFile(file);
      let owner;
      try { owner = JSON.parse(await fs.readFile(file, 'utf8')); } catch { owner = undefined; }
      const alive = owner && Number.isSafeInteger(owner.pid) && (() => { try { process.kill(owner.pid, 0); return true; } catch (probe) { return probe.code !== 'ESRCH'; } })();
      if (alive && owner.pid !== process.pid) throw new OrchError('BUSY', 'Another process owns the research store.');
      if (alive && owner.pid === process.pid) throw new OrchError('BUSY', 'The research store is already open in this process.');
      if (!owner && Date.now() - info.mtimeMs < 5000) throw new OrchError('BUSY', 'The research store is being opened by another process.');
      await fs.unlink(file).catch(() => {});
      continue;
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() })); await handle.sync(); } finally { await handle.close(); }
    return;
  }
  throw new OrchError('BUSY', 'The research store lock could not be claimed.');
}

export async function openStore({ directory, clock, cacheKiB = 32768, synchronous = 'NORMAL', ftsChunkRows = FTS_CHUNK_ROWS } = {}) {
  await assertSafeDirectory(directory, { create: true });
  const lockFile = path.join(directory, 'store.lock');
  await acquireLock(lockFile);
  const file = path.join(directory, 'research.db');
  let db;
  // 'checking' — сверка ещё не выполнена (maintainFts), 'rebuilding' — идёт пересборка, 'ok' | 'rebuilt:<причина>' — готово, 'failed' — пересборка прервана ошибкой.
  let ftsState = 'checking';
  let ftsReason;
  try {
    db = new DatabaseSync(file, { allowExtension: false, enableDoubleQuotedStringLiterals: false, timeout: 5000 });
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=${synchronous}; PRAGMA cache_size=-${cacheKiB}; PRAGMA mmap_size=0; PRAGMA wal_autocheckpoint=2000; PRAGMA foreign_keys=ON;`);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version === 0) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const sql of SCHEMA) db.exec(sql);
        db.prepare('INSERT INTO meta VALUES (?, ?)').run('items_rev', '0');
        db.prepare('INSERT INTO meta VALUES (?, ?)').run('fold_version', FOLD_VERSION);
        db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
      } catch (error) { try { db.exec('ROLLBACK'); } catch { /* нечего откатывать */ } throw error; }
    } else if (![1, 2, SCHEMA_VERSION].includes(version) || db.prepare('PRAGMA application_id').get().application_id !== APP_ID) {
      throw new OrchError('ADAPTER_FAILED', 'The research store has an unsupported schema version.');
    } else if (version < SCHEMA_VERSION) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (version === 1) {
          // Старым источникам с неизвестным владельцем нельзя приписывать текущий аккаунт.
          db.exec(`ALTER TABLE sources RENAME TO sources_v1; ${SOURCES_SCHEMA};
            INSERT INTO sources SELECT sources_v1.*, NULL FROM sources_v1;
            DROP TABLE sources_v1;
            CREATE INDEX sources_state ON sources(state);
            UPDATE jobs SET paused=1, state='paused', state_reason='profile_binding_unknown'
              WHERE state IN ('queued','running','waiting','paused');`);
        }
        // Существующие pk остаются rowid полнотекстового индекса. Сырые сегменты и локаторы не меняются.
        db.exec(`ALTER TABLE items RENAME TO items_previous; ${ITEMS_SCHEMA};
          INSERT INTO items SELECT * FROM items_previous;
          DROP TABLE items_previous;
          ALTER TABLE jobs ADD COLUMN snapshot_version INTEGER NOT NULL DEFAULT 0;`);
        for (const sql of ITEM_INDEXES) db.exec(sql);
        db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
      } catch (error) { try { db.exec('ROLLBACK'); } catch { /* нечего откатывать */ } throw error; }
    }
    // Словарь терминов FTS нужен выбору плана запроса; создаётся идемпотентно, в том числе для ранее созданных хранилищ.
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS items_vocab USING fts5vocab(items_fts, 'row')");
    // Этап 2: нижняя граница идентификатора сообщения для режима refresh хранится в задаче (стабильно при перезапуске демона).
    if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'min_id')) db.exec('ALTER TABLE tasks ADD COLUMN min_id INTEGER');
    // Продолжение Telegram-источника после потери курсора: самая старая собранная запись задачи и привязанная к цепочке курсора offsetDate.
    for (const column of ['oldest_ts', 'offset_date']) if (!db.prepare('PRAGMA table_info(tasks)').all().some(item => item.name === column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} INTEGER`);
    // При открытии только чтение: версия свёртки и ключи прогресса. Сверка счётчиков и пересборка — в maintainFts.
    const storedFold = db.prepare("SELECT value FROM meta WHERE key='fold_version'").get()?.value;
    if (storedFold !== FOLD_VERSION) { ftsState = 'rebuilding'; ftsReason = 'fold_version'; }
    else if (db.prepare('SELECT 1 AS n FROM meta WHERE key=?').get(K_UPTO) !== undefined) {
      // Версия нормальная, а ключи прогресса остались: прежний код пересобрал индекс сам (откат), прогресс устарел. Убираем его и сверяем обычным путём.
      db.prepare('DELETE FROM meta WHERE key IN (?,?,?)').run(K_UPTO, K_NEXT, K_FOLD);
    }
  } catch (error) {
    try { db?.close(); } catch { /* уже закрыта */ }
    await fs.unlink(lockFile).catch(() => {});
    // Повреждённый файл БД: отдельный понятный отказ вместо сырой ошибки SQLite; файл не удаляется и не перезаписывается.
    if (error?.code === 'ERR_SQLITE_ERROR' && /malformed|not a database|corrupt|no such (table|column)|disk image/i.test(String(error.message))) {
      throw Object.assign(new OrchError('ADAPTER_FAILED', 'The research store file is damaged. It was not changed; restore research.db from a backup or move it aside (raw archive segments stay).'), { reason: 'STORE_DAMAGED' });
    }
    throw error;
  }

  const q = {
    insertItem: db.prepare(`INSERT OR IGNORE INTO items (provider, source_id, item_id, job_id, ts, type, public_id, author_id, author_name, text, text_truncated, lang,
      views, forwards, replies, reactions, likes, reposts, metrics_json, reply_to, thread_id, original_ref, has_media, media_json, links_json, gaps_json, seg, off, len, content_sha, text_fp)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    insertFts: db.prepare('INSERT INTO items_fts(rowid, text) VALUES (?, ?)'),
    upsertSegment: db.prepare('INSERT INTO segments(provider, seq, name, committed_bytes, sealed) VALUES (?,?,?,?,0) ON CONFLICT(provider, seq) DO UPDATE SET committed_bytes=excluded.committed_bytes'),
    sealSegment: db.prepare('UPDATE segments SET sealed=1, sha256=?, committed_bytes=? WHERE provider=? AND seq=?'),
    insertEvent: db.prepare('INSERT INTO events(ts, job_id, source_id, kind, data_json) VALUES (?,?,?,?,?)'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key=?'),
    setMeta: db.prepare('INSERT INTO meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
    upsertSource: db.prepare(`INSERT INTO sources(source_id, provider, ref, canonical, kind, label, account_ref) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET label=COALESCE(excluded.label, sources.label), kind=COALESCE(excluded.kind, sources.kind)`),
    taskUpdateAfterPage: db.prepare(`UPDATE tasks SET items=items+?, new_items=new_items+?, pages=pages+1, cursor=?, cursor_account=?, state=?, attempts=0, waiting_until=NULL,
      waiting_reason=NULL, last_error=NULL, empty_confirmed=?, partial=?, gap_reason=?, limit_reached=?, updated_at=?, oldest_ts=?, offset_date=? WHERE task_id=?`),
    jobAfterPage: db.prepare('UPDATE jobs SET items_new=items_new+?, items_dup=items_dup+?, requests=requests+1, last_served_at=? WHERE job_id=?'),
    sourceAfterPage: db.prepare('UPDATE sources SET items=items+?, last_checked=?, state=?, state_reason=?, empty_confirmed=?, resume_cursor=?, resume_account=? WHERE source_id=?'),
  };

  // Транзакции синхронные и вложенные вызовы входят во внешнюю: откат внешней отменяет всё.
  let depth = 0;
  function tx(fn) {
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth++;
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch { /* транзакция уже завершена движком */ } throw error; }
    finally { depth--; }
  }
  const json = value => (value === null || value === undefined ? null : JSON.stringify(value));
  const parse = text => (text ? JSON.parse(text) : null);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const cached = new Map();
  const stmt = sql => { let s = cached.get(sql); if (!s) { s = db.prepare(sql); cached.set(sql, s); } return s; };

  function appendEvent(jobId, sourceId, kind, data) {
    return Number(q.insertEvent.run(clock.now(), jobId ?? null, sourceId ?? null, kind, json(data)).lastInsertRowid);
  }

  let isClosed = false;
  let ftsPromise;
  let ftsError;
  let ftsFailure;
  const yieldLoop = () => new Promise(resolve => setImmediate(resolve));
  const metaOf = key => q.getMeta.get(key)?.value;
  function finishFts(reason) { ftsState = 'rebuilt:' + reason; }
  async function runFtsMaintenance() {
    if (ftsState === 'checking') {
      const reason = ftsMismatchReason(db);
      if (!reason) { ftsState = 'ok'; return; }
      ftsState = 'rebuilding'; ftsReason = reason;
    }
    // Продолжение допустимо, только если прогресс записан для текущей версии свёртки; иначе начинаем заново.
    let next = metaOf('fold_version') === FOLD_SENTINEL && metaOf(K_FOLD) === FOLD_VERSION && metaOf(K_UPTO) !== undefined ? Number(metaOf(K_NEXT)) : undefined;
    let upto = next === undefined ? undefined : Number(metaOf(K_UPTO));
    if (next === undefined || !Number.isSafeInteger(next) || !Number.isSafeInteger(upto)) {
      tx(() => {
        db.exec("INSERT INTO items_fts(items_fts) VALUES('delete-all')");
        upto = db.prepare('SELECT COALESCE(MAX(pk), 0) AS m FROM items').get().m;
        next = 0;
        q.setMeta.run(K_UPTO, String(upto)); q.setMeta.run(K_NEXT, '0'); q.setMeta.run(K_FOLD, FOLD_VERSION);
        // Сентинел: код без фоновой пересборки не совпадёт с ним и пересоберёт индекс целиком, а не примет частичный.
        q.setMeta.run('fold_version', FOLD_SENTINEL);
      });
    }
    const select = db.prepare('SELECT pk, text FROM items WHERE pk >= ? AND pk <= ? ORDER BY pk LIMIT ?');
    for (;;) {
      await yieldLoop();
      if (isClosed) return;
      const done = tx(() => {
        const rows = select.all(next, upto, ftsChunkRows);
        for (const row of rows) if (row.text) q.insertFts.run(row.pk, foldText(row.text));
        const last = rows.length < ftsChunkRows;
        if (last) {
          q.setMeta.run('fold_version', FOLD_VERSION);
          db.prepare('DELETE FROM meta WHERE key IN (?,?,?)').run(K_UPTO, K_NEXT, K_FOLD);
        } else { next = rows[rows.length - 1].pk + 1; q.setMeta.run(K_NEXT, String(next)); }
        return last;
      });
      if (done) { finishFts(ftsReason ?? 'resume'); return; }
    }
  }

  const store = {
    db, file, tx, one, all, run, stmt, json, parse, appendEvent,
    get ftsState() { return ftsState; },
    /** Короткий код ошибки пересборки (без путей) либо undefined. */
    get ftsFailure() { return ftsFailure; },
    /** Промис завершения maintainFts (появляется после его первого вызова). */
    get ftsReady() { return ftsPromise; },
    getMeta: key => q.getMeta.get(key)?.value,
    setMeta: (key, value) => { q.setMeta.run(key, String(value)); },

    upsertSources(sources) {
      return tx(() => sources.map(source => { q.upsertSource.run(source.sourceId, source.provider, source.ref, source.canonical, source.kind ?? null, source.label ?? null, source.accountRef ?? null); return source.sourceId; }));
    },
    saveList(listId, rows) {
      return tx(() => {
        if (one('SELECT 1 FROM lists WHERE list_id=?', listId)) return false;
        run('INSERT INTO lists(list_id, created_at, total) VALUES (?,?,?)', listId, clock.now(), rows.length);
        const insert = db.prepare('INSERT INTO list_sources(list_id, ord, source_id, kind, label) VALUES (?,?,?,?,?)');
        rows.forEach((row, index) => insert.run(listId, index, row.sourceId, row.kind ?? null, row.label ?? null));
        return true;
      });
    },
    listSources(listId) {
      return all(`SELECT l.ord, l.source_id AS sourceId, s.provider, s.ref, s.canonical, s.account_ref AS accountRef, COALESCE(l.kind, s.kind) AS kind, COALESCE(l.label, s.label) AS label
        FROM list_sources l JOIN sources s ON s.source_id = l.source_id WHERE l.list_id=? ORDER BY l.ord`, listId);
    },

    /**
     * Чекпоинт одной страницы. raw — результат архива (locators, rotated, tail). Всё или ничего.
     * Дубликаты (уникальный ключ provider+source+item) отбрасываются без ошибки и считаются.
     */
    /** Вставка записей страницы в уже открытой транзакции. Дубликаты (provider+source+item) отбрасываются и считаются. */
    insertItems({ provider, sourceId, jobId, items, raw }) {
      for (const sealed of raw?.rotated ?? []) q.sealSegment.run(sealed.sha256, sealed.bytes, sealed.provider, sealed.seq);
      if (raw?.tail) q.upsertSegment.run(provider, raw.tail.seq, raw.tail.name, raw.tail.bytes);
      let created = 0; let duplicates = 0;
      for (let index = 0; index < items.length; index++) {
        const item = items[index]; const place = raw.locators[index];
        const result = q.insertItem.run(provider, sourceId, item.itemId, jobId, item.ts, item.type, item.publicId, item.authorId, item.authorName, item.text, item.textTruncated ? 1 : 0, item.lang,
          item.views, item.forwards, item.replies, item.reactions, item.likes, item.reposts, json(item.metricsExtra), item.replyTo, item.threadId, item.originalRef,
          item.media.length ? 1 : 0, item.media.length ? json(item.media) : null, item.links.length ? json(item.links) : null, item.gaps.length ? json(item.gaps) : null,
          place.seq, place.offset, place.length, item.contentSha, item.textFp);
        if (result.changes === 1) {
          created++;
          if (item.text) q.insertFts.run(result.lastInsertRowid, foldText(item.text));
        } else duplicates++;
      }
      if (created) q.setMeta.run('items_rev', String(Number(q.getMeta.get('items_rev').value) + 1));
      return { created, duplicates };
    },
    /**
     * Отбор до записи в raw-архив: сохраняется первый снимок itemId внутри одного задания.
     * Возвращает индексы новых записей и число отброшенных; INSERT OR IGNORE остаётся страховкой.
     */
    freshIndexes(provider, sourceId, jobId, items) {
      if (!items.length) return { fresh: [], dropped: 0 };
      const known = new Set(all('SELECT item_id FROM items WHERE provider=? AND source_id=? AND job_id=? AND item_id IN (SELECT value FROM json_each(?))', provider, sourceId, jobId, JSON.stringify(items.map(item => item.itemId))).map(row => row.item_id));
      const fresh = [];
      items.forEach((item, index) => { if (!known.has(item.itemId)) { known.add(item.itemId); fresh.push(index); } });
      return { fresh, dropped: items.length - fresh.length };
    },
    commitPage({ task, sourceId, provider, jobId, items, raw, step, events = [], now, droppedDuplicates = 0 }) {
      return tx(() => {
        const inserted = store.insertItems({ provider, sourceId, jobId, items, raw });
        const created = inserted.created; const duplicates = inserted.duplicates + droppedDuplicates;
        q.taskUpdateAfterPage.run(step.fetched, created, step.cursor ?? null, step.cursorAccount ?? null, step.taskState, step.emptyConfirmed ? 1 : 0, step.partial ? 1 : 0, step.gapReason ?? null, step.limitReached ? 1 : 0, now, step.oldestTs ?? null, step.offsetDate ?? null, task.task_id);
        q.jobAfterPage.run(created, duplicates, now, jobId);
        q.sourceAfterPage.run(created, now, step.sourceState, step.sourceReason ?? null, step.emptyConfirmed ? 1 : 0, step.resumeCursor ?? null, step.resumeAccount ?? null, sourceId);
        const seqs = events.map(event => appendEvent(jobId, event.sourceId ?? sourceId, event.kind, event.data));
        return { created, duplicates, seqs };
      });
    },

    /**
     * Наибольший числовой идентификатор сообщения Telegram среди сохранённых записей источника (public_id вида tg:<пир>:<id>).
     * Нужен режиму refresh. Не извлекается — undefined, и источник читается полным проходом.
     */
    maxMessageId(sourceId) {
      const row = one("SELECT MAX(CAST(substr(public_id, length(rtrim(public_id, '0123456789')) + 1) AS INTEGER)) AS m FROM items WHERE provider='telegram' AND source_id=? AND type='post' AND public_id GLOB 'tg:*:[0-9]*'", sourceId);
      return Number.isSafeInteger(row?.m) && row.m > 0 ? row.m : undefined;
    },
    counts() {
      const c = one('SELECT (SELECT COUNT(*) FROM sources) AS sources, (SELECT COALESCE(MAX(pk),0) FROM items) AS maxPk');
      return { sources: c.sources, itemsMaxPk: c.maxPk };
    },
    /**
     * Сверка счётчиков и (при необходимости) фоновая пересборка FTS порциями; безопасна к повторному вызову.
     * Вызывает оркестратор после запуска планировщика. Ошибка не бросается: состояние 'failed', индекс считается неполным.
     */
    maintainFts() {
      if (isClosed) return Promise.resolve();
      if (!ftsPromise) ftsPromise = runFtsMaintenance().catch(error => { ftsState = 'failed'; ftsError = error; ftsFailure = String(error?.code ?? error?.name ?? 'ERROR').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60) || 'ERROR'; });
      return ftsPromise;
    },
    itemCount: () => one('SELECT COUNT(*) AS n FROM items').n,
    async close() {
      if (isClosed) return;
      isClosed = true;
      await ftsPromise;
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* занята читателем: данные остаются в WAL */ }
      db.close();
      await fs.unlink(lockFile).catch(() => {});
    },
  };
  return store;
}
