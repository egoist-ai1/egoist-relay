import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

import { initializeAuditBrowser, project, startAuditServer } from './relay-ui-audit.server.mjs';

const RUN_FILE = promisify(execFile);
const REPEATS = 3;
const DEFAULT_SAMPLES = 20;
const WARMUP_CYCLES = 3;
const SETTLE_MS = 180;
const READY_FRAMES = 2;
const SAMPLE_TIMEOUT_MS = 15000;
const DEFAULT_PORT = 1289;
const VIEWPORT = { width: 1920, height: 1080 };
const READING_VIEWPORT = { width: 1100, height: 800 };
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.scss', '.json', '.html', '.svg']);
const METRICS = [
  'open-chat-101', 'ctrl-j-saved-history', 'dispatch-saved-file-open', 'ctrl-j-close-history',
  'switch-x', 'switch-instagram', 'switch-telegram', 'ctrl-j-current', 'select-history', 'ctrl-j-close-after-section-switch',
];
const BROWSER_ARGS = [
  '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability',
];
const FILE_OPERATION_ID = '123e4567-e89b-42d3-a456-426614174001';
const CURRENT_OPERATION_ID = '123e4567-e89b-42d3-a456-426614174002';
const FIXTURE_TIME = 1791288000000;
const CONTRACT_SOURCES = [
  { name: 'Chrome DevTools Protocol: SystemInfo/ProcessInfo', checkedOn: '2026-10-06',
    url: 'https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json' },
  { name: 'Playwright: browser.newBrowserCDPSession', checkedOn: '2026-10-06',
    url: 'https://playwright.dev/docs/api/class-browser#browser-new-browser-cdp-session' },
  { name: 'Microsoft: Get-CimInstance', checkedOn: '2026-10-06',
    url: 'https://learn.microsoft.com/en-us/powershell/module/cimcmdlets/get-ciminstance?view=powershell-7.5' },
  { name: 'Microsoft: Get-Process', checkedOn: '2026-10-06',
    url: 'https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/get-process?view=powershell-7.5' },
  { name: 'Microsoft: Process.PrivateMemorySize64', checkedOn: '2026-10-06',
    url: 'https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.privatememorysize64?view=net-10.0' },
];
const LIMITATIONS = [
  'Headless installed Edge with real Relay components, existing MockClient and terminal native mocks',
  'Remote HTTP/WebSocket requests are aborted; native account transport, actual downloads and Telegram sends are not exercised',
  'Saved-file action dispatch reaches a synthetic registered receipt; no disk file or external app is opened',
  'CPU and private bytes describe the complete identified browser process tree, excluding Node/Vite and native Tauri processes',
  'Private bytes are endpoint snapshots; observed maximum of two snapshots is not a continuously measured peak',
  'RAF response timing is a headless browser observation, not physical GPU/DPI smoothness or a 60 fps claim',
  'Current installed dependencies and the same audit harness are used for both source snapshots',
  'APP_VERSION uses current candidate package.json for both arms; the baseline is a frozen source overlay, not the historical packaged runtime',
  'Both arms use the same isolated audit Vite configuration (configFile:false); optional support configs are hashed only when present and missing files are listed',
  'Three repeats establish observed spread on this host; they are not a population-level confidence interval',
];

await main();

