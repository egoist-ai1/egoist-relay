import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { assertNoSecrets, assertSafeRelative, isSafeSourcePath, PRODUCT, publicRuntimeResources, validateConfiguration,
  validateGenericPackaging, validateRuntime, validateInstallerPathBudget, validateSourceImports } from './release-policy.mjs';
import { readBoundedBody, validateArchiveEntry } from './release-runtime-archive.mjs';

function fixture() {
  const runtimeManifest = { schemaVersion: 1, files: [{ path: 'runtime/helper.bin' }] };
  return { pkg: { version: '1.3.1' }, packageLock: { version: '1.3.1', packages: { '': { version: '1.3.1' } } },
    cargo: '[package]\nversion = "1.3.1"', cargoLock: '[[package]]\nname = "tauri"\nversion = "2.12.0"\n\n[[package]]\nname = "tao"\nversion = "0.37.1"\n', runtimeManifest,
    config: { identifier: PRODUCT.identifier, productName: PRODUCT.name, mainBinaryName: PRODUCT.name,
      build: { frontendDist: '../dist' }, bundle: { createUpdaterArtifacts: false, resources: publicRuntimeResources(runtimeManifest),
        windows: { allowDowngrades: false, minimumWebview2Version: PRODUCT.minWebview,
          nsis: { installerHooks: 'installer.nsh' } } } } };
}

test('production identity and embedded UI pass while legacy or remote overrides fail', () => {
  assert.equal(validateConfiguration(fixture()).updater, false);
  for (const patch of [{ identifier: 'org.telegram.TelegramAir' }, { productName: 'Telegram Air' },
    { mainBinaryName: 'Telegram Air' }, { build: { frontendDist: 'https://example.invalid' } }]) {
    const input = fixture(); Object.assign(input.config, patch);
    assert.throws(() => validateConfiguration(input));
  }
});

test('unpatched Tauri, drifted version, updater, downgrade and WebView policies reject', () => {
  const cases = [
    (x) => { x.cargoLock = x.cargoLock.replace('2.12.0', '2.11.6'); },
    (x) => { x.cargoLock = x.cargoLock.replace('0.37.1', '0.35.3'); },
    (x) => { x.cargoLock = x.cargoLock.replace('name = "tao"', 'name = "absent"'); },
    (x) => { x.packageLock.version = '1.2.6'; },
    (x) => { x.config.bundle.createUpdaterArtifacts = true; },
    (x) => { x.config.plugins = { updater: {} }; },
    (x) => { x.config.bundle.windows.allowDowngrades = true; },
    (x) => { delete x.config.bundle.windows.minimumWebview2Version; },
    (x) => { x.config.bundle.resources['../owner-profile/'] = 'profile/'; },
    (x) => { x.config.bundle.resources = { '../runtime/': 'runtime/' }; },
    (x) => { x.config.bundle.externalBin = ['runtime/xray']; },
    (x) => { x.config.bundle.windows.nsis.template = 'personal-installer.nsi'; },
    (x) => { x.env = { TEST_SESSION: 'synthetic-session' }; },
  ];
  for (const patch of cases) { const input = fixture(); patch(input); assert.throws(() => validateConfiguration(input)); }
});

test('generic configuration rejects provisioning environment, import commands and retired runtime resources', () => {
  for (const name of ['EGOIST_RELAY_PRIVATE_DNS_ENROLLMENT_FILE', 'EGOIST_RELAY_PRIVATE_TUNNEL_ENROLLMENT_FILE',
    'EGOIST_RELAY_DOH_URL', 'EGOIST_RELAY_DNS_PROVIDER']) {
    const input = fixture(); input.env = { [name]: 'synthetic-value-never-reported' };
    assert.throws(() => validateConfiguration(input), (error) => /private network provisioning/.test(error.message)
      && !error.message.includes('synthetic-value'));
  }
  for (const scripts of [{ 'build:proxy': 'node stale-helper.mjs' }, { 'import:dns': 'node helper.mjs' },
    { desktop: 'npm run build:proxy' }, { 'build:personal': 'powershell helper.ps1' }]) {
    const input = fixture(); input.pkg.scripts = scripts;
    assert.throws(() => validateConfiguration(input), /internal network engines/);
  }
  for (const name of ['xray.exe', 'ciadpi.exe', 'egoist-tg-proxy.exe', 'licenses/XRAY-LICENSE.txt',
    'licenses/xray-dependencies/public/LICENSE']) {
    assert.throws(() => publicRuntimeResources({ schemaVersion: 1, files: [{ path: `runtime/${name}` }] }), /public runtime/);
  }
});

