#!/usr/bin/env node
import { connectResearch } from '../src/research/client.mjs';
const operation = process.argv[2] ?? 'status';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  if (!['status', 'start', 'stop', 'restart'].includes(operation) || process.argv.length > 3) throw Object.assign(new Error(), { code: 'INVALID_INPUT' });
  if (operation === 'stop' || operation === 'restart') {
    const previous = await connectResearch({ allowStart: false, allowStale: true });
    const status = await previous.call('status');
    await previous.call('shutdown');
    let exited = false;
    for (let i = 0; i < 100; i++) {
      await delay(100);
      try { await previous.call('status'); }
      catch (error) { if (error.code === 'DAEMON_UNAVAILABLE' || error.code === 'DAEMON_REPLY_LOST') { exited = true; break; } throw error; }
    }
    if (!exited) throw Object.assign(new Error(), { code: 'OWN_DAEMON_STOP_UNCONFIRMED' });
    if (operation === 'stop') {
      process.stdout.write(JSON.stringify({ stoppedOwnedPid: status.daemon.pid, relayUnchanged: true }) + '\n');
      process.exit(0);
    }
  }
  const current = await connectResearch();
  process.stdout.write(JSON.stringify(await current.call('status')) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ code: /^[A-Z_]{1,80}$/.test(error.code ?? '') ? error.code : 'RESEARCH_SERVICE_FAILED' }) + '\n');
  process.exitCode = 1;
}