async function main() {
  if (process.argv.includes('--help')) { printHelp(); return; }
  const outputInput = process.env.RELAY_FRONTEND_BENCHMARK_OUTPUT || process.env.RELAY_UI_AUDIT_OUTPUT;
  assert(outputInput && path.isAbsolute(outputInput), 'An absolute own task runtime output is required');
  const output = path.resolve(outputInput);
  const browserExecutable = process.env.RELAY_FRONTEND_BROWSER || process.env.RELAY_UI_AUDIT_BROWSER
    || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const work = path.join(output, runId);
  await mkdir(work, { recursive: true });
  const temporaryDirectory = path.join(work, 'temporary');
  await mkdir(temporaryDirectory, { recursive: true });
  process.env.TEMP = temporaryDirectory;
  process.env.TMP = temporaryDirectory;
  process.env.TMPDIR = temporaryDirectory;
  assert.equal(process.platform, 'win32', 'The process-tree collector requires Windows');
  if (process.argv.includes('--smoke')) { await runApiSmoke(work, browserExecutable); return; }
  assert.equal(process.env.RELAY_FRONTEND_BENCHMARK_READY, '1',
    'Root must confirm stable sources and quiet checks, then set RELAY_FRONTEND_BENCHMARK_READY=1');
  const baselineDirectory = process.env.RELAY_FRONTEND_BASELINE;
  assert(baselineDirectory && path.isAbsolute(baselineDirectory), 'RELAY_FRONTEND_BASELINE must name the frozen source directory');
  assert.notEqual(path.resolve(baselineDirectory), project, 'Baseline and candidate must be separate snapshots');
  const samples = Number(process.env.RELAY_FRONTEND_BENCHMARK_SAMPLES || DEFAULT_SAMPLES);
  assert(Number.isInteger(samples) && samples >= 10 && samples <= 100, 'Use 10-100 samples per metric per batch');
  const port = Number(process.env.RELAY_FRONTEND_BENCHMARK_PORT || DEFAULT_PORT);
  assert(Number.isInteger(port) && port > 1024 && port < 65530, 'Use a valid dedicated unprivileged port');
  const evidenceRoot = path.resolve(process.env.RELAY_FRONTEND_BENCHMARK_EVIDENCE
    || path.join(project, 'docs/frontend-cycle-2026-10-06/benchmark'));
  const evidence = path.join(evidenceRoot, runId);
  await mkdir(evidence, { recursive: true });
  const sourceIdentities = {
    baseline: await captureSourceIdentity(baselineDirectory),
    candidate: await captureSourceIdentity(project),
    harness: await captureHarnessIdentity(),
  };
  await writeJson(path.join(evidence, 'source-identities.json'), sourceIdentities);
  const report = {
    schemaVersion: 1, artifactId: 'relay-frontend-paired-benchmark', runId, generatedAt: new Date().toISOString(),
    status: 'running', projectPath: project, repetitions: REPEATS, samplesPerMetricPerBatch: samples,
    warmupCyclesPerBatch: WARMUP_CYCLES, metricIds: METRICS, sources: CONTRACT_SOURCES, limitations: LIMITATIONS,
    sourceIdentityFile: 'source-identities.json', sourceVersions: {
      baseline: sourceIdentities.baseline.packageVersion, candidate: sourceIdentities.candidate.packageVersion,
    }, sourceHashes: {
      baseline: sourceIdentities.baseline.sha256, candidate: sourceIdentities.candidate.sha256,
      harness: sourceIdentities.harness.sha256,
    }, environment: { platform: os.platform(), release: os.release(), node: process.version,
      processor: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, browser: path.basename(browserExecutable),
      headless: true, viewport: VIEWPORT, readingViewport: READING_VIEWPORT, rootFontSizePx: 16,
      theme: 'egoist-dark', locale: 'ru-RU', reducedMotion: 'no-preference', serviceWorkers: 'block',
      nativeMockDelayMs: 15, browserArgs: BROWSER_ARGS, appVersionMacro: sourceIdentities.candidate.packageVersion },
    methodology: {
      order: [['baseline', 'candidate'], ['candidate', 'baseline'], ['baseline', 'candidate']],
      response: `Capture input/API action performance.now() to ${READY_FRAMES} consecutive RAFs with visible target state`,
      aggregation: 'Per-batch median of each metric; median/min/max of three batch medians; raw samples retained',
      regressionFlag: 'Candidate median / baseline median >1.10 AND candidate minimum > baseline maximum across three repetitions',
      resources: 'Windows PID/PPID subtree from CDP browser PID; Get-Process CPU/PrivateMemorySize64; CDP CPU cross-check',
      resourceCoverage: 'CPU comparisons require unchanged complete process membership; missing/exited processes are explicitly gated',
    }, batches: [], comparisons: [],
  };
  try {
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      const order = repeat % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const variant of order) {
        console.log(`START ${variant} repeat ${repeat + 1}/${REPEATS}`);
        const batch = await runBatch({ variant, repeat: repeat + 1, samples, browserExecutable, port,
          work: path.join(work, `${repeat + 1}-${variant}`), evidence,
          baselineDirectory: variant === 'baseline' ? baselineDirectory : undefined });
        report.batches.push(batch);
        const currentIdentity = await captureSourceIdentity(project);
        assert.equal(currentIdentity.sha256, sourceIdentities.candidate.sha256,
          'Candidate sources changed during comparison; this run is invalid');
        assert.equal((await captureHarnessIdentity()).sha256, sourceIdentities.harness.sha256,
          'Audit harness changed during comparison; this run is invalid');
        await writeJson(path.join(evidence, 'results.json'), report);
        console.log(`DONE ${variant} repeat ${repeat + 1}: ${batch.totalMeasuredActions} measured actions, ${batch.errors.length} errors`);
      }
    }
    assert.equal((await captureSourceIdentity(baselineDirectory)).sha256, sourceIdentities.baseline.sha256,
      'Frozen baseline sources changed during comparison; this run is invalid');
    report.comparisons = buildComparisons(report.batches);
    report.status = 'completed';
    report.summary = { batches: report.batches.length, actions: report.batches.reduce((sum, batch) => sum + batch.totalMeasuredActions, 0),
      regressionsOutsideObservedSpread: report.comparisons.filter((metric) => metric.isRegressionOutsideSpread).map((metric) => metric.id),
      unavailableMetrics: report.comparisons.filter((metric) => metric.status !== 'complete').map((metric) => metric.id) };
  } catch (error) {
    report.status = 'invalid'; report.fatal = formatError(error); process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeJson(path.join(evidence, 'results.json'), report);
    await writeFile(path.join(evidence, 'README.md'), renderReport(report), 'utf8');
    console.log(JSON.stringify({ status: report.status, summary: report.summary, fatal: report.fatal,
      evidence: path.join(evidence, 'results.json') }));
  }
}

