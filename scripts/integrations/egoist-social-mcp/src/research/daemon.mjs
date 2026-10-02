import { readFile } from 'node:fs/promises';
import { readResearchConfig, researchSourceHash } from './config.mjs';
import { listenResearchDaemon } from './ipc.mjs';
import { createResearchBroker } from './broker.mjs';
import { createRelayBridgeClient } from './bridge-client.mjs';
import { createRelayBridgeProvider } from './bridge-provider.mjs';

let stage = 'configuration';
async function main() {
  const config = await readResearchConfig();
  stage = 'private_token';
  const token = await readFile(config.tokenPath, 'utf8');
  stage = 'source_identity';
  const sourceHash = await researchSourceHash();
  stage = 'provider_construction';
  const bridge = createRelayBridgeClient(config);
  const providers = Object.fromEntries(['telegram', 'x', 'instagram'].map(provider =>
    [provider, createRelayBridgeProvider({ ...config, provider, bridge })]));
  stage = 'broker_storage';
  const broker = await createResearchBroker({ stateRoot: config.stateRoot, outputRoot: config.outputRoot, providers });
  let listener;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await listener?.close();
    await broker.close();
    await bridge.close();
  };
  try {
    stage = 'named_pipe';
    listener = await listenResearchDaemon({ broker, pipePath: config.pipePath, token, sourceHash, onShutdown: close });
  } catch (error) { await broker.close(); throw error; }
  process.once('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });
}
main().catch(error => {
  const code = /^[A-Z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'RESEARCH_DAEMON_START_FAILED';
  process.stderr.write(JSON.stringify({ code, stage }) + '\n');
  process.exitCode = 1;
});
