import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { assertPlainAncestors, researchError } from './config.mjs';
import { acquireResearchBootLock } from './client.mjs';
const runFile = promisify(execFile);
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const same = (a, b) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs;

export async function verifyRelayInstall(config) {
  if (!config.relayInstallProofPath) throw researchError('APP_BRIDGE_UNAVAILABLE');
  await assertPlainAncestors(config.relayInstallProofPath);
  let proofInfo;
  try { proofInfo = await fs.lstat(config.relayInstallProofPath); }
  catch (error) { if (error.code === 'ENOENT') throw researchError('APP_BRIDGE_UNAVAILABLE'); throw error; }
  if (!proofInfo.isFile() || proofInfo.nlink !== 1 || proofInfo.size > 16384) throw researchError('BRIDGE_INSTALL_UNCONFIRMED');
  let proof;
  try { proof = JSON.parse(await fs.readFile(config.relayInstallProofPath, 'utf8')); } catch { throw researchError('BRIDGE_INSTALL_UNCONFIRMED'); }
  if (proof.schemaVersion !== 1 || proof.protocolVersion !== 1 || proof.startArgument !== '--research-headless' ||
      typeof proof.executablePath !== 'string' || resolve(proof.executablePath).toLowerCase() !== resolve(config.relayExecutablePath).toLowerCase() ||
      !/^[a-f0-9]{64}$/.test(proof.exeSha256 ?? '') || !/^\d+\.\d+\.\d+$/.test(proof.appVersion ?? '') ||
      Number(proof.appVersion.split('.')[0]) < 1 || Number(proof.appVersion.split('.')[0]) === 1 && Number(proof.appVersion.split('.')[1]) < 4) throw researchError('BRIDGE_INSTALL_UNCONFIRMED');
  await assertPlainAncestors(config.relayExecutablePath);
  const before = await fs.lstat(config.relayExecutablePath);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1024 || before.size > 512 * 1024 ** 2) throw researchError('BRIDGE_INSTALL_UNCONFIRMED');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(config.relayExecutablePath)) hash.update(chunk);
  if (hash.digest('hex') !== proof.exeSha256 || !same(before, await fs.lstat(config.relayExecutablePath)) || !same(proofInfo, await fs.lstat(config.relayInstallProofPath))) throw researchError('BRIDGE_INSTALL_UNCONFIRMED');
  const [major, minor, patch] = proof.appVersion.split('.').map(Number);
  return { identity: before, recoverySupported: proof.recoveryArgument === '--research-recover-existing' &&
    (major > 1 || major === 1 && (minor > 4 || minor === 4 && patch >= 1)) };
}
async function probeOwner(config) {
  try {
    const result = await runFile(config.powershellPath, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../../scripts/probe-relay-owner.ps1', import.meta.url)), '-Executable', config.relayExecutablePath], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    const value = JSON.parse(result.stdout.trim());
    return checkedOwners(value);
  } catch { throw researchError('BRIDGE_IDENTITY_UNCONFIRMED'); }
}
function checkedOwners(value) {
  if (!value || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 1 || !Array.isArray(value.owners) || value.count !== value.owners.length ||
      value.owners.some(owner => !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !Number.isSafeInteger(owner.startedAt) || owner.startedAt <= 0)) throw researchError('BRIDGE_IDENTITY_UNCONFIRMED');
  return value;
}
const sameOwner = (left, right) => left?.pid === right?.pid && left?.startedAt === right?.startedAt;

export async function ensureRelayBridgeStarted(config, { verifyInstall = verifyRelayInstall, probe = probeOwner,
  launch = (exe, args, options) => spawn(exe, args, options), acquireLock = acquireResearchBootLock,
  waitForBridge = async ({ expectedOwner } = {}) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        if ((await fs.lstat(config.bridgeMetadataPath)).isFile()) {
          const result = await runFile(config.powershellPath, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../../scripts/verify-relay-bridge.ps1', import.meta.url)), '-MetadataPath', config.bridgeMetadataPath, '-ExpectedExecutable', config.relayExecutablePath], { windowsHide: true, timeout: Math.min(5000, Math.max(1, deadline - Date.now())), maxBuffer: 4096 });
          const verified = JSON.parse(result.stdout.trim());
          if (verified.ok) {
            if (expectedOwner && (verified.appPid !== expectedOwner.pid || Math.abs(verified.appStartedAt - expectedOwner.startedAt) > 2)) throw researchError('BRIDGE_RUNTIME_CHANGED');
            return;
          }
        }
      } catch (error) { if (!['ENOENT', 'APP_BRIDGE_UNAVAILABLE'].includes(error.code) && !error.killed && !Number.isInteger(error.code)) throw error; }
      await wait(200);
    }
    throw researchError('APP_BRIDGE_UNAVAILABLE');
  } } = {}) {
  // A marker exists only after a reviewed bridge binary was installed. Old
  // ordinary Relay binaries are never launched with an unrecognized flag.
  const installed = await verifyInstall(config);
  const initialOwner = checkedOwners(await probe(config)).owners[0];
  if (initialOwner && !installed.recoverySupported) throw researchError('APP_BRIDGE_UNAVAILABLE');
  const lockPath = join(config.stateRoot, 'relay-start.lock');
  const lock = await acquireLock(lockPath);
  if (!lock) { await waitForBridge({ expectedOwner: initialOwner }); return; }
  try {
    await lock.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid })); await lock.sync();
    const currentOwner = checkedOwners(await probe(config)).owners[0];
    if (initialOwner && !sameOwner(initialOwner, currentOwner)) throw researchError('BRIDGE_RUNTIME_CHANGED');
    if (currentOwner && !installed.recoverySupported) { await waitForBridge({ expectedOwner: currentOwner }); return; }
    if (installed.identity && !same(installed.identity, await fs.lstat(config.relayExecutablePath))) throw researchError('BRIDGE_INSTALL_UNCONFIRMED');
    const env = { ...process.env };
    for (const key of ['EGOIST_RELAY_CONTROL_MODE', 'EGOIST_RELAY_SMOKE_TEST', 'EGOIST_RELAY_TEST_PROFILE', 'EGOIST_RELAY_RESEARCH_TEST', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', 'WEBVIEW2_USER_DATA_FOLDER']) delete env[key];
    // The fixed recovery-only flag makes a failed single-instance handoff exit
    // before native account initialization instead of becoming another owner.
    const args = currentOwner ? ['--research-headless', '--research-recover-existing'] : ['--research-headless'];
    const child = launch(config.relayExecutablePath, args, { detached: true, windowsHide: true, stdio: 'ignore', env });
    let launchError;
    child.once('error', () => { launchError = researchError('APP_BRIDGE_UNAVAILABLE'); }); child.unref();
    await waitForBridge({ expectedOwner: currentOwner }); if (launchError) throw launchError;
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