async function runBatch(config) {
  await mkdir(config.work, { recursive: true });
  const batch = { variant: config.variant, repeat: config.repeat, startedAt: new Date().toISOString(),
    errors: [], consoleErrors: [], blockedOrigins: {}, latency: {}, snapshots: [], totalMeasuredActions: 0 };
  const { server, url } = await startAuditServer(path.join(config.work, 'server'), config.port,
    { baselineDirectory: config.baselineDirectory });
  let context;
  try {
    context = await launchIsolatedBrowser(config.work, config.browserExecutable);
    const browser = context.browser(); assert(browser, 'Persistent context must expose its browser');
    batch.browserVersion = browser.version();
    const cdp = await browser.newBrowserCDPSession();
    const page = context.pages()[0] || await context.newPage(); page.setDefaultTimeout(SAMPLE_TIMEOUT_MS);
    await context.addInitScript(initializeAuditBrowser);
    const origin = new URL(url).origin;
    await context.route('**/*', (route) => {
      const requestOrigin = new URL(route.request().url()).origin;
      if (requestOrigin === origin) return route.continue();
      batch.blockedOrigins[requestOrigin] = (batch.blockedOrigins[requestOrigin] || 0) + 1;
      return route.abort();
    });
    await context.routeWebSocket('**/*', (socket) => {
      const requested = new URL(socket.url());
      if (requested.host === new URL(url).host) return socket.connectToServer();
      batch.blockedOrigins[requested.origin] = (batch.blockedOrigins[requested.origin] || 0) + 1;
      return socket.close();
    });
    page.on('pageerror', (error) => batch.errors.push(formatError(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') batch.consoleErrors.push(message.text().replace(/https?:\/\/\S+/g, '[url]').slice(0, 400));
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => window.__relayAudit?.state().currentUserId === '1'
      && window.__relayAudit.state().chatCount >= 2, undefined, { timeout: 90000 });
    await page.waitForFunction(() => !window.__relayNativeMock.media.isLocked, undefined, { timeout: 20000 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '16px'; document.documentElement.dir = 'ltr';
      window.__relayAudit.applyTheme('egoist-dark');
    });
    await settle(page);
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'RAF measurement needs a visible page');
    await installFrameSampler(page);
    for (let index = 0; index < WARMUP_CYCLES; index++) await runScenarioCycle(page);
    await settle(page);
    const windowsBefore = await captureBrowserResources(cdp);
    const cdpBefore = await readCdpProcesses(cdp);
    const measuredStartedAt = performance.now();
    for (let index = 0; index < config.samples; index++) {
      const samples = await runScenarioCycle(page);
      for (const [id, sample] of Object.entries(samples)) {
        (batch.latency[id] ||= []).push(sample); batch.totalMeasuredActions += 1;
      }
      if ((index + 1) % 5 === 0) console.log(`PROGRESS ${config.variant} ${config.repeat}: ${index + 1}/${config.samples} cycles`);
    }
    batch.measuredWallTimeMs = performance.now() - measuredStartedAt;
    const cdpAfter = await readCdpProcesses(cdp);
    const windowsAfter = await captureBrowserResources(cdp);
    batch.resources = summarizeResources(windowsBefore, windowsAfter, cdpBefore, cdpAfter);
    batch.latencySummary = Object.fromEntries(METRICS.map((id) => [id,
      summarizeNumbers(batch.latency[id].map((sample) => sample.responseMs))]));
    await captureSettledScreens(page, config, batch);
    const unhandled = await page.evaluate(() => window.__relayUnhandled);
    batch.errors.push(...unhandled.map((error) => formatError(error)));
    assert.deepEqual(batch.errors, [], 'Scenario produced page errors or unhandled rejections');
    return batch;
  } finally {
    batch.finishedAt = new Date().toISOString();
    await context?.close().catch(() => {});
    await server.close();
    await writeJson(path.join(config.evidence, `batch-${config.repeat}-${config.variant}.json`), batch);
  }
}

async function runScenarioCycle(page) {
  await page.evaluate(() => window.__relayAudit.openChat(undefined));
  await page.waitForFunction(() => window.__relayAudit.state().currentChatId === undefined);
  await settle(page);
  const values = {};
  values['open-chat-101'] = await measureAction(page, { type: 'chat', chatId: '101' },
    () => page.evaluate(() => { window.__relayFrontendBenchmark.start(); window.__relayAudit.openChat('101'); }));
  await seedOperations(page, [makeSavedOperation()]);
  await page.locator('[data-relay-app="telegram"]').focus();
  values['ctrl-j-saved-history'] = await measureAction(page, { type: 'history' }, () => page.keyboard.press('Control+j'), 'keydown');
  const previousActions = await page.evaluate(() => window.__relayNativeMock.media.fileActions.length);
  values['dispatch-saved-file-open'] = await measureAction(page, { type: 'file-action', count: previousActions },
    () => page.locator(`[data-operation-id="${FILE_OPERATION_ID}"]`).getByRole('button', { name: /Открыть файл|Open file/i }).click(), 'click');
  values['ctrl-j-close-history'] = await measureAction(page, { type: 'closed' }, () => page.keyboard.press('Control+j'), 'keydown');
  for (const app of ['x', 'instagram', 'telegram']) {
    values[`switch-${app}`] = await measureAction(page, { type: 'app', app },
      () => page.locator(`[data-relay-app="${app}"]`).click(), 'click');
  }
  await seedOperations(page, [makeSavedOperation(), makeCurrentOperation()]);
  await page.locator('[data-relay-app="telegram"]').focus();
  values['ctrl-j-current'] = await measureAction(page, { type: 'current' }, () => page.keyboard.press('Control+j'), 'keydown');
  values['select-history'] = await measureAction(page, { type: 'history' }, () => page.locator('#relay-operations-history').click(), 'click');
  values['ctrl-j-close-after-section-switch'] = await measureAction(page, { type: 'closed' }, () => page.keyboard.press('Control+j'), 'keydown');
  return values;
}

async function measureAction(page, goal, action, event) {
  await page.evaluate(({ goal, event }) => window.__relayFrontendBenchmark.arm(goal, event), { goal, event });
  await action();
  await page.waitForFunction(() => window.__relayFrontendBenchmark.result?.isDone, undefined, { polling: 'raf' });
  const sample = await page.evaluate(() => window.__relayFrontendBenchmark.result);
  assert(!sample.error, sample.error);
  assert(Number.isFinite(sample.responseMs) && sample.responseMs > 0, 'Positive browser response time is required');
  await settle(page);
  return sample;
}

async function installFrameSampler(page) {
  await page.evaluate(({ readyFrames, timeoutMs }) => {
    let pending;
    function isVisible(element) {
      if (!element || !element.getBoundingClientRect().width || !element.getBoundingClientRect().height) return false;
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.99) return false;
      }
      return true;
    }
    function isReady(goal) {
      const panel = document.querySelector('#relay-media-operations');
      if (goal.type === 'chat') return window.__relayAudit.state().currentChatId === goal.chatId
        && [...document.querySelectorAll('#MiddleColumn [data-message-id]')].some(isVisible);
      if (goal.type === 'app') return document.querySelector(`[data-relay-app="${goal.app}"]`)?.getAttribute('aria-current') === 'page'
        && window.__relayNativeMock.currentApp === goal.app;
      if (goal.type === 'closed') return !isVisible(panel) && window.__relayNativeMock.contentVisible;
      if (goal.type === 'file-action') return window.__relayNativeMock.media.fileActions.length > goal.count
        && isVisible(document.querySelector('[data-operation-id="123e4567-e89b-42d3-a456-426614174001"]'));
      const section = document.querySelector(goal.type === 'history' ? '#relay-operations-history' : '#relay-operations-current');
      const operation = document.querySelector(`[data-operation-id="${goal.type === 'history'
        ? '123e4567-e89b-42d3-a456-426614174001' : '123e4567-e89b-42d3-a456-426614174002'}"]`);
      return section?.getAttribute('aria-selected') === 'true' && isVisible(panel) && isVisible(operation);
    }
    window.__relayFrontendBenchmark = {
      result: undefined,
      arm(goal, event) {
        if (pending?.listener) window.removeEventListener(pending.event, pending.listener, true);
        pending = { goal, event, stable: 0, frames: 0, startedAt: undefined };
        window.__relayFrontendBenchmark.result = undefined;
        if (event) {
          pending.listener = (input) => {
            if (event === 'keydown' && !(input.ctrlKey && input.key.toLowerCase() === 'j')) return;
            window.__relayFrontendBenchmark.start();
          };
          window.addEventListener(event, pending.listener, { capture: true, once: event === 'click' });
        }
      },
      start() {
        if (pending.startedAt !== undefined) return;
        if (pending.listener) window.removeEventListener(pending.event, pending.listener, true);
        const sample = pending; sample.startedAt = performance.now();
        const tick = () => {
          const now = performance.now();
          sample.frames += 1;
          sample.stable = isReady(sample.goal) ? sample.stable + 1 : 0;
          if (sample.stable >= readyFrames || now - sample.startedAt > timeoutMs) {
            window.__relayFrontendBenchmark.result = { isDone: true, responseMs: now - sample.startedAt,
              observedFrames: sample.frames, readyFrames: sample.stable,
              error: sample.stable >= readyFrames ? undefined : `Target ${sample.goal.type} did not settle` };
            return;
          }
          window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);
      },
    };
  }, { readyFrames: READY_FRAMES, timeoutMs: SAMPLE_TIMEOUT_MS });
}

