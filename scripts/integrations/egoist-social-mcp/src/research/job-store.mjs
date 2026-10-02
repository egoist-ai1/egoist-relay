import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_METADATA_BYTES = 128 * 1024;
const SAFE_FILE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const RESERVED_FILE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export class ResearchBrokerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResearchBrokerError';
    this.code = code;
  }
}

export function isJobId(value) { return typeof value === 'string' && UUID.test(value); }
export function cloneJSON(value) { return JSON.parse(JSON.stringify(value)); }

function unsafe() { return new ResearchBrokerError('UNSAFE_PATH', 'A research storage path is not a private regular filesystem entry.'); }
function statSame(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function segments(absolute) {
  const root = path.parse(absolute).root;
  return [root, ...absolute.slice(root.length).split(path.sep).filter(Boolean)];
}

/** Validate every ancestor, including Windows junctions exposed by Node as links. */
export async function assertSafeDirectory(directory, { create = false } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw unsafe();
  const absolute = path.resolve(directory);
  let current = '';
  for (const segment of segments(absolute)) {
    current = current ? path.join(current, segment) : segment;
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw unsafe();
      try { await fs.mkdir(current); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw unsafe(); }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe();
  }
  const canonical = await fs.realpath(absolute);
  const equal = process.platform === 'win32' ? canonical.toLowerCase() === absolute.toLowerCase() : canonical === absolute;
  if (!equal) throw unsafe();
  return { path: absolute, stat: await fs.lstat(absolute) };
}

export async function assertSafeFile(file, { optional = false } = {}) {
  await assertSafeDirectory(path.dirname(file));
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw unsafe(); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unsafe();
  return stat;
}

async function readSmallJSON(file, maximum = MAX_METADATA_BYTES) {
  const before = await assertSafeFile(file);
  if (before.size > maximum) throw new ResearchBrokerError('INVALID_STATE', 'Research metadata is invalid.');
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!statSame(before, opened) || !opened.isFile() || opened.nlink !== 1 || opened.size > maximum) throw unsafe();
    const bytes = await handle.readFile();
    if (bytes.length > maximum) throw new ResearchBrokerError('INVALID_STATE', 'Research metadata is invalid.');
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw new ResearchBrokerError('INVALID_STATE', 'Research metadata is invalid.'); }
  } finally { await handle.close(); }
}