test('generic installer rejects enrollment hooks and obsolete import helpers', async () => {
  const work = process.env.EGOIST_RELAY_AUDIT_WORK;
  assert.ok(work, 'Set EGOIST_RELAY_AUDIT_WORK to this task or CI temporary work directory');
  const root = await mkdtemp(path.join(work, 'release-generic-'));
  try {
    assert.equal((await validateGenericPackaging(root, '!macro NSIS_HOOK_POSTINSTALL\n!macroend')).privateProvisioning, false);
    await assert.rejects(validateGenericPackaging(root, '!ifdef EGOIST_RELAY_PRIVATE_DNS_ENROLLMENT_FILE'), /provisioning hooks/);
    await mkdir(path.join(root, 'scripts'));
    await writeFile(path.join(root, 'scripts/import-lagom-tunnel.ps1'), 'synthetic obsolete helper');
    await assert.rejects(validateGenericPackaging(root, ''), /Obsolete network provisioning/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('secret patterns block source contents without reporting the secret value', () => {
  for (const secret of [['-----BEGIN', 'PRIVATE KEY-----'].join(' '), `ghp_${'a'.repeat(36)}`,
    `api_key = "${'a'.repeat(24)}"`, `https://${'user:synthetic-password'}@real-host.net`,
    `https://${'dns.controld.com'}/synthetickey`]) {
    assert.throws(() => assertNoSecrets('src/example.ts', secret), (error) => error.message === 'Potential secret in source: src/example.ts');
  }
  assert.doesNotThrow(() => assertNoSecrets('src/example.ts', 'const apiKey = process.env.API_KEY;'));
});

test('source privacy paths reject traversal, account stores and private profiles', () => {
  for (const file of ['../owner.env', '/owner/session', 'src/../owner', 'src\\file.ts']) {
    assert.throws(() => assertSafeRelative(file));
  }
  for (const file of ['src/.env', 'src/account-private.json', 'src/cookies.txt', 'src/owner.dpapi',
    'src/accounts/store.json', 'src/__pycache__/worker.pyc', 'src/session.json']) assert.equal(isSafeSourcePath(file), false);
  assert.equal(isSafeSourcePath('src/components/Main.tsx'), true);
  for (const file of ['src/util/sessions.ts', 'src/global/actions/authentication/sessions.ts',
    'src/accounts/credentials.ts', 'src/sessions/index.ts']) assert.equal(isSafeSourcePath(file), true);
  assert.equal(isSafeSourcePath('dev/session.json'), false);
});

test('runtime rejects unexpected private data and modified helpers', async () => {
  const work = process.env.EGOIST_RELAY_AUDIT_WORK;
  assert.ok(work, 'Set EGOIST_RELAY_AUDIT_WORK to this task or CI temporary work directory');
  const root = await mkdtemp(path.join(work, 'release-policy-'));
  try {
    await mkdir(path.join(root, 'runtime'));
    await writeFile(path.join(root, 'runtime', 'helper.bin'), 'public helper');
    const manifest = { schemaVersion: 1, files: [{ path: 'runtime/helper.bin', bytes: 13,
      sha256: createHash('sha256').update('public helper').digest('hex') }] };
    assert.equal((await validateRuntime(root, manifest)).count, 1);
    await mkdir(path.join(root, 'tauri'));
    const retiredBytes = 'old public engine';
    await writeFile(path.join(root, 'runtime', 'xray.exe'), retiredBytes);
    await writeFile(path.join(root, 'tauri', 'installer-legacy-runtime.json'), JSON.stringify({ schemaVersion: 1, files: [
      { path: 'runtime/xray.exe', bytes: retiredBytes.length, sha256: createHash('sha256').update(retiredBytes).digest('hex') }] }));
    const withRetired = await validateRuntime(root, manifest);
    assert.equal(withRetired.count, 1); assert.equal(withRetired.retiredSourceFiles, 1); assert.equal(withRetired.retiredFilesBundled, false);
    const widenedWithEngine = { schemaVersion: 1, files: [...manifest.files,
      { path: 'runtime/xray.exe', bytes: retiredBytes.length, sha256: createHash('sha256').update(retiredBytes).digest('hex') }] };
    await assert.rejects(validateRuntime(root, widenedWithEngine), /Internal network runtime forbidden/);
    await writeFile(path.join(root, 'runtime', 'xray.exe'), 'modified retired');
    await assert.rejects(validateRuntime(root, manifest), /integrity mismatch/);
    await rm(path.join(root, 'runtime', 'xray.exe'));
    await writeFile(path.join(root, 'runtime', 'private-enrollment.json'), '{"synthetic":true}');
    await assert.rejects(validateRuntime(root, manifest), /unexpected files/);
    const widenedManifest = { schemaVersion: 1, files: [...manifest.files, { path: 'runtime/private-enrollment.json', bytes: 18,
      sha256: createHash('sha256').update('{"synthetic":true}').digest('hex') }] };
    await assert.rejects(validateRuntime(root, widenedManifest), /Private runtime entry forbidden/);
    await rm(path.join(root, 'runtime', 'private-enrollment.json'));
    await writeFile(path.join(root, 'runtime', 'helper.bin'), 'changed bytes');
    await assert.rejects(validateRuntime(root, manifest), /integrity mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deployment override cannot replace product or use BASE_URL and rejects updater enablement', async () => {
  const { default: prepare } = await import(pathToFileURL(path.resolve('deploy/prepareTauriConfig.js')).href);
  const previousBase = process.env.BASE_URL; const previousUpdater = process.env.WITH_UPDATER;
  try {
    process.env.BASE_URL = 'https://synthetic.invalid'; delete process.env.WITH_UPDATER;
    assert.equal(prepare().identifier, PRODUCT.identifier); assert.equal(prepare().build.frontendDist, '../dist');
    process.env.WITH_UPDATER = 'true'; assert.throws(prepare, /updater is disabled/);
  } finally {
    if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase;
    if (previousUpdater === undefined) delete process.env.WITH_UPDATER; else process.env.WITH_UPDATER = previousUpdater;
  }
});

test('source archive completeness rejects excluded imported session module', async () => {
  const work = process.env.EGOIST_RELAY_AUDIT_WORK;
  assert.ok(work, 'Set EGOIST_RELAY_AUDIT_WORK to this task or CI temporary work directory');
  const root = await mkdtemp(path.join(work, 'release-imports-'));
  try {
    await mkdir(path.join(root, 'src', 'util'), { recursive: true });
    await writeFile(path.join(root, 'src', 'main.ts'), 'import { sessions } from "./util/sessions"; export { sessions };');
    await writeFile(path.join(root, 'src', 'util', 'sessions.ts'), 'export const sessions = [];');
    const files = ['src/main.ts', 'src/util/sessions.ts'];
    assert.equal((await validateSourceImports(root, files)).checkedImports, 1);
    await assert.rejects(validateSourceImports(root, ['src/main.ts']), /missing an imported build input/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime download stays bounded without Content-Length and rejects oversized declared length', async () => {
  let consumed = 0; let cancelled = false;
  async function* responseBody() {
    try { for (let i = 0; i < 4; i += 1) { consumed += 1; yield Buffer.alloc(4); } }
    finally { cancelled = true; }
  }
  await assert.rejects(readBoundedBody(responseBody(), 6, null), /streaming download limit/);
  assert.equal(consumed, 2); assert.equal(cancelled, true);
  await assert.rejects(readBoundedBody(responseBody(), 6, '7'), /download limit/);
  async function* goodBody() { yield Buffer.from('abc'); }
  assert.equal((await readBoundedBody(goodBody(), 6, null)).toString(), 'abc');
});

test('ZIP metadata rejects unexpected, oversized, duplicate and traversal entries before unpacking', () => {
  const expected = new Map([['runtime/helper.bin', { bytes: 4 }]]); const seen = new Set();
  assert.equal(validateArchiveEntry({ name: 'runtime/helper.bin', originalSize: 4 }, expected, seen), true);
  for (const entry of [{ name: 'runtime/helper.bin', originalSize: 4 }, { name: 'runtime/helper.bin', originalSize: 99999999 },
    { name: 'runtime/private-enrollment.json', originalSize: 4 }, { name: '../owner.json', originalSize: 4 }]) {
    assert.throws(() => validateArchiveEntry(entry, expected, seen));
  }
});

test('installer path budget accounts for file NUL and directory margin and rejects runtime drift', () => {
  const relative = `runtime/${'a'.repeat(103)}/LICENSE`;
  const manifest = { files: [{ path: relative }] };
  assert.equal(relative.length, 119);
  const hook = '!define RELAY_MAX_RUNTIME_RELATIVE_FILE_CHARS 119\n'
    + '!define RELAY_MAX_RUNTIME_RELATIVE_DIRECTORY_CHARS 111\n!define RELAY_MAX_INSTALL_DIRECTORY_CHARS 135\n';
  const budget = validateInstallerPathBudget(manifest, hook);
  assert.equal(budget.maxInstallDirectoryChars, 135);
  assert.ok(135 + 1 + budget.fileChars + 1 <= 260);
  assert.ok(135 + 1 + budget.directoryChars + 1 <= 260 - 12);
  assert.throws(() => validateInstallerPathBudget({ files: [{ path: `${relative}a` }] }, hook), /budget mismatch/);
  assert.throws(() => validateInstallerPathBudget(manifest, hook.replace('CHARS 135', 'CHARS 139')), /budget mismatch/);
});
