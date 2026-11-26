#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectResearch } from '../src/research/client.mjs';
import { readResearchConfig } from '../src/research/config.mjs';
import { verifyAuditChain } from '../src/research/audit.mjs';
const operation = process.argv[2] ?? 'status';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  if (!['status', 'start', 'stop', 'restart', 'import', 'audit-verify'].includes(operation) || (process.argv.length > 3 && operation !== 'import')) throw Object.assign(new Error(), { code: 'INVALID_INPUT' });
  if (operation === 'audit-verify') {
    // Без демона: читает журнал аудита и проверяет цепочку хэшей.
    const config = await readResearchConfig();
    const result = verifyAuditChain(join(config.stateRoot, 'audit'));
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } else if (operation === 'import') {
    // Импорт завершённых старых заданий (UUID) в новое хранилище; без аргументов — все пригодные. Исходные файлы не меняются.
    const jobIds = process.argv.slice(3);
    const current = await connectResearch();
    const result = await current.call('import_legacy', jobIds.length ? { jobIds } : {}, { timeoutMs: 300000 });
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
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
  }
} catch (error) {
  const report = { code: /^[A-Z_]{1,80}$/.test(error.code ?? '') ? error.code : 'RESEARCH_SERVICE_FAILED' };
  if (report.code === 'DAEMON_START_FAILED') {
    // Демон стартует без консоли: причина последнего отказа старта лежит в daemon-last-error.json (код и стадия, без текстов).
    try { const config = await readResearchConfig(); const last = JSON.parse(await readFile(join(config.stateRoot, 'daemon-last-error.json'), 'utf8')); report.lastStart = { code: last.code, stage: last.stage, reason: last.reason, at: last.at }; } catch { /* файла нет */ }
  }
  process.stderr.write(JSON.stringify(report) + '\n');
  process.exitCode = 1;
}