async function captureSettledScreens(page, config, batch) {
  await page.setViewportSize(READING_VIEWPORT);
  await page.evaluate(() => window.__relayAudit.openChat('101'));
  await page.waitForFunction(() => window.__relayAudit.state().currentChatId === '101');
  await seedOperations(page, [makeSavedOperation(), makeCurrentOperation()]);
  await settle(page, 350);
  await capture('reading');
  await page.locator('.MiddleHeader .chat-info-wrapper:visible').first().click();
  await page.locator('#RightColumn').waitFor({ state: 'attached' });
  await settle(page, 350);
  await capture('profile');
  await page.locator('[data-relay-app="telegram"]').focus();
  await page.keyboard.press('Control+j');
  await page.locator('#relay-media-operations').waitFor({ state: 'visible' });
  await settle(page, 350);
  await capture('profile-panel');

  async function capture(state) {
    const file = `${config.repeat}-${config.variant}-${state}-1100.png`;
    const geometry = await page.evaluate(() => {
      function rectangle(element) {
        if (!element) return undefined;
        const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const center = document.elementFromPoint(Math.min(window.innerWidth - 1, Math.max(0, x + width / 2)),
          Math.min(window.innerHeight - 1, Math.max(0, y + height / 2)));
        return { x, y, width, height, right, bottom, display: style.display, visibility: style.visibility,
          ariaHidden: element.getAttribute('aria-hidden'), inert: element.inert,
          hasUnobscuredCenter: Boolean(center && (element === center || element.contains(center))),
          horizontalOverflow: element.scrollWidth > element.clientWidth + 1 };
      }
      return { viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        serviceRail: rectangle(document.querySelector('[data-relay-app]')?.closest('nav')),
        left: rectangle(document.querySelector('#LeftColumn')), middle: rectangle(document.querySelector('#MiddleColumn')),
        composer: rectangle(document.querySelector('.Composer')), profile: rectangle(document.querySelector('#RightColumn')),
        operations: rectangle(document.querySelector('#relay-media-operations')), telegram: rectangle(document.querySelector('#relay-telegram-pane')),
        messages: document.querySelectorAll('#MiddleColumn [data-message-id]').length,
        currentChatId: window.__relayAudit.state().currentChatId };
    });
    await page.screenshot({ path: path.join(config.evidence, file) });
    batch.snapshots.push({ state, screenshot: file, geometry });
  }
}

