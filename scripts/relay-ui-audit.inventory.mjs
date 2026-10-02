import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { project } from './relay-ui-audit.server.mjs';

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(full));
    else result.push(full);
  }
  return result;
}
const rel = (full) => path.relative(project, full).replaceAll('\\', '/');
export async function buildInventory(output, cases = []) {
  const supplemental = [];
  for (const file of ['ui-grouped-route-results.json', 'ui-enhancer-results.json', 'ui-performance-results.json', 'ui-custom-modal-after.json']) {
    const report = await readFile(path.join(output, file), 'utf8').then(JSON.parse).catch(() => undefined);
    if (report?.cases) supplemental.push(...report.cases.map((item) => ({ ...item,
      evidenceLevel: file.includes('grouped') ? 'route-body-rendered' : file.includes('enhancer') ? 'enhancer-local-dom-assertion' : 'actual-ui-assertion' })));
  }
  const themeReport = await readFile(path.join(output, 'ui-focus-theme-after-probe.json'), 'utf8').then(JSON.parse).catch(() => undefined);
  if (themeReport?.themes) supplemental.push(...themeReport.themes.map((theme) => ({ id: `theme-contrast-${theme.theme.id}`, status: theme.status,
    evidenceLevel: 'actual-ui-assertion', sources: ['src/components/middle/message/Message.tsx', 'src/components/middle/message/MessageMeta.tsx', 'src/components/common/embedded/EmbeddedMessage.tsx'] })));
  cases = [...cases.map((item) => ({ ...item, evidenceLevel: 'actual-ui-assertion' })), ...supplemental];

  const files = (await filesUnder(path.join(project, 'src/components')))
    .filter((file) => file.endsWith('.tsx') && !/\.(async|test)\.tsx$/.test(file));
  const types = await readFile(path.join(project, 'src/types/index.ts'), 'utf8');
  const routeEnums = {};
  for (const match of types.matchAll(/export enum (SettingsScreens|LeftColumnContent|RightColumnContent|ManagementScreens|GlobalSearchContent)\s*\{([^}]+)\}/g)) {
    routeEnums[match[1]] = match[2].replace(/\/\/[^\n]*/g, '').split(',').map((value) => value.trim()).filter(Boolean);
  }
  const inventory = [];
  for (const full of files.sort()) {
    const source = await readFile(full, 'utf8');
    const file = rel(full); const name = path.basename(full, '.tsx');
    const category = file.includes('/settings/') ? 'settings' : file.includes('/auth/') ? 'authentication'
      : file.includes('/multi/') ? 'relay-social' : name.includes('Modal') || name.endsWith('Dialog') ? 'modal'
        : file.includes('/management/') ? 'management' : file.includes('/mediaViewer/') ? 'media-viewer'
          : file.includes('/composer/') ? 'composer' : file.includes('/story/') ? 'stories'
            : file.includes('/calls/') ? 'calls' : file.includes('/payment/') ? 'payment'
              : file.includes('/ui/') || file.includes('/gili/') ? 'shared-ui' : 'app-component';
    const evidence = cases.filter((item) => item.sources?.includes(file));
    inventory.push({ id: `ui-source:${file}`, name, file, category,
      sha256: createHash('sha256').update(source).digest('hex'),
      componentReferences: [...new Set([...source.matchAll(/<([A-Z][\w.]*)\b/g)].map((match) => match[1]))],
      interactionCount: [...source.matchAll(/\bon(?:Click|Change|KeyDown|Submit|Close|Select)\s*=/g)].length,
      loadingBranches: [...source.matchAll(/\b(?:isLoading|isBusy|error|isDisabled|disabled)\b/g)].length,
      coverage: evidence.length ? evidence.some((item) => item.status === 'pass' && item.evidenceLevel === 'actual-ui-assertion') ? 'actual-ui-scenario' : evidence.some((item) => item.status === 'pass') ? 'actual-component-route-rendered' : evidence.some((item) => item.status === 'fail') ? 'attempted-ui-failed' : 'attempted-ui-gated'
        : 'source-inventoried-only', scenarioIds: evidence.map((item) => item.id), evidenceLevels: [...new Set(evidence.filter((item) => item.status === 'pass').map((item) => item.evidenceLevel))],
      gate: evidence.length ? undefined : category === 'authentication' ? 'auth-step fixture not exercised; no real login/account changes'
        : ['payment', 'calls', 'stories', 'management'].includes(category) ? 'requires matching synthetic entity, permission and state fixture'
          : 'no rendered evidence for this exact component; catalogue membership is not functional verification',
    });
  }
  for (const file of ['scripts/x-enhancer.js', 'scripts/instagram-enhancer.js', 'scripts/social-share-enhancer.js']) {
    const source = await readFile(path.join(project, file), 'utf8');
    const evidence = cases.filter((item) => item.sources?.includes(file));
    inventory.push({ id: `ui-source:${file}`, name: path.basename(file), file, category: 'first-party-enhancer',
      sha256: createHash('sha256').update(source).digest('hex'),
      coverage: evidence.some((item) => item.status === 'pass') ? 'actual-enhancer-local-fixture' : 'source-inventoried-only',
      scenarioIds: evidence.map((item) => item.id),
      gate: 'local DOM fixture does not establish all live first-party pages or account permissions',
    });
  }
  const manifest = { schemaVersion: 1, artifactId: 'relay-ui-scenario-audit-2026-10-02', generatedAt: new Date().toISOString(),
    projectPath: project, version: JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version,
    scope: 'Full source catalogue with per-component evidence levels; actual App with existing synthetic Telegram backend and task-only Tauri transport',
    routeEnums, inventory, routeCoverage: cases.filter((item) => item.evidenceLevel === 'route-body-rendered').map(({ id, group, requested, reached, status, detail, sources }) => ({ id, group, requested, reached, status, sources, screenshot: detail?.screenshot, gateReason: detail?.gateReason })),
    counts: { components: inventory.length, categories: Object.fromEntries([...new Set(inventory.map((item) => item.category))]
      .map((category) => [category, inventory.filter((item) => item.category === category).length])),
      renderedEvidenceComponents: inventory.filter((item) => item.coverage === 'actual-ui-scenario').length,
      routeRenderedComponents: inventory.filter((item) => item.coverage === 'actual-component-route-rendered').length,
      gatedComponents: inventory.filter((item) => item.coverage === 'attempted-ui-gated').length,
      sourceOnlyComponents: inventory.filter((item) => item.coverage === 'source-inventoried-only').length },
    uncoveredGates: ['Live X/Instagram account surfaces, DM/search/privacy/create/media playback rely on first-party UI; only enhancer fixtures below are covered',
      'Real uploads, CDN downloads, delivery, account changes and calls are outside synthetic transport evidence',
      'Physical Windows DPI, GPU/compositor performance, touch hardware and screen reader output are not certified by Chromium emulation',
      'Every source component is enumerated; source-only rows are deliberately not labelled passed'],
  };
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'ui-coverage-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
