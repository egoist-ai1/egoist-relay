import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ensureRelayBridgeStarted, verifyRelayInstall } from './bridge-start.mjs';
import { assertSafeDirectory } from './job-store.mjs';
const work = process.env.EGOIST_RESEARCH_TEST_WORK;
if (!work || !isAbsolute(work)) throw new Error('Owned task work is required');
async function fixture() {
  const directory = join(work, 'social-start-fixture-' + randomUUID()); await assertSafeDirectory(directory, { create: true });
  const config = { stateRoot: directory, relayInstallProofPath: join(directory, 'install.json'), relayExecutablePath: join(directory, 'Egoist Relay.exe') };
  const bytes = Buffer.alloc(2048, 17); await fs.writeFile(config.relayExecutablePath, bytes);
  const proof = { schemaVersion: 1, protocolVersion: 1, appVersion: '1.4.0', startArgument: '--research-headless', executablePath: config.relayExecutablePath, exeSha256: createHash('sha256').update(bytes).digest('hex') };
  await fs.writeFile(config.relayInstallProofPath, JSON.stringify(proof));
  return { config, proof };
}
test('headless activation refuses an unmarked or changed binary before any process launch', async () => {
  const f = await fixture(); let launches = 0;
  const launch = () => { launches++; throw new Error('Must not launch'); };
  await fs.unlink(f.config.relayInstallProofPath);
  await assert.rejects(ensureRelayBridgeStarted(f.config, { launch }), { code: 'APP_BRIDGE_UNAVAILABLE' });
  await fs.writeFile(f.config.relayInstallProofPath, JSON.stringify(f.proof)); await fs.appendFile(f.config.relayExecutablePath, 'changed');
  await assert.rejects(ensureRelayBridgeStarted(f.config, { launch }), { code: 'BRIDGE_INSTALL_UNCONFIRMED' });
  assert.equal(launches, 0);
});
test('a live ordinary owner is preserved and receives no headless launch request', async () => {
  const f = await fixture(); let launches = 0;
  await assert.rejects(ensureRelayBridgeStarted(f.config, { probe: async () => ({ count: 1, owners: [{ pid: 1234, startedAt: 1000 }] }), launch: () => { launches++; } }), { code: 'APP_BRIDGE_UNAVAILABLE' });
  assert.equal(launches, 0);
});
test('exclusive launch uses only the fixed headless flag and strips old debug/profile controls', async () => {
  const f = await fixture(); let launchArgs; let probed = 0; let waited = 0;
  const child = new EventEmitter(); child.unref = () => {};
  const previous = process.env.EGOIST_RELAY_SMOKE_TEST; process.env.EGOIST_RELAY_SMOKE_TEST = '1';
  try {
    await ensureRelayBridgeStarted(f.config, { probe: async () => { probed++; return { count: 0, owners: [] }; }, launch: (...args) => { launchArgs = args; return child; }, waitForBridge: async () => { waited++; } });
  } finally { if (previous === undefined) delete process.env.EGOIST_RELAY_SMOKE_TEST; else process.env.EGOIST_RELAY_SMOKE_TEST = previous; }
  assert.equal(probed, 2); assert.equal(waited, 1); assert.deepEqual(launchArgs[1], ['--research-headless']);
  assert.equal(launchArgs[2].windowsHide, true); assert.equal(launchArgs[2].stdio, 'ignore'); assert.equal(launchArgs[2].env.EGOIST_RELAY_SMOKE_TEST, undefined);
  await assert.rejects(fs.lstat(join(f.config.stateRoot, 'relay-start.lock')), { code: 'ENOENT' });
});
test('peer boot ownership waits and does not launch a second process', async () => {
  const f = await fixture(); let waited = 0;
  await ensureRelayBridgeStarted(f.config, { probe: async () => ({ count: 0, owners: [] }), acquireLock: async () => undefined, launch: () => { throw new Error('Must not launch'); }, waitForBridge: async () => { waited++; } });
  assert.equal(waited, 1);
});
test('old version install proof is not a bridge capability even with a matching file hash', async () => {
  const f = await fixture(); await fs.writeFile(f.config.relayInstallProofPath, JSON.stringify({ ...f.proof, appVersion: '1.3.3' }));
  await assert.rejects(verifyRelayInstall(f.config), { code: 'BRIDGE_INSTALL_UNCONFIRMED' });
});
test('only an explicitly proved recovery-capable owner receives the two fixed control flags', async () => {
  const f = await fixture();
  await fs.writeFile(f.config.relayInstallProofPath, JSON.stringify({ ...f.proof, appVersion: '1.4.1', recoveryArgument: '--research-recover-existing' }));
  const owner = { pid: 1234, startedAt: 1000 }; let invocation; let expected;
  const child = new EventEmitter(); child.unref = () => {};
  await ensureRelayBridgeStarted(f.config, { probe: async () => ({ count: 1, owners: [owner] }), launch: (...args) => { invocation = args; return child; }, waitForBridge: async value => { expected = value.expectedOwner; } });
  assert.deepEqual(invocation[1], ['--research-headless', '--research-recover-existing']);
  assert.equal(invocation[2].windowsHide, true); assert.equal(invocation[2].stdio, 'ignore');
  assert.deepEqual(expected, owner);
});
test('version alone without the fixed recovery capability does not contact a live owner', async () => {
  const f = await fixture();
  await fs.writeFile(f.config.relayInstallProofPath, JSON.stringify({ ...f.proof, appVersion: '1.4.1' }));
  await assert.rejects(ensureRelayBridgeStarted(f.config, { probe: async () => ({ count: 1, owners: [{ pid: 1234, startedAt: 1000 }] }), launch: () => { throw new Error('Must not launch'); } }), { code: 'APP_BRIDGE_UNAVAILABLE' });
});
test('owner exit or PID reuse during recovery does not fall back to a new app launch', async () => {
  for (const replacement of [{ count: 0, owners: [] }, { count: 1, owners: [{ pid: 1234, startedAt: 2000 }] }]) {
    const f = await fixture();
    await fs.writeFile(f.config.relayInstallProofPath, JSON.stringify({ ...f.proof, appVersion: '1.4.1', recoveryArgument: '--research-recover-existing' }));
    let probes = 0; let launches = 0;
    await assert.rejects(ensureRelayBridgeStarted(f.config, { probe: async () => probes++ ? replacement : { count: 1, owners: [{ pid: 1234, startedAt: 1000 }] }, launch: () => { launches++; } }), { code: 'BRIDGE_RUNTIME_CHANGED' });
    assert.equal(launches, 0);
  }
});
test('ambiguous or malformed process ownership fails before any control process', async () => {
  for (const snapshot of [{ count: 2, owners: [{ pid: 1234, startedAt: 1000 }, { pid: 5678, startedAt: 1000 }] }, { count: 1, owners: [{ pid: 0, startedAt: 1000 }] }]) {
    const f = await fixture(); let launches = 0;
    await assert.rejects(ensureRelayBridgeStarted(f.config, { probe: async () => snapshot, launch: () => { launches++; } }), { code: 'BRIDGE_IDENTITY_UNCONFIRMED' });
    assert.equal(launches, 0);
  }
});