async function launchIsolatedBrowser(work, browserExecutable) {
  await mkdir(path.join(work, 'downloads'), { recursive: true });
  return chromium.launchPersistentContext(path.join(work, 'browser-profile'), {
    headless: true, executablePath: browserExecutable, args: BROWSER_ARGS,
    downloadsPath: path.join(work, 'downloads'), tracesDir: path.join(work, 'traces'),
    viewport: VIEWPORT, colorScheme: 'dark', locale: 'ru-RU', serviceWorkers: 'block',
    reducedMotion: 'no-preference',
  });
}

async function captureBrowserResources(cdp) {
  const processes = await readCdpProcesses(cdp);
  const browserProcess = processes.find((entry) => entry.type === 'browser');
  assert(browserProcess, 'CDP must identify the exact launched browser PID');
  const windows = await readWindowsProcessTree(browserProcess.id);
  const treeIds = new Set(windows.processes.map((entry) => entry.pid));
  const missingCdpIds = processes.filter((entry) => !treeIds.has(entry.id)).map((entry) => entry.id);
  return { ...windows, cdpProcessIds: processes.map((entry) => entry.id), missingCdpIds,
    hasCompleteCoverage: windows.missingIds.length === 0 && missingCdpIds.length === 0 };
}

async function readCdpProcesses(cdp) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  assert(Array.isArray(processInfo) && processInfo.length, 'CDP process information is required');
  for (const entry of processInfo) {
    assert(Number.isSafeInteger(entry.id) && entry.id > 0 && Number.isFinite(entry.cpuTime) && entry.cpuTime >= 0,
      'Invalid CDP PID or cumulative CPU time');
  }
  return processInfo.map(({ type, id, cpuTime }) => ({ type, id, cpuTime }));
}

