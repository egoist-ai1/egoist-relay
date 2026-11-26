import { readFile, unlink, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { readResearchConfig, researchSourceHash } from './config.mjs';
import { listenResearchDaemon } from './ipc.mjs';
import { createResearchBroker } from './broker.mjs';
import { createRelayBridgeClient } from './bridge-client.mjs';
import { createRelayBridgeProvider } from './bridge-provider.mjs';
import { createBridgeStepProvider, createProviderGate } from './step-provider.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { createAudit } from './audit.mjs';
import { createAccountAlias, OrchError } from './orch-core.mjs';
import { assertReadAllowed, loadPolicy } from './policy.mjs';

const PROVIDERS = ['telegram', 'x', 'instagram'];
let stage = 'configuration';
let stateDirectory;
async function main() {
  const config = await readResearchConfig();
  stateDirectory = config.stateRoot;
  stage = 'private_token';
  const token = await readFile(config.tokenPath, 'utf8');
  stage = 'source_identity';
  const sourceHash = await researchSourceHash();
  stage = 'policy';
  const policy = await loadPolicy({ stateRoot: config.stateRoot });
  if (policy.error) policy.policy = { ...policy.policy, read: false, readPrivateThread: false };
  stage = 'audit';
  // Ключ алиаса аккаунта выводится из постоянного приватного токена демона (тот же каталог состояния и права доступа).
  const accountAlias = createAccountAlias(token);
  const audit = await createAudit({ directory: join(config.stateRoot, 'audit'), accountAlias });
  audit.append('daemon_start', { version: sourceHash.slice(0, 12), policy: policy.source, policyError: policy.error });
  stage = 'provider_construction';
  const bridge = createRelayBridgeClient(config);
  // Старые задания брокера и шаги оркестратора делят один затвор платформы. Его ёмкость — число запусков, которое Relay объявил
  // в status (maxConcurrent, по умолчанию 1) с потолком владельца policy.limits.telegramParallel; затвор читает её при каждом освобождении места.
  let orchestrator;
  const stepProviders = {};
  const gates = Object.fromEntries(PROVIDERS.map(provider => [provider, createProviderGate({ capacity: () => stepProviders[provider]?.maxConcurrent ?? 1 })]));
  const getPolicy = () => orchestrator?.getPolicy() ?? policy.policy;
  let policyRun = new AbortController();
  const guardRead = signal => {
    assertReadAllowed(getPolicy());
    return signal ? AbortSignal.any([signal, policyRun.signal]) : policyRun.signal;
  };
  // Личные диалоги Telegram (пользователи, боты, «Избранное») читаются только при readPrivateThread в policy.json владельца.
  const allowPrivateDialogs = () => getPolicy().readPrivateThread === true;
  const legacyProviders = Object.fromEntries(PROVIDERS.map(provider => {
    const legacy = createRelayBridgeProvider({ ...config, provider, bridge }, { allowPrivateDialogs, readyTtlMs: 0 });
    return [provider, { ...legacy, run: args => {
      const signal = guardRead(args.signal);
      return gates[provider].run(() => legacy.run({ ...args, signal }), signal);
    } }];
  }));
  for (const provider of PROVIDERS) stepProviders[provider] = createBridgeStepProvider({ provider, bridge, gate: gates[provider], getParallelLimit: () => getPolicy().limits.telegramParallel, allowPrivateDialogs, guardRead });
  stage = 'broker_storage';
  const broker = await createResearchBroker({ stateRoot: config.stateRoot, outputRoot: config.outputRoot, providers: legacyProviders, accountAlias, getPolicy });
  stage = 'orchestrator_storage';
  try { orchestrator = await createOrchestrator({ stateRoot: config.stateRoot, outputRoot: config.outputRoot, workspaceRoot: config.workspaceRoot, providers: stepProviders, policy, audit, accountAlias, autostart: false }); }
  catch (error) { await broker.close(); throw error; }
  let listener;
  let policyWatcher;
  let policyRev = 0;
  let closing = false;
  const suspendReads = reason => {
    policyRun.abort(new OrchError('POLICY_DENIED', 'The owner policy is changing.'));
    policyRun = new AbortController();
    orchestrator.setPolicy({ policy: { ...getPolicy(), read: false, readPrivateThread: false }, source: 'file', error: reason });
  };
  const refreshPolicy = async () => {
    if (closing) return;
    const rev = ++policyRev;
    suspendReads('policy_reloading');
    const next = await loadPolicy({ stateRoot: config.stateRoot, create: false }).catch(() => null);
    if (closing || rev !== policyRev) return;
    if (next?.source === 'file' && !next.error) orchestrator.setPolicy(next);
    else suspendReads(next?.error ?? 'policy_file_unavailable');
  };
  const close = async () => {
    if (closing) return;
    closing = true;
    policyWatcher?.close();
    await listener?.close();
    await orchestrator.close();
    await broker.close();
    await bridge.close();
    audit.append('daemon_stop', {});
    audit.close();
  };
  try {
    policyWatcher = watch(config.stateRoot, { persistent: false }, (_event, name) => {
      if (!name || name.toLowerCase() === 'policy.json') void refreshPolicy();
    });
    policyWatcher.on('error', () => { policyRev++; suspendReads('policy_watch_unavailable'); });
    await refreshPolicy();
    orchestrator.scheduler.start();
    stage = 'named_pipe';
    listener = await listenResearchDaemon({ broker, orchestrator, audit, pipePath: config.pipePath, token, sourceHash, onShutdown: close });
  } catch (error) { policyWatcher?.close(); await orchestrator.close(); await broker.close(); audit.close(); throw error; }
  await unlink(join(config.stateRoot, 'daemon-last-error.json')).catch(() => {});
  process.once('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });
}
main().catch(error => {
  const code = /^[A-Z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'RESEARCH_DAEMON_START_FAILED';
  const reason = /^[A-Z_]{1,80}$/.test(error?.reason ?? '') ? error.reason : undefined;
  const report = { code, stage, ...(reason ? { reason } : {}), at: new Date().toISOString() };
  process.stderr.write(JSON.stringify(report) + '\n');
  process.exitCode = 1;
  // Клиент запускает демон без консоли (stdio: ignore): причину отказа старта оставляем в приватном каталоге состояния. Только код и стадия.
  if (stateDirectory) void writeFile(join(stateDirectory, 'daemon-last-error.json'), JSON.stringify(report) + '\n').catch(() => {});
});
