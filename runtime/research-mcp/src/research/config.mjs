import { readFile, lstat } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const RESEARCH_VERSION = '1.1.0';
export const MAX_FRAME_BYTES = 262144;
// Флаги запуска демона. Малое молодое поколение V8 удерживает память демона в пределах ~170 МиБ на 500 тыс. записей
// (по умолчанию куча раздувается до 140 МиБ и RSS выходит за 280 МиБ) и ускоряет приём; измерено scripts/bench-orchestrator.mjs.
export const DAEMON_NODE_ARGS = Object.freeze(['--max-semi-space-size=4']);
export function researchError(code) { return Object.assign(new Error(code), { code }); }

export async function assertPlainAncestors(path) {
  if (!isAbsolute(path)) throw researchError('ABSOLUTE_PATH_REQUIRED');
  let current = resolve(path);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw researchError('LINK_PATH_DENIED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
}

export async function readResearchConfig(env = process.env) {
  const userRoot = env.USERPROFILE;
  const systemRoot = env.SystemRoot;
  if (!userRoot || !systemRoot || !isAbsolute(systemRoot)) throw researchError('WINDOWS_RUNTIME_REQUIRED');
  const stateRoot = resolve(env.EGOIST_RESEARCH_STATE_ROOT || join(userRoot, '.egoist-research'));
  const runtimePath = join(stateRoot, 'runtime.json');
  let stored = {};
  try {
    await assertPlainAncestors(runtimePath);
    const info = await lstat(runtimePath);
    if (!info.isFile() || info.nlink !== 1 || info.size > 16384) throw researchError('RUNTIME_CONFIG_INVALID');
    stored = JSON.parse(await readFile(runtimePath, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Рабочая папка не зависит от внешних указателей: Desktop/Проекты владельца, переопределение — EGOIST_RESEARCH_WORKSPACE_ROOT.
  const workspaceSetting = env.EGOIST_RESEARCH_WORKSPACE_ROOT || join(userRoot, 'Desktop', 'Проекты');
  if (!isAbsolute(workspaceSetting)) throw researchError('ABSOLUTE_PATH_REQUIRED');
  const workspaceRoot = resolve(workspaceSetting);
  const outputRoot = resolve(env.EGOIST_RESEARCH_OUTPUT_ROOT || stored.outputRoot || join(workspaceRoot, 'Материалы', 'Социальные исследования'));
  const inside = relative(workspaceRoot, outputRoot);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw researchError('OUTPUT_WORKSPACE_REQUIRED');
  const relayProject = resolve(env.EGOIST_RESEARCH_RELAY_PROJECT || stored.relayProject || join(workspaceRoot, 'Приложения', 'Egoist Relay'));
  const relayExecutablePath = env.EGOIST_SOCIAL_RELAY_EXE || stored.relayExecutablePath
    || fileURLToPath(new URL('../../../../Egoist%20Relay.exe', import.meta.url));
  for (const path of [stateRoot, outputRoot, relayProject, relayExecutablePath]) {
    if (!isAbsolute(path)) throw researchError('ABSOLUTE_PATH_REQUIRED');
  }
  await assertPlainAncestors(stateRoot);
  await assertPlainAncestors(outputRoot);
  const identity = createHash('sha256').update(stateRoot.toLowerCase()).digest('hex').slice(0, 24);
  return { stateRoot, workspaceRoot, outputRoot, relayProject, relayExecutablePath,
    bridgeMetadataPath: join(stateRoot, 'relay-bridge.json'), bridgeTokenPath: join(stateRoot, 'relay-bridge-token'),
    relayInstallProofPath: join(stateRoot, 'relay-social-bridge-install.json'),
    bridgePipePath: `\\\\.\\pipe\\EgoistRelayAccountBridge-${identity}`,
    pipePath: `\\\\.\\pipe\\EgoistSocialMCP-${identity}`, tokenPath: join(stateRoot, 'social-daemon-token'), runtimePath,
    powershellPath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') };
}

export async function researchSourceHash() {
  const hash = createHash('sha256');
  for (const name of ['config.mjs', 'client.mjs', 'daemon.mjs', 'ipc.mjs', 'mcp.mjs', 'broker.mjs', 'job-store.mjs', 'bridge-client.mjs', 'bridge-provider.mjs', 'bridge-start.mjs', 'transcribe-media.mjs', 'local-index.mjs', 'export-format.mjs', 'orch-core.mjs', 'clock.mjs', 'policy.mjs', 'audit.mjs', 'raw-archive.mjs', 'normalize-item.mjs', 'orch-store.mjs', 'governor.mjs', 'source-input.mjs', 'scheduler.mjs', 'orchestrator.mjs', 'records-query.mjs', 'step-provider.mjs', 'bridge-features.mjs', 'media-resume.mjs', 'private-peer.mjs', 'lookup.mjs', 'tools.mjs', 'schema.mjs']) {
    hash.update(name).update(await readFile(new URL(name, import.meta.url)));
  }
  return hash.digest('hex');
}
