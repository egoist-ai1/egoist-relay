import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const project = path.resolve(import.meta.dirname, '..');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const manifestPath = path.join(project, 'tauri/installer-legacy-runtime.json');
// Public MIT notice from the previous runtime, pinned by the production migration manifest.
const oldNotice = Buffer.from('TUlUIExpY2Vuc2UKCkNvcHlyaWdodCAoYykgMjAyNCBodWZyZWEKClBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHkKb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGUgIlNvZnR3YXJlIiksIHRvIGRlYWwKaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cwp0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsCmNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcwpmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOgoKVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW4gYWxsCmNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuCgpUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgIkFTIElTIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUgpJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSwKRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU4gTk8gRVZFTlQgU0hBTEwgVEhFCkFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVIKTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwKT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUKU09GVFdBUkUuCg==', 'base64');

function migrate(installation, manifest = manifestPath) {
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(project, 'tauri/installer-processes.ps1'), '-InstallDirectory', installation,
    '-RemoveLegacyNetworkRuntime', '-LegacyRuntimeManifestPath', manifest], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
}

async function fixture() {
  const work = process.env.EGOIST_RELAY_AUDIT_WORK;
  assert.ok(work, 'Set EGOIST_RELAY_AUDIT_WORK to this task or CI temporary work directory');
  const root = await mkdtemp(path.join(work, 'release-installer-'));
  await mkdir(path.join(root, 'runtime/licenses'), { recursive: true });
  return root;
}

test('upgrade removes only exact old notice bytes and preserves modified engines, unknown files and profiles',
  { skip: process.platform !== 'win32' }, async () => {
    const root = await fixture();
    try {
      const notice = path.join(root, 'runtime/licenses/BYEDPI-LICENSE.txt');
      await writeFile(notice, oldNotice);
      await writeFile(path.join(root, 'runtime/xray.exe'), 'modified synthetic legacy engine');
      await writeFile(path.join(root, 'runtime/user-model.bin'), 'unknown local data');
      await writeFile(path.join(root, 'account-profile.json'), 'synthetic account profile');
      const result = migrate(root);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /removed=1 preserved_modified=1/);
      await assert.rejects(readFile(notice), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(root, 'runtime/xray.exe'), 'utf8'), 'modified synthetic legacy engine');
      assert.equal(await readFile(path.join(root, 'runtime/user-model.bin'), 'utf8'), 'unknown local data');
      assert.equal(await readFile(path.join(root, 'account-profile.json'), 'utf8'), 'synthetic account profile');
      assert.equal(migrate(root).status, 0, 'Cleanup must be repeatable when exact legacy files are already absent');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('migration validates all manifest entries before deleting any exact legacy file',
  { skip: process.platform !== 'win32' }, async () => {
    const root = await fixture();
    try {
      const notice = path.join(root, 'runtime/licenses/BYEDPI-LICENSE.txt');
      await writeFile(notice, oldNotice);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.files = [manifest.files.find((file) => file.path === 'runtime/licenses/BYEDPI-LICENSE.txt'),
        { path: 'runtime/licenses/xray-dependencies/../../../../account.json', bytes: 1, sha256: 'a'.repeat(64) }];
      const malformed = path.join(root, 'malformed-migration.json');
      await writeFile(malformed, JSON.stringify(manifest));
      const result = migrate(root, malformed);
      assert.equal(result.status, 1); assert.match(result.stderr, /Invalid legacy runtime entry/);
      assert.deepEqual(await readFile(notice), oldNotice);
      for (const invalidDirectory of ['relative-installation', path.parse(root).root]) {
        assert.equal(migrate(invalidDirectory).status, 1);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('migration rejects a runtime junction before touching its external target',
  { skip: process.platform !== 'win32' }, async () => {
    const root = await fixture();
    const external = await fixture();
    try {
      await writeFile(path.join(external, 'runtime/licenses/BYEDPI-LICENSE.txt'), oldNotice);
      await rm(path.join(root, 'runtime'), { recursive: true });
      await symlink(path.join(external, 'runtime'), path.join(root, 'runtime'), 'junction');
      const result = migrate(root);
      assert.equal(result.status, 1); assert.match(result.stderr, /Reparse points/);
      assert.deepEqual(await readFile(path.join(external, 'runtime/licenses/BYEDPI-LICENSE.txt')), oldNotice);
    } finally {
      await unlink(path.join(root, 'runtime'));
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });
