import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, lstat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { acquireResearchBootLock } from './client.mjs';
const work = process.env.EGOIST_RESEARCH_TEST_WORK;
if (!work || !isAbsolute(work)) throw new Error('Owned task work is required.');
async function marker() { const root = await mkdtemp(join(work, 'research-boot-fixture-')); return join(root, 'daemon-boot.lock'); }

test('exclusive boot ownership leaves a fresh peer intact', async () => {
  const file = await marker();
  const owner = await acquireResearchBootLock(file);
  await owner.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid }));
  assert.equal(await acquireResearchBootLock(file), undefined);
  await owner.close();
});

test('crash before PID write recovers only the expired empty owned boot marker', async () => {
  const file = await marker();
  await writeFile(file, '');
  assert.equal(await acquireResearchBootLock(file), undefined);
  const old = new Date(Date.now() - 120000);
  await utimes(file, old, old);
  const owner = await acquireResearchBootLock(file);
  assert.ok(owner);
  await owner.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid }));
  await owner.close();
  assert.ok((await lstat(file)).size > 0);
});

test('dead recorded owner is reclaimed; malformed state is retained and denied', async () => {
  const file = await marker();
  await writeFile(file, JSON.stringify({ schemaVersion: 1, pid: 123456 }));
  const owner = await acquireResearchBootLock(file, { isAlive: () => false });
  assert.ok(owner); await owner.close();
  const malformed = await marker();
  await writeFile(malformed, '{"unexpected":"fixture"}');
  await assert.rejects(acquireResearchBootLock(malformed), { code: 'DAEMON_BOOT_LOCK_INVALID' });
  assert.ok((await lstat(malformed)).size > 0);
});
