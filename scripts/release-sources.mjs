import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextEncoder } from 'node:util';
import { zipSync } from 'fflate';
import { assertNoSecrets, readConfiguration, requireCondition, selectSourceFiles, sha256, validateConfiguration,
  validateGenericPackaging, validateInstallerPathBudget, validateRuntime, validateSourceImports } from './release-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = process.argv.indexOf('--output');
try {
  requireCondition(flag !== -1 && process.argv[flag + 1], 'Specify an explicit --output directory');
  const output = path.resolve(process.argv[flag + 1]);
  const releaseRoot = path.join(root, 'release');
  const taskWork = process.env.EGOIST_RELAY_AUDIT_WORK && path.resolve(process.env.EGOIST_RELAY_AUDIT_WORK);
  requireCondition([releaseRoot, taskWork].filter(Boolean).some((parent) => {
    const relative = path.relative(parent, output); return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  }), 'Source output must be inside project release/ or the explicitly selected task work directory');
  const input = await readConfiguration(root);
  const configuration = validateConfiguration({ ...input, env: process.env });
  const runtimeManifest = (await import('./release-runtime-manifest.json', { with: { type: 'json' } })).default;
  await validateRuntime(root, runtimeManifest);
  const hook = await readFile(path.join(root, 'tauri/installer.nsh'), 'utf8');
  const packaging = await validateGenericPackaging(root, hook);
  const installerPath = validateInstallerPathBudget(runtimeManifest, hook);
  const files = await selectSourceFiles(root); const entries = {}; const sourceManifest = [];
  const imports = await validateSourceImports(root, files);
  for (const relative of files) {
    const bytes = await readFile(path.join(root, relative));
    if (!bytes.includes(0)) assertNoSecrets(relative, bytes.toString('utf8'));
    entries[relative] = [new Uint8Array(bytes), { mtime: new Date('1980-01-01T00:00:00Z') }];
    sourceManifest.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const npm = Object.entries(input.packageLock.packages).filter(([name]) => name).map(([name, value]) => ({
    package: name, version: value.version, license: value.license || 'not recorded',
    sourceArchive: publicSourceUrl(value.resolved), integrity: value.integrity || undefined,
    developmentOnly: value.dev === true,
  }));
  const cargo = input.cargoLock.split('[[package]]').slice(1).map((section) => {
    const get = (key) => section.match(new RegExp(`^${key} = "([^"\\r\\n]+)"`, 'm'))?.[1];
    const name = get('name'); const version = get('version'); const source = get('source');
    return { name, version, source, checksum: get('checksum'),
      sourceArchive: source?.startsWith('registry+') ? `https://static.crates.io/crates/${name}/${name}-${version}.crate` : publicSourceUrl(source) };
  });
  const components = [
    { name: 'Node.js', version: '24.21.0', sourceArchive: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0.tar.xz',
      licenseFile: 'runtime/NODE-LICENSE.txt', state: 'exact upstream source location recorded; not vendored' },
    { name: 'yt-dlp', version: '2026.08.19', sourceArchive: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.tar.gz',
      licenseFile: 'runtime/YT-DLP-THIRD-PARTY-LICENSES.txt', state: 'exact upstream source location recorded; standalone dependencies not vendored' },
    { name: 'whisper.cpp', version: '1.9.4', commit: '927cfce34f31707e17f2bff35c349632fb9e2c3a',
      sourceArchive: 'https://github.com/ggml-org/whisper.cpp/archive/927cfce34f31707e17f2bff35c349632fb9e2c3a.tar.gz',
      licenseFile: 'runtime/transcription/WHISPER-LICENSE.txt', state: 'exact upstream source location recorded; UTF-8 binary manifest derivation documented in runtime provenance' },
    { name: 'FFmpeg', version: '9.0.2 Gyan essentials build', licenseFile: 'runtime/media/FFMPEG-LICENSE.txt',
      state: 'BLOCKED: exact build dependency sources and build inputs not delivered' },
  ];
  const missingSource = ['FFmpeg exact dependency sources/build recipe',
    'dependency source archives for npm/Cargo and standalone yt-dlp'];
  const tauriPatch = JSON.parse(await readFile(path.join(root, 'tauri/vendor/tauri-provenance.json'), 'utf8'));
  const vendoredCargo = [{ name: 'tauri', version: tauriPatch.version, sourceDirectory: 'tauri/vendor/tauri',
    provenanceFile: 'tauri/vendor/tauri-provenance.json', upstreamArchive: tauriPatch.sourceArchive,
    upstreamArchiveSha256: tauriPatch.archiveSha256, modifiedFile: tauriPatch.patchedFile,
    modifiedFileSha256: await sha256(path.join(root, 'tauri/vendor/tauri', tauriPatch.patchedFile)),
    state: 'Modified existing crate source and upstream licenses delivered in project source archive' }];
  const availability = { schemaVersion: 1, version: configuration.version,
    scope: 'Pinned dependency source locations and delivered inputs; URLs have not been downloaded or independently availability-probed by this command',
    npm, cargo, vendoredCargo, components, installerPath, packaging, correspondingSourceComplete: false, publicationBlocked: true, missingSource };
  for (const entry of runtimeManifest.files.filter((file) => /(?:LICENSE|NOTICE|provenance)/i.test(file.path))) {
    entries[`component-notices/${entry.path.slice('runtime/'.length)}`] = new Uint8Array(await readFile(path.join(root, entry.path)));
  }
  entries['source-manifest.json'] = new TextEncoder().encode(`${JSON.stringify({ version: configuration.version, files: sourceManifest, imports,
    exclusions: 'Local environments, account/profile/enrollment stores, build/evidence output, and standalone test/fixture files' }, null, 2)}\n`);
  entries['dependency-sources.json'] = new TextEncoder().encode(`${JSON.stringify(availability, null, 2)}\n`);
  entries['BUILDING.md'] = new TextEncoder().encode(`# Egoist Relay ${configuration.version} source preparation\n\n`
    + 'Windows x64 10 version 1903 or newer; Node.js 24, npm 11; Rust 1.97 MSVC; Windows SDK and NSIS.\n\n'
    + `The installed application directory is limited to ${installerPath.maxInstallDirectoryChars} UTF-16 units by bundled notice paths and classic Win32 limits. The installer rejects longer paths before dependency/payload installation; it does not change the system long-path policy.\n\n`
    + 'Run npm ci, provide your own TELEGRAM_API_ID and TELEGRAM_API_HASH in a local .env, and place the exact public runtime files described in scripts/release-runtime-manifest.json into runtime/. Run npm run release:preflight, npm run check, and npm run tauri:build. TEST_SESSION and personal profile files must never be included. This version builds one generic installer and inherits the host network configuration; it does not import network profiles or bundle proxy/VPN engines.\n\n'
    + 'Standalone unit tests and fixtures are excluded from this source preparation archive. The full test commands and CI require the original reviewed repository; npm test is not a verification gate for this partial archive. The archive extraction was typechecked with the existing locked dependencies, not independently rebuilt on a clean host.\n\n'
    + 'This archive prepares project source and notices. It does not claim complete corresponding source delivery for every bundled executable. See dependency-sources.json for blocking missing inputs. The original GPL license is in LICENSE. No user accounts, DNS/tunnel enrollment, private keys, build logs or installed profiles are included.\n');
  await mkdir(output, { recursive: true });
  const archivePath = path.join(output, `Egoist-Relay-${configuration.version}-sources.zip`);
  await writeFile(archivePath, zipSync(entries, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') }));
  await writeFile(path.join(output, 'dependency-sources.json'), `${JSON.stringify(availability, null, 2)}\n`);
  await writeFile(path.join(output, 'source-manifest.json'), `${JSON.stringify({ version: configuration.version, files: sourceManifest, imports,
    archiveSha256: await sha256(archivePath), correspondingSourceComplete: false }, null, 2)}\n`);
  process.stdout.write(`Prepared ${sourceManifest.length} safe project source files and component notices. Corresponding source remains incomplete; publication blocked.\n`);
} catch (error) { process.stderr.write(`Source preparation failed: ${error.message}\n`); process.exitCode = 1; }

function publicSourceUrl(value) {
  if (!value) return undefined;
  const url = value.replace(/^git\+/, '').replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
  try { const parsed = new URL(url);
    requireCondition(parsed.protocol === 'https:' && !parsed.username && !parsed.password,
      'Dependency source contains credentials or an unsupported private URL');
    requireCondition(!/^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(parsed.hostname),
      'Dependency source references a private host');
    return parsed.href;
  } catch (error) { throw new Error(`Invalid public dependency source: ${error.message}`, { cause: error }); }
}
