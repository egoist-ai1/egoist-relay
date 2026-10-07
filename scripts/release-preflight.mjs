import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSecrets, readConfiguration, selectSourceFiles, validateConfiguration, validateGenericPackaging, validateInstallerPathBudget,
  validateRuntime } from './release-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const manifest = (await import('./release-runtime-manifest.json', { with: { type: 'json' } })).default;
  const result = { schemaVersion: 1, configuration: validateConfiguration({ ...await readConfiguration(root), env: process.env }),
    runtime: await validateRuntime(root, manifest) };
  const hook = await readFile(path.join(root, 'tauri/installer.nsh'), 'utf8');
  result.packaging = await validateGenericPackaging(root, hook);
  result.installerPath = validateInstallerPathBudget(manifest, hook);
  const sources = await selectSourceFiles(root);
  for (const file of sources) {
    const bytes = await readFile(path.join(root, file));
    if (!bytes.includes(0)) assertNoSecrets(file, bytes.toString('utf8'));
  }
  result.sources = { count: sources.length, privacyScanPassed: true, scope: 'Whitelisted production inputs; excludes standalone test fixtures' };
  const reportIndex = process.argv.indexOf('--report');
  if (reportIndex !== -1) {
    if (!process.argv[reportIndex + 1]) throw new Error('--report requires a path');
    await writeFile(path.resolve(process.argv[reportIndex + 1]), `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`Release preflight passed: ${result.configuration.version}; ${result.runtime.count} verified runtime files; embedded UI; updater OFF\n`);
} catch (error) {
  process.stderr.write(`Release preflight failed: ${error.message}\n`); process.exitCode = 1;
}
