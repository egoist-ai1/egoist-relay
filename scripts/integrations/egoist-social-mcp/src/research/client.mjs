import { readFile, writeFile, open, unlink, lstat } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readResearchConfig, researchSourceHash, researchError } from './config.mjs';
import { callResearchDaemon } from './ipc.mjs';
const runFile = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function acquireResearchBootLock(bootLock, { now = Date.now, isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } } } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await open(bootLock, 'wx'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let before;
    try { before = await lstat(bootLock); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 512) throw researchError('DAEMON_BOOT_LOCK_INVALID');
    if (!before.size) {
      // An empty, exclusive boot marker contains no recoverable job/account data.
      // Normal startup completes within seconds; a fresh marker belongs to a peer.
      if (now() - before.mtimeMs <= 60000) return undefined;
    } else {
      let owner;
      try { owner = JSON.parse(await readFile(bootLock, 'utf8')); } catch { throw researchError('DAEMON_BOOT_LOCK_INVALID'); }
      if (owner.schemaVersion !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || Object.keys(owner).some(key => !['schemaVersion', 'pid'].includes(key))) throw researchError('DAEMON_BOOT_LOCK_INVALID');
      if (isAlive(owner.pid)) return undefined;
    }
    const after = await lstat(bootLock);
    if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs) continue;
    await unlink(bootLock);
  }
  throw researchError('DAEMON_BOOT_BUSY');
}

export async function connectResearch({ allowStart = true, allowStale = false } = {}) {
  const config = await readResearchConfig();
  try {
    await runFile(config.powershellPath, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../../scripts/ensure-private-research-state.ps1', import.meta.url)), '-StateRoot', config.stateRoot], { windowsHide: true, timeout: 20000, maxBuffer: 4096 });
  } catch { throw researchError('RESEARCH_STATE_PRIVATE_FAILED'); }
  let token;
  try {
    await writeFile(config.tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const tokenInfo = await lstat(config.tokenPath);
  if (!tokenInfo.isFile() || tokenInfo.isSymbolicLink() || tokenInfo.nlink !== 1 || tokenInfo.size !== 64) throw researchError('DAEMON_TOKEN_INVALID');
  token = await readFile(config.tokenPath, 'utf8');
  if (!/^[0-9a-f]{64}$/.test(token)) throw researchError('DAEMON_TOKEN_INVALID');
  const sourceHash = await researchSourceHash();
  const call = (method, params = {}) => callResearchDaemon({ ...config, token, method, params });
  const checkedStatus = async () => {
    const value = await call('status');
    if (!allowStale && value.daemon.sourceHash !== sourceHash) throw researchError('OWN_DAEMON_RESTART_REQUIRED');
    return value;
  };
  try { await checkedStatus(); return { call, config }; }
  catch (error) { if (error.code !== 'DAEMON_UNAVAILABLE' || !allowStart) throw error; }
  const bootLock = join(config.stateRoot, 'daemon-boot.lock');
  const lock = await acquireResearchBootLock(bootLock);
  if (lock) {
    try {
      await lock.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid }));
      await lock.sync();
      const child = spawn(process.execPath, [fileURLToPath(new URL('daemon.mjs', import.meta.url))], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, EGOIST_RESEARCH_STATE_ROOT: config.stateRoot } });
      child.once('error', () => {});
      child.unref();
      for (let i = 0; i < 50; i++) {
        await wait(100);
        try { await checkedStatus(); return { call, config }; }
        catch (error) { if (error.code !== 'DAEMON_UNAVAILABLE') throw error; }
      }
      throw researchError('DAEMON_START_FAILED');
    } finally { await lock.close(); await unlink(bootLock); }
  }
  for (let i = 0; i < 70; i++) {
    await wait(100);
    try { await checkedStatus(); return { call, config }; }
    catch (error) { if (error.code !== 'DAEMON_UNAVAILABLE') throw error; }
  }
  throw researchError('DAEMON_BOOT_BUSY');
}