async function readWindowsProcessTree(browserProcessId) {
  assert(Number.isSafeInteger(browserProcessId) && browserProcessId > 0, 'A numeric browser PID is required');
  const command = `$ErrorActionPreference = 'Stop'
$browserProcessId = ${browserProcessId}
$processLinks = @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId FROM Win32_Process' -OperationTimeoutSec 10 | Select-Object ProcessId, ParentProcessId)
$treeProcessIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$treeProcessIds.Add($browserProcessId)
do {
  $countBefore = $treeProcessIds.Count
  foreach ($processLink in $processLinks) {
    if ($treeProcessIds.Contains([int]$processLink.ParentProcessId)) { [void]$treeProcessIds.Add([int]$processLink.ProcessId) }
  }
} while ($treeProcessIds.Count -gt $countBefore)
$selectedProcesses = @(Get-Process -Id @($treeProcessIds) -ErrorAction SilentlyContinue)
$treeRecords = @()
$missingIds = @()
foreach ($treeProcessId in $treeProcessIds) {
  $selectedProcess = $selectedProcesses | Where-Object Id -eq $treeProcessId | Select-Object -First 1
  if (!$selectedProcess) { $missingIds += $treeProcessId; continue }
  $processLink = $processLinks | Where-Object ProcessId -eq $treeProcessId | Select-Object -First 1
  $treeRecords += [pscustomobject]@{ pid=[int]$treeProcessId; parentPid=[int]$processLink.ParentProcessId; cpuSeconds=[double]$selectedProcess.CPU; privateBytes=[long]$selectedProcess.PrivateMemorySize64 }
}
[pscustomobject]@{ browserPid=$browserProcessId; observedAt=[DateTime]::UtcNow.ToString('o'); processes=@($treeRecords | Sort-Object pid); missingIds=@($missingIds) } | ConvertTo-Json -Depth 5 -Compress`;
  const startedAt = performance.now();
  const { stdout } = await RUN_FILE(process.env.RELAY_FRONTEND_POWERSHELL || 'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  const snapshot = JSON.parse(stdout.trim());
  assert(snapshot.processes.some((entry) => entry.pid === browserProcessId), 'Browser PID is missing from its own tree');
  assert(snapshot.processes.every((entry) => Number.isFinite(entry.cpuSeconds) && Number.isFinite(entry.privateBytes)),
    'Windows resource sample must contain CPU and private bytes');
  return { ...snapshot, probeWallTimeMs: performance.now() - startedAt,
    totalCpuSeconds: snapshot.processes.reduce((sum, entry) => sum + entry.cpuSeconds, 0),
    totalPrivateBytes: snapshot.processes.reduce((sum, entry) => sum + entry.privateBytes, 0) };
}

function summarizeResources(before, after, cdpBefore, cdpAfter) {
  const initialIds = before.processes.map((entry) => entry.pid);
  const finalIds = after.processes.map((entry) => entry.pid);
  const hasStableWindowsTree = equalIds(initialIds, finalIds);
  const hasStableCdpTree = equalIds(cdpBefore.map((entry) => entry.id), cdpAfter.map((entry) => entry.id));
  const hasCompleteCpuCoverage = before.hasCompleteCoverage && after.hasCompleteCoverage && hasStableWindowsTree;
  const windowsCpuSeconds = hasCompleteCpuCoverage ? after.totalCpuSeconds - before.totalCpuSeconds : undefined;
  const cdpCpuSeconds = hasStableCdpTree ? cdpAfter.reduce((sum, entry) => sum + entry.cpuTime, 0)
    - cdpBefore.reduce((sum, entry) => sum + entry.cpuTime, 0) : undefined;
  return { before, after, hasStableWindowsTree, hasStableCdpTree, hasCompleteCpuCoverage,
    windowsCpuSeconds, cdpCpuSeconds,
    endpointPrivateBytes: after.hasCompleteCoverage ? after.totalPrivateBytes : undefined,
    observedMaximumPrivateBytes: Math.max(before.totalPrivateBytes, after.totalPrivateBytes),
    note: 'Windows probe latency is included between cumulative snapshots; CDP CPU cross-check brackets only measured cycles. Missing/churned processes gate CPU comparison.' };
}

function buildComparisons(batches) {
  const metrics = METRICS.map((id) => compareNumbers(id, 'ms',
    batches.filter((batch) => batch.variant === 'baseline').map((batch) => batch.latencySummary[id].median),
    batches.filter((batch) => batch.variant === 'candidate').map((batch) => batch.latencySummary[id].median)));
  for (const [id, unit, property] of [
    ['browser-tree-cpu', 'seconds', 'windowsCpuSeconds'],
    ['browser-cdp-cpu-crosscheck', 'seconds', 'cdpCpuSeconds'],
    ['browser-tree-endpoint-private', 'bytes', 'endpointPrivateBytes'],
  ]) {
    const baseline = batches.filter((batch) => batch.variant === 'baseline').map((batch) => batch.resources[property]);
    const candidate = batches.filter((batch) => batch.variant === 'candidate').map((batch) => batch.resources[property]);
    metrics.push(compareNumbers(id, unit, baseline, candidate));
  }
  return metrics;
}

function compareNumbers(id, unit, baselineValues, candidateValues) {
  const hasCompleteData = baselineValues.length === REPEATS && candidateValues.length === REPEATS
    && [...baselineValues, ...candidateValues].every((value) => Number.isFinite(value) && value >= 0);
  if (!hasCompleteData) return { id, unit, status: 'incomplete', isRegressionOutsideSpread: false };
  const baseline = summarizeNumbers(baselineValues);
  const candidate = summarizeNumbers(candidateValues);
  const ratio = baseline.median > 0 ? candidate.median / baseline.median : undefined;
  return { id, unit, status: ratio === undefined ? 'zero-baseline' : 'complete', baseline, candidate, ratio,
    percentChange: ratio === undefined ? undefined : (ratio - 1) * 100,
    hasNonOverlappingSpread: candidate.min > baseline.max,
    isRegressionOutsideSpread: ratio !== undefined && ratio > 1.1 && candidate.min > baseline.max };
}

function summarizeNumbers(values) {
  assert(values.length && values.every(Number.isFinite), 'Nonempty finite observations are required');
  const sorted = [...values].sort((first, second) => first - second);
  const midpoint = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  return { count: sorted.length, median, min: sorted[0], max: sorted.at(-1),
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)], spread: sorted.at(-1) - sorted[0], values };
}

