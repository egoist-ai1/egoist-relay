import { readFile, lstat } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { createHash } from 'node:crypto';

export const RESEARCH_VERSION = '1.0.0';
export const MAX_FRAME_BYTES = 262144;
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
  const localData = env.LOCALAPPDATA;
  if (!userRoot || !localData) throw researchError('WINDOWS_RUNTIME_REQUIRED');
  const pointer = JSON.parse(await readFile(join(userRoot, '.codex', 'brain-pointer.json'), 'utf8'));
  const stateRoot = resolve(env.EGOIST_RESEARCH_STATE_ROOT || join(userRoot, '.egoist-research'));
  const runtimePath = join(stateRoot, 'runtime.json');
  let stored = {};
  try {
    await assertPlainAncestors(runtimePath);
    const info = await lstat(runtimePath);
    if (!info.isFile() || info.nlink !== 1 || info.size > 16384) throw researchError('RUNTIME_CONFIG_INVALID');
    stored = JSON.parse(await readFile(runtimePath, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const workspaceRoot = resolve(pointer.workspace_root);
  const outputRoot = resolve(env.EGOIST_RESEARCH_OUTPUT_ROOT || stored.outputRoot || join(workspaceRoot, 'Материалы', 'Социальные исследования'));
  const inside = relative(workspaceRoot, outputRoot);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw researchError('OUTPUT_WORKSPACE_REQUIRED');
  const relayProject = resolve(env.EGOIST_RESEARCH_RELAY_PROJECT || stored.relayProject || join(workspaceRoot, 'Приложения', 'Egoist Relay'));
  const relayExecutablePath = env.EGOIST_SOCIAL_RELAY_EXE || stored.relayExecutablePath || join(localData, 'Egoist Relay', 'Egoist Relay.exe');
  for (const path of [stateRoot, outputRoot, relayProject, relayExecutablePath]) {
    if (!isAbsolute(path)) throw researchError('ABSOLUTE_PATH_REQUIRED');
  }
  await assertPlainAncestors(stateRoot);
  await assertPlainAncestors(outputRoot);
  const identity = createHash('sha256').update(stateRoot.toLowerCase()).digest('hex').slice(0, 24);
  return { stateRoot, outputRoot, relayProject, relayExecutablePath,
    bridgeMetadataPath: join(stateRoot, 'relay-bridge.json'), bridgeTokenPath: join(stateRoot, 'relay-bridge-token'),
    relayInstallProofPath: join(stateRoot, 'relay-social-bridge-install.json'),
    bridgePipePath: `\\\\.\\pipe\\EgoistRelayAccountBridge-${identity}`,
    pipePath: `\\\\.\\pipe\\EgoistSocialMCP-${identity}`, tokenPath: join(stateRoot, 'social-daemon-token'), runtimePath,
    powershellPath: join(userRoot, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe') };
}

export async function researchSourceHash() {
  const hash = createHash('sha256');
  for (const name of ['config.mjs', 'client.mjs', 'daemon.mjs', 'ipc.mjs', 'mcp.mjs', 'broker.mjs', 'job-store.mjs', 'bridge-client.mjs', 'bridge-provider.mjs', 'bridge-start.mjs', 'transcribe-media.mjs', 'local-index.mjs', 'export-format.mjs']) {
    hash.update(name).update(await readFile(new URL(name, import.meta.url)));
  }
  return hash.digest('hex');
}