async function unlinkOwned(file, expected) {
  const current = await assertSafeFile(file, { optional: true });
  if (!current) return;
  if (!statSame(expected, current)) throw unsafe();
  await fs.unlink(file);
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export function safeOutputName(name) {
  return typeof name === 'string' && SAFE_FILE.test(name) && !name.endsWith('.') && !RESERVED_FILE.test(name) && path.basename(name) === name;
}

/** Only flat reported files are accepted. Payload bytes are never read here. */
export async function inspectOutputFiles(directory, names, expectedDirectory) {
  const checked = await assertSafeDirectory(directory);
  if (expectedDirectory && !statSame(expectedDirectory, checked.stat)) throw unsafe();
  const unique = [...new Set(names)];
  if (unique.length > 1000 || unique.some(name => !safeOutputName(name))) throw unsafe();
  for (const name of unique) await assertSafeFile(path.join(directory, name));
  return unique;
}

export class JobStore {
  constructor({ stateRoot, outputRoot, validateJob }) {
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) throw unsafe();
    this.stateRoot = path.resolve(stateRoot);
    this.outputRoot = path.resolve(outputRoot);
    if (within(this.stateRoot, this.outputRoot) || within(this.outputRoot, this.stateRoot)) throw unsafe();
    this.jobsRoot = path.join(this.stateRoot, 'jobs');
    this.lockPath = path.join(this.stateRoot, 'broker.lock');
    this.validateJob = validateJob;
    this.pending = new Map();
    this.lock = null;
    this.closed = false;
  }

  async open() {
    this.stateStat = (await assertSafeDirectory(this.stateRoot, { create: true })).stat;
    this.outputStat = (await assertSafeDirectory(this.outputRoot, { create: true })).stat;
    this.jobsStat = (await assertSafeDirectory(this.jobsRoot, { create: true })).stat;
    await this.acquireLock();
    try {
      const entries = await fs.readdir(this.jobsRoot, { withFileTypes: true });
      const jobs = [];
      for (const entry of entries) {
        if (!entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -5);
        if (!isJobId(id)) throw new ResearchBrokerError('INVALID_STATE', 'Research metadata contains an invalid job identifier.');
        const value = await readSmallJSON(path.join(this.jobsRoot, entry.name));
        this.validateJob(value, id);
        jobs.push(value);
      }
      if (jobs.length > 10000) throw new ResearchBrokerError('STATE_LIMIT', 'Research job history reached its bounded limit.');
      return jobs;
    } catch (error) { await this.close(); throw error; }
  }

  async acquireLock() {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.assertRoots();
      let handle;
      try { handle = await fs.open(this.lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw unsafe();
        const stat = await assertSafeFile(this.lockPath);
        if (stat.size === 0) {
          if (Date.now() - stat.mtimeMs <= 60000) throw new ResearchBrokerError('STATE_BUSY', 'A fresh broker boot owns this state directory.');
          const current = await assertSafeFile(this.lockPath);
          if (!statSame(stat, current) || current.size !== 0 || current.mtimeMs !== stat.mtimeMs) continue;
          await unlinkOwned(this.lockPath, stat);
          continue;
        }
        const owner = await readSmallJSON(this.lockPath, 1024);
        if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !isJobId(owner.nonce)) throw new ResearchBrokerError('STATE_BUSY', 'Research storage has an unrecognized owner.');
        let live = true;
        try { process.kill(owner.pid, 0); } catch (probeError) { if (probeError.code === 'ESRCH') live = false; }
        if (live) throw new ResearchBrokerError('STATE_BUSY', 'Another research broker owns this state directory.');
        await unlinkOwned(this.lockPath, stat);
        continue;
      }
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
        await handle.sync();
        this.lock = await handle.stat();
      } finally { await handle.close(); }
      return;
    }
    throw new ResearchBrokerError('STATE_BUSY', 'Research storage could not be claimed.');
  }

  async assertRoots() {
    for (const [directory, expected] of [[this.stateRoot, this.stateStat], [this.jobsRoot, this.jobsStat], [this.outputRoot, this.outputStat]]) {
      const current = await assertSafeDirectory(directory);
      if (expected && !statSame(expected, current.stat)) throw unsafe();
    }
  }

  async createOutput(id) {
    if (!isJobId(id)) throw unsafe();
    await this.assertRoots();
    const directory = path.join(this.outputRoot, id);
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch { throw new ResearchBrokerError('OUTPUT_EXISTS', 'A generated job output directory already exists or cannot be created.'); }
    const checked = await assertSafeDirectory(directory);
    return { directory, identity: checked.stat };
  }

  outputPath(id) { if (!isJobId(id)) throw unsafe(); return path.join(this.outputRoot, id); }

  async save(job) {
    if (this.closed) throw new ResearchBrokerError('BROKER_CLOSED', 'The research broker is closed.');
    this.validateJob(job, job.id);
    const snapshot = cloneJSON(job);
    const preceding = this.pending.get(job.id) ?? Promise.resolve();
    const current = preceding.catch(() => {}).then(() => this.atomicWrite(snapshot));
    this.pending.set(job.id, current);
    try { await current; } finally { if (this.pending.get(job.id) === current) this.pending.delete(job.id); }
  }

  async atomicWrite(job) {
    await this.assertRoots();
    const target = path.join(this.jobsRoot, job.id + '.json');
    await assertSafeFile(target, { optional: true });
    const temporary = path.join(this.jobsRoot, '.' + randomUUID() + '.tmp');
    const bytes = Buffer.from(JSON.stringify(job) + '\n');
    if (bytes.length > MAX_METADATA_BYTES) throw new ResearchBrokerError('STATE_LIMIT', 'A research job exceeds the metadata limit.');
    const handle = await fs.open(temporary, 'wx', 0o600);
    let identity;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      identity = await handle.stat();
    } finally { await handle.close(); }
    try {
      await this.assertRoots();
      await assertSafeFile(target, { optional: true });
      await fs.rename(temporary, target);
      await assertSafeFile(target);
      // Directory fsync is not supported uniformly on Windows; the file itself is synced.
    } finally { if (identity) await unlinkOwned(temporary, identity); }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
    if (this.lock) { await unlinkOwned(this.lockPath, this.lock); this.lock = null; }
  }
}