async function captureSourceIdentity(directory) {
  const files = {};
  async function visit(current, relative = '') {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name, 'en'))) {
      assert(!entry.isSymbolicLink(), 'Source identity cannot silently follow symbolic links');
      const source = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(path.join(current, entry.name), source);
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !/\.test\.tsx?$/.test(entry.name)) {
        const relativeSource = path.posix.join('src', source.split(path.sep).join('/'));
        files[relativeSource] = createHash('sha256').update(await readFile(path.join(current, entry.name))).digest('hex');
      }
    }
  }
  await visit(path.join(directory, 'src'));
  for (const source of ['package.json', 'package-lock.json']) {
    files[source] = createHash('sha256').update(await readFile(path.join(directory, source))).digest('hex');
  }
  const missingSupportSources = [];
  for (const source of ['vite.config.ts', 'tsconfig.json', 'tsconfig.base.json']) {
    try {
      files[source] = createHash('sha256').update(await readFile(path.join(directory, source))).digest('hex');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missingSupportSources.push(source);
    }
  }
  const packageJson = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  return { scope: 'All frontend source extensions under src, excluding tests, plus package/lock and any available optional support configs',
    fileCount: Object.keys(files).length, packageVersion: packageJson.version, missingSupportSources,
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

async function captureHarnessIdentity() {
  const files = {};
  const harnessNames = (await readdir(path.join(project, 'scripts')))
    .filter((name) => /^relay-ui-audit[.-]/.test(name) || name === 'relay-frontend-benchmark.mjs').sort();
  for (const name of harnessNames) {
    const source = `scripts/${name}`;
    files[source] = createHash('sha256').update(await readFile(path.join(project, source))).digest('hex');
  }
  const versions = {};
  for (const dependency of ['@playwright/test', 'playwright-core', 'vite']) {
    const source = `node_modules/${dependency}/package.json`;
    const bytes = await readFile(path.join(project, source));
    files[source] = createHash('sha256').update(bytes).digest('hex');
    versions[dependency] = JSON.parse(bytes.toString('utf8')).version;
  }
  return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), versions, files };
}

async function runApiSmoke(work, browserExecutable) {
  const report = { schemaVersion: 1, artifactId: 'relay-frontend-benchmark-api-smoke', generatedAt: new Date().toISOString(),
    isBenchmark: false, scope: 'about:blank API/collector and statistics contracts only; Relay and frozen baseline are not loaded',
    sources: CONTRACT_SOURCES, checks: [] };
  let context;
  try {
    assert.equal(compareNumbers('overlap', 'ms', [95, 100, 105], [99, 112, 114]).isRegressionOutsideSpread, false);
    assert.equal(compareNumbers('separated', 'ms', [95, 100, 105], [110, 111, 112]).isRegressionOutsideSpread, true);
    assert.equal(compareNumbers('missing', 'ms', [95, 100, 105], [110, undefined, 112]).status, 'incomplete');
    assert.equal(compareNumbers('zero', 'ms', [0, 0, 0], [10, 11, 12]).status, 'zero-baseline');
    report.checks.push({ id: 'statistics-overlap-separation-incomplete-zero', status: 'pass' });
    context = await launchIsolatedBrowser(work, browserExecutable);
    const browser = context.browser(); assert(browser, 'Persistent context must expose Browser');
    const cdp = await browser.newBrowserCDPSession();
    const snapshot = await captureBrowserResources(cdp);
    assert(snapshot.hasCompleteCoverage && snapshot.processes.length > 1);
    report.browserVersion = browser.version();
    report.checks.push({ id: 'cdp-browser-pid-and-windows-descendants', status: 'pass', browserPid: snapshot.browserPid,
      processCount: snapshot.processes.length, cdpProcessCount: snapshot.cdpProcessIds.length,
      fields: ['pid', 'parentPid', 'cpuSeconds', 'privateBytes'], commandLinesRead: false, profilePathsReported: false });
  } catch (error) { report.fatal = formatError(error); process.exitCode = 1; }
  finally {
    await context?.close().catch(() => {});
    await writeJson(path.join(work, 'api-smoke.json'), report);
    console.log(JSON.stringify(report));
  }
}

function makeSavedOperation() {
  return { id: FILE_OPERATION_ID, attempt: 1, revision: 1, kind: 'save', service: 'instagram',
    fileName: 'Набережная.jpg', sourceUrl: 'https://www.instagram.com/p/RelayBenchmark/', stage: 'completed',
    createdAt: FIXTURE_TIME, updatedAt: FIXTURE_TIME, completedAt: FIXTURE_TIME,
    files: [{ path: 'C:/RelayBenchmarkDownloads/Набережная.jpg', fileName: 'Набережная.jpg', mimeType: 'image/jpeg',
      size: 3145728, width: 3000, height: 2000 }] };
}

function makeCurrentOperation() {
  return { id: CURRENT_OPERATION_ID, attempt: 1, revision: 1, kind: 'save', service: 'instagram',
    fileName: 'Ролик.mp4', sourceUrl: 'https://www.instagram.com/reel/RelayBenchmark/', stage: 'downloading',
    createdAt: FIXTURE_TIME + 1, updatedAt: FIXTURE_TIME + 1, files: [],
    progress: { loaded: 12582912, total: 20971520, index: 0, count: 1 } };
}

async function seedOperations(page, operations) {
  await page.evaluate((values) => window.__relayNativeMock.media.seed(values, false), operations);
  await settle(page);
}

