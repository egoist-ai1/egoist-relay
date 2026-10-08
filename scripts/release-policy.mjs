import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const PRODUCT = Object.freeze({ identifier: 'com.egoist.relay', name: 'Egoist Relay', minWebview: '143.0.0.0' });
export const SOURCE_ROOTS = ['src', 'public', 'plugins', 'dev', 'deploy', '.github/workflows',
  'tauri/src', 'tauri/vendor', 'tauri/icons', 'tauri/fonts', 'tauri/capabilities', 'tauri/permissions'];
export const SOURCE_FILES = ['LICENSE', 'package.json', 'package-lock.json', 'vite.config.ts', 'vitest.config.ts',
  'postcss.config.ts', 'eslint.config.js', '.stylelintrc.json', '.editorconfig', 'index.html',
  'tsconfig.json', 'tsconfig.base.json', 'tsconfig.script.json', 'tsconfig.test.json',
  'tauri/Cargo.toml', 'tauri/Cargo.lock', 'tauri/tauri.conf.json', 'tauri/build.rs', 'tauri/installer.nsh',
  'tauri/installer-processes.ps1', 'tauri/installer-legacy-runtime.json'];
const REMOVED_NETWORK_FILE = /(?:^|\/)(?:xray(?:\.exe|-provenance\.json)|ciadpi\.exe|egoist-tg-proxy\.exe|(?:XRAY(?:-GO)?|BYEDPI|WS)-LICENSE\.txt)$/i;
const REMOVED_NETWORK_SOURCE = /^(?:scripts\/(?:app-dns|app-proxy|proxy-bridge|lagom-tunnel)(?:\.|\/)|scripts\/(?:import-lagom|build-personal)|tauri\/(?:installer-(?:dns|tunnel)-profile\.ps1|src\/(?:network|dns_profile|tunnel)\.rs))/i;
const BLOCKED_PARTS = /^(?:\.git|node_modules|target|dist|release|\.cache|__pycache__|__tests__|screenshots?)$/i;
const BLOCKED_FILE = /(?:^\.env(?:\.|$)|\.p(?:fx|12|em)$|\.key$|\.dpapi$|\.(?:db|sqlite3?|cookies?)$|(?:^|[-_.])(?:private|enrollment|cookies?|sessions?|credentials)(?=[-_.]|$).*\.(?:json|txt|log)$)/i;
const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/,
  /(?:password|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key)\s*[=:]\s*["'][^"'\r\n]{20,}["']/i,
  /https:\/\/(?:dns\.controld\.com\/[A-Za-z0-9_-]{8,}|dns\.nextdns\.io\/[a-f0-9]{6})(?:\b|\/)/i,
];

export function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertSafeRelative(file) {
  requireCondition(typeof file === 'string' && file.length > 0 && !file.includes('\\')
    && !path.posix.isAbsolute(file) && !file.split('/').some((part) => part === '..' || part === '.' || !part),
  `Unsafe release path: ${file}`);
}

export function isSafeSourcePath(file) {
  assertSafeRelative(file);
  return !file.split('/').some((part) => BLOCKED_PARTS.test(part)) && !BLOCKED_FILE.test(path.posix.basename(file))
    && !/(?:^|\/)(?:accounts?|sessions?|enrollment)\/.*\.(?:json|txt|log|bin)$/i.test(file)
    && !/^public\/(?:build-stats\.json|statoscope-report\.html|installer\.html)$/.test(file)
    && !/\.(?:test|spec|fixture)\./i.test(file);
}

export function isRemovedNetworkRuntime(file) {
  return REMOVED_NETWORK_FILE.test(file) || /^runtime\/licenses\/xray-dependencies\//i.test(file);
}

export function assertNoSecrets(file, content) {
  for (const pattern of SECRET_PATTERNS) {
    requireCondition(!pattern.test(content), `Potential secret in source: ${file}`);
  }
  for (const match of content.matchAll(/https?:\/\/[^\s/"']+:[^\s/@"']+@[^\s/"']+/gi)) {
    const host = new URL(match[0]).hostname;
    const reservedFixture = /(?:^|\.)(?:example\.com|example\.org|example\.net|example|invalid|test)$/.test(host);
    requireCondition(reservedFixture, `Potential secret in source: ${file}`);
  }
}