async function settle(page, delay = SETTLE_MS) {
  await page.waitForTimeout(delay);
  await page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => window.requestAnimationFrame(resolve)); });
}

function equalIds(first, second) {
  const firstSorted = [...first].sort((a, b) => a - b);
  const secondSorted = [...second].sort((a, b) => a - b);
  return firstSorted.length === secondSorted.length && firstSorted.every((id, index) => id === secondSorted[index]);
}

async function writeJson(file, value) {
  const temporary = `${file}.part`;
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

function formatError(error) {
  return String(error).split('\n')[0].replace(/(?:--user-data-dir|--crash-dumps-dir)=\S+/g, '[profile]').slice(0, 600);
}

function renderReport(report) {
  const lines = [
    '# Relay: paired browser benchmark', '',
    `Run: ${report.runId}. Status: **${report.status}**. ${report.repetitions} pairs, ${report.samplesPerMetricPerBatch} observations per metric per batch.`, '',
    'All comparisons use the same installed Edge, isolated profiles, existing synthetic fixture, viewport and warmup. This report makes no live-network, delivery-quality or physical GPU claim.', '',
    `Source package versions: baseline ${report.sourceVersions.baseline}, candidate ${report.sourceVersions.candidate}. Shared APP_VERSION macro: ${report.environment.appVersionMacro}.`, '',
    '| Metric | Baseline median [min; max] | Candidate median [min; max] | Ratio | >10% beyond spread |',
    '|---|---:|---:|---:|---|',
  ];
  for (const metric of report.comparisons) {
    const format = (summary) => summary ? `${summary.median.toFixed(3)} [${summary.min.toFixed(3)}; ${summary.max.toFixed(3)}] ${metric.unit}` : 'unavailable';
    lines.push(`| ${metric.id} | ${format(metric.baseline)} | ${format(metric.candidate)} | ${metric.ratio?.toFixed(3) || metric.status} | ${metric.isRegressionOutsideSpread ? 'FLAG: investigate' : metric.status === 'complete' ? 'No flag' : 'Unverified'} |`);
  }
  lines.push('', 'A flag requires ratio >1.10 and no overlap between the three candidate batch medians and three baseline batch medians. Absence of a flag is not proof of equality. Raw per-action observations and exact source identities accompany this report.', '',
    `CPU: ${report.methodology.resources}. CPU coverage: ${report.methodology.resourceCoverage}.`, '',
    'Private bytes describe endpoint snapshots. CPU Windows probes and CDP cross-check use different, explicitly recorded brackets; they must not be mixed into a single number.', '',
    '## Settled geometry at 1100 × 800', '');
  for (const batch of report.batches) {
    for (const snapshot of batch.snapshots) lines.push(`- ${batch.variant} repeat ${batch.repeat}, ${snapshot.state}: [image](${snapshot.screenshot}), geometry in batch-${batch.repeat}-${batch.variant}.json`);
  }
  lines.push('', '## Limits', '', ...report.limitations.map((limitation) => `- ${limitation}`), '', '## Contract sources', '',
    ...report.sources.map((source) => `- [${source.name}](${source.url}), checked ${source.checkedOn}`), '',
    'Reproduction: set RELAY_FRONTEND_BASELINE, RELAY_FRONTEND_BENCHMARK_OUTPUT and RELAY_FRONTEND_BENCHMARK_READY=1 after stabilizing sources and stopping parallel checks, then run `node scripts/relay-frontend-benchmark.mjs`.', '',
    'The source overlay changes product source only; both arms use the current audit harness and installed dependencies. results.json retains data; source-identities.json records the exact inputs.');
  if (report.fatal) lines.push('', `Invalid run: ${report.fatal}`);
  return `${lines.join('\n')}\n`;
}

function printHelp() {
  console.log(`Relay paired frontend benchmark (Windows/headless Edge)
Required: RELAY_FRONTEND_BASELINE=<frozen source directory>, RELAY_FRONTEND_BENCHMARK_OUTPUT=<own task work>, RELAY_FRONTEND_BENCHMARK_READY=1
Optional: RELAY_FRONTEND_BROWSER, RELAY_FRONTEND_BENCHMARK_EVIDENCE, RELAY_FRONTEND_BENCHMARK_PORT (1289), RELAY_FRONTEND_BENCHMARK_SAMPLES (20)
Frozen directory must contain src/, package.json and package-lock.json. Optional Vite/TS configs are hashed when present; missingSupportSources records absence.
Run only after source stabilization and quieting other checks. Three pairs alternate order; source changes invalidate the result.
The baseline is a source overlay with shared current dependencies/harness/APP_VERSION and isolated Vite configFile:false, not a historical installed runtime.
Outputs: raw samples, three-repeat medians/ranges/ratios, process-tree coverage and settled reading/profile/panel geometry/screens.
A >10% regression is flagged only when the three observed median ranges do not overlap.
--smoke validates browser CDP, the exact Windows PID tree and statistics on about:blank; it never loads Relay or baseline.
--help prints this contract without launching a browser or reading baseline.`);
}