export async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    requireCondition(!entry.isSymbolicLink(), `Symbolic link excluded from release: ${relative}`);
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Non-regular release file: ${relative}`);
  }
  return files.sort();
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function publicRuntimeResources(manifest) {
  requireCondition(manifest.schemaVersion === 1 && Array.isArray(manifest.files) && manifest.files.length > 0,
    'Invalid runtime allowlist');
  const resources = {};
  for (const entry of manifest.files) {
    assertSafeRelative(entry.path);
    requireCondition(entry.path.startsWith('runtime/') && isSafeSourcePath(entry.path)
      && !isRemovedNetworkRuntime(entry.path), 'Only reviewed public runtime files may be installer resources');
    requireCondition(!Object.hasOwn(resources, `../${entry.path}`), 'Duplicate runtime resource');
    resources[`../${entry.path}`] = entry.path;
  }
  return resources;
}

export function validateConfiguration({ pkg, packageLock, cargo, cargoLock, config, runtimeManifest, env = {} }) {
  requireCondition(config.identifier === PRODUCT.identifier && config.productName === PRODUCT.name
    && config.mainBinaryName === PRODUCT.name, 'Release product identity mismatch');
  requireCondition(config.build?.frontendDist === '../dist', 'Release frontend must be embedded ../dist');
  requireCondition(config.bundle?.createUpdaterArtifacts === false && !config.plugins?.updater,
    'Updater must remain disabled until a signed update channel exists');
  requireCondition(config.bundle?.windows?.allowDowngrades === false, 'Installer must reject downgrades');
  requireCondition(config.bundle?.windows?.minimumWebview2Version === PRODUCT.minWebview,
    `WebView2 minimum must be the reviewed baseline ${PRODUCT.minWebview}`);
  requireCondition(!config.bundle.externalBin?.length && config.bundle.windows.nsis?.installerHooks === 'installer.nsh'
    && !config.bundle.windows.nsis.template, 'Generic release requires the reviewed installer hook and no external executables');
  const resources = publicRuntimeResources(runtimeManifest);
  requireCondition(config.bundle?.resources && Object.keys(config.bundle.resources).length === Object.keys(resources).length
    && Object.entries(resources).every(([file, destination]) => config.bundle.resources[file] === destination),
    'Unexpected bundled resource mapping; review the public runtime allowlist');
  const version = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  requireCondition(/^\d+\.\d+\.\d+$/.test(pkg.version) && version === pkg.version
    && packageLock.version === pkg.version && packageLock.packages?.['']?.version === pkg.version,
  'Package, lockfile and Cargo versions must match');
  const tauriVersion = cargoLock.match(/\[\[package\]\]\r?\nname = "tauri"\r?\nversion = "([^"]+)"/)?.[1];
  requireCondition(tauriVersion && compareVersions(tauriVersion, '2.12.0') >= 0,
    'Tauri lockfile requires version >=2.12.0 for the Windows session-end fix');
  const taoVersion = cargoLock.match(/\[\[package\]\]\r?\nname = "tao"\r?\nversion = "([^"]+)"/)?.[1];
  requireCondition(taoVersion && compareVersions(taoVersion, '0.37.0') >= 0,
    'Tao lockfile requires version >=0.37.0 for the Windows session-end fix');
  requireCondition(!env.TEST_SESSION && env.APP_MOCKED_CLIENT !== '1' && env.WITH_UPDATER !== 'true',
    'Production build rejects test sessions, mocked clients and unsigned updater configuration');
  requireCondition(!Object.entries(env).some(([name, value]) => value
    && /^EGOIST_RELAY_.*(?:PRIVATE|ENROLLMENT|TUNNEL|DNS|DOH|PROXY)/i.test(name)),
  'Generic release rejects private network provisioning configuration');
  requireCondition(!Object.entries(pkg.scripts || {}).some(([name, command]) =>
    /(?:build:proxy|import.*(?:dns|lagom|tunnel)|build.*personal)/i.test(name)
    || /(?:build:proxy|app-proxy|app-dns|proxy-bridge|import-lagom|lagom-tunnel|build-personal)/i.test(command)),
  'Generic release must not build or import internal network engines');
  return { version: pkg.version, tauriVersion, taoVersion, identifier: config.identifier, embeddedFrontend: true,
    updater: false, installerVariant: 'generic', networkEnginesBundled: false };
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number); const b = right.split('.').map(Number);
  requireCondition(a.every(Number.isFinite) && b.every(Number.isFinite), 'Invalid release dependency version');
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export async function validateRuntime(root, manifest) {
  requireCondition(manifest.schemaVersion === 1 && Array.isArray(manifest.files) && manifest.files.length > 0,
    'Invalid runtime allowlist');
  const expected = new Map();
  for (const entry of manifest.files) {
    assertSafeRelative(entry.path);
    requireCondition(entry.path.startsWith('runtime/') && !expected.has(entry.path)
      && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes > 0,
    `Invalid runtime manifest entry: ${entry.path}`);
    requireCondition(isSafeSourcePath(entry.path), `Private runtime entry forbidden: ${entry.path}`);
    requireCondition(!isRemovedNetworkRuntime(entry.path), `Internal network runtime forbidden: ${entry.path}`);
    expected.set(entry.path, entry);
  }
  const retired = new Map();
  let retiredManifest;
  try { retiredManifest = JSON.parse(await readFile(path.join(root, 'tauri/installer-legacy-runtime.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (retiredManifest) {
    requireCondition(retiredManifest.schemaVersion === 1 && Array.isArray(retiredManifest.files), 'Invalid retired runtime allowlist');
    for (const entry of retiredManifest.files) {
      assertSafeRelative(entry.path);
      requireCondition(isRemovedNetworkRuntime(entry.path) && !retired.has(entry.path) && !expected.has(entry.path)
        && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes > 0,
      'Invalid retired runtime entry');
      retired.set(entry.path, entry);
    }
  }
  const actual = (await listFiles(path.join(root, 'runtime'), 'runtime'));
  requireCondition([...expected.keys()].every((file) => actual.includes(file))
    && actual.every((file) => expected.has(file) || retired.has(file)),
    'Runtime contains missing or unexpected files; no enrollment, profiles or credentials may be bundled');
  for (const relative of actual) {
    const file = path.join(root, relative); const info = await lstat(file); const entry = expected.get(relative) || retired.get(relative);
    requireCondition(info.size === entry.bytes && await sha256(file) === entry.sha256,
      `Runtime integrity mismatch: ${relative}`);
  }
  return { count: expected.size, retiredSourceFiles: actual.filter((file) => retired.has(file)).length,
    allowlistVerified: true, retiredFilesBundled: false };
}

export async function validateGenericPackaging(root, hook) {
  requireCondition(!/(?:EGOIST_RELAY_PRIVATE_|ENROLLMENT_FILE|installer-(?:dns|tunnel)-profile|relay-(?:dns|tunnel)-enrollment)/i.test(hook),
    'Generic installer must not contain private network provisioning hooks');
  const obsolete = ['scripts/import-lagom-tunnel.ps1', 'scripts/lagom-tunnel.mjs', 'scripts/lagom-tunnel.test.mjs',
    'scripts/build-personal-installer.ps1', 'tauri/installer-dns-profile.ps1', 'tauri/installer-tunnel-profile.ps1'];
  for (const file of obsolete) {
    let present = false;
    try { await lstat(path.join(root, file)); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    requireCondition(!present, `Obsolete network provisioning input forbidden: ${file}`);
  }
  return { installerVariant: 'generic', privateProvisioning: false, internalNetworkEngines: false };
}

export function validateInstallerPathBudget(manifest, hook) {
  const fileChars = Math.max(...manifest.files.map((file) => file.path.length));
  const directoryChars = Math.max(...manifest.files.map((file) => path.posix.dirname(file.path).length));
  const maxInstallDirectoryChars = Math.min(260 - 1 - 1 - fileChars, 260 - 12 - 1 - 1 - directoryChars);
  const constants = { RELAY_MAX_RUNTIME_RELATIVE_FILE_CHARS: fileChars,
    RELAY_MAX_RUNTIME_RELATIVE_DIRECTORY_CHARS: directoryChars, RELAY_MAX_INSTALL_DIRECTORY_CHARS: maxInstallDirectoryChars };
  for (const [name, expected] of Object.entries(constants)) {
    const actual = hook.match(new RegExp(`^!define ${name} (\\d+)\\s*$`, 'm'))?.[1];
    requireCondition(Number(actual) === expected, `Installer path budget mismatch: ${name}`);
  }
  return { fileChars, directoryChars, maxInstallDirectoryChars, scope: 'Classic Win32 path budget; no system long-path opt-in required' };
}

export async function readConfiguration(root) {
  const read = (file) => readFile(path.join(root, file), 'utf8');
  const [pkg, packageLock, cargo, cargoLock, config, runtimeManifest] = await Promise.all([
    read('package.json'), read('package-lock.json'), read('tauri/Cargo.toml'), read('tauri/Cargo.lock'), read('tauri/tauri.conf.json'),
    read('scripts/release-runtime-manifest.json'),
  ]);
  return { pkg: JSON.parse(pkg), packageLock: JSON.parse(packageLock), cargo, cargoLock,
    config: JSON.parse(config), runtimeManifest: JSON.parse(runtimeManifest) };
}

export async function selectSourceFiles(root) {
  const selected = [];
  for (const relative of SOURCE_FILES) {
    try { const stat = await lstat(path.join(root, relative));
      requireCondition(stat.isFile() && !stat.isSymbolicLink(), `Invalid source input: ${relative}`); selected.push(relative);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const directory of [...SOURCE_ROOTS, 'scripts']) {
    let files;
    try { files = await listFiles(path.join(root, directory), directory); }
    catch (error) { if (error.code === 'ENOENT' && directory === 'tauri/permissions') continue; throw error; }
    for (const relative of files) {
      if (!isSafeSourcePath(relative) || REMOVED_NETWORK_SOURCE.test(relative)) continue;
      if (directory === 'scripts' && (!/\.(?:mjs|js|ps1|py|json|tsx)$/.test(relative)
        || /(?:capture-screen|visual-audit|ui-regression|import-lagom|start-relay)/.test(relative))) continue;
      selected.push(relative);
    }
  }
  return [...new Set(selected)].sort();
}

export async function validateSourceImports(root, files) {
  const ts = await import('typescript'); const selected = new Set(files);
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : { config: {} };
  const options = ts.parseJsonConfigFileContent(config.config || {}, ts.sys, root).options;
  let checkedImports = 0;
  for (const file of files.filter((name) => /\.(?:ts|tsx|js|mjs)$/.test(name))) {
    const absolute = path.join(root, file); const content = await readFile(absolute, 'utf8');
    for (const imported of ts.preProcessFile(content, true, true).importedFiles) {
      const specifier = imported.fileName.replace(/[?#].*$/, '');
      const resolved = ts.resolveModuleName(specifier, absolute, options, ts.sys).resolvedModule?.resolvedFileName;
      const target = resolved || (specifier.startsWith('.') && path.resolve(path.dirname(absolute), specifier));
      if (!target || !ts.sys.fileExists(target)) continue;
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (relative.startsWith('node_modules/') || relative.startsWith('../')) continue;
      requireCondition(selected.has(relative), `Source archive missing an imported build input: ${file} -> ${relative}`);
      checkedImports += 1;
    }
  }
  for (const essential of ['src/util/sessions.ts', 'src/global/actions/authentication/sessions.ts',
    'scripts/inline-media-resolver.mjs', 'tauri/src/lib.rs']) {
    if (ts.sys.fileExists(path.join(root, essential))) requireCondition(selected.has(essential), `Essential source input excluded: ${essential}`);
  }
  return { checkedImports, scope: 'Resolved local TypeScript/JavaScript imports and essential production entry points' };
}

// Команды установщика зарегистрированы в оболочке, но в окнах приложения не выдаются.
const COMMANDS_WITHOUT_CAPABILITY = new Set(['get_default_install_dir', 'choose_install_dir', 'minimize_installer', 'close_installer',
  'launch_installed_app', 'perform_install']);

function stripRustComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

export function parseHandlerCommands(libRs) {
  const body = stripRustComments(libRs).match(/generate_handler!\s*\[([\s\S]*?)\]/)?.[1];
  requireCondition(body, 'Tauri invoke handler list not found');
  return body.split(',').map((item) => item.trim().split('::').pop()).filter(Boolean);
}

export function parseManifestCommands(buildRs) {
  const body = stripRustComments(buildRs).match(/\.commands\(\s*&\[([\s\S]*?)\]\s*\)/)?.[1];
  requireCondition(body, 'Tauri app manifest command list not found');
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

export function parsePermissionSets(tomlText) {
  const sets = new Map();
  for (const block of tomlText.split(/^\[\[permission\]\]/m).slice(1)) {
    const identifier = block.match(/^\s*identifier\s*=\s*"([^"]+)"/m)?.[1];
    const allowed = block.match(/^\s*commands\.allow\s*=\s*\[([^\]]*)\]/m)?.[1];
    if (identifier && allowed) sets.set(identifier, [...allowed.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  }
  return sets;
}

// Каждая зарегистрированная команда должна быть в манифесте приложения и разрешена ровно в одной capability.
export function validateCommandAcl({ libRs, buildRs, capabilities, permissionToml = '' }) {
  const handler = parseHandlerCommands(libRs);
  const manifest = parseManifestCommands(buildRs);
  requireCondition(new Set(handler).size === handler.length, 'Duplicate command in the Tauri invoke handler');
  const missing = handler.filter((command) => !manifest.includes(command));
  requireCondition(missing.length === 0, `Command registered but absent from the ACL app manifest (blocked at runtime): ${missing.join(', ')}`);
  const stale = manifest.filter((command) => !handler.includes(command));
  requireCondition(stale.length === 0, `ACL app manifest lists commands that are not registered: ${stale.join(', ')}`);
  const sets = parsePermissionSets(permissionToml);
  for (const command of manifest) sets.set(`allow-${command.replaceAll('_', '-')}`, [command]);
  const grants = new Map(handler.map((command) => [command, []]));
  for (const { file, config } of capabilities) {
    const identifiers = (config.permissions || []).map((item) => (typeof item === 'string' ? item : item?.identifier)).filter(Boolean);
    for (const identifier of identifiers) {
      requireCondition(identifier.includes(':') || sets.has(identifier), `Unknown permission "${identifier}" in capability ${file}`);
      for (const command of sets.get(identifier) || []) grants.get(command)?.push(file);
    }
  }
  for (const [command, files] of grants) {
    const unique = [...new Set(files)];
    requireCondition(files.length === unique.length, `Command ${command} is granted twice in one capability`);
    if (COMMANDS_WITHOUT_CAPABILITY.has(command)) {
      requireCondition(unique.length === 0, `Command ${command} must stay without a capability`);
    } else {
      requireCondition(unique.length === 1, `Command ${command} must be allowed in exactly one capability, found ${unique.length}`);
    }
  }
  return { commands: handler.length, capabilities: capabilities.length };
}

export async function readCommandAcl(root) {
  const read = (file) => readFile(path.join(root, file), 'utf8');
  const capabilityDirectory = path.join(root, 'tauri/capabilities');
  const capabilityFiles = (await readdir(capabilityDirectory)).filter((name) => name.endsWith('.json')).sort();
  const capabilities = await Promise.all(capabilityFiles.map(async (name) => ({ file: name, config: JSON.parse(await read(`tauri/capabilities/${name}`)) })));
  const permissionDirectory = path.join(root, 'tauri/permissions');
  const permissionFiles = (await readdir(permissionDirectory)).filter((name) => name.endsWith('.toml')).sort();
  const permissionToml = (await Promise.all(permissionFiles.map((name) => read(`tauri/permissions/${name}`)))).join('\n');
  return { libRs: await read('tauri/src/lib.rs'), buildRs: await read('tauri/build.rs'), capabilities, permissionToml };
}
