import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const outDir = 'C:\\Users\\Egoist\\.gemini\\antigravity\\brain\\4ff9024b-109b-4a67-8989-aeb4844ccf59';

async function runAudit() {
  console.log('[Audit] Launching browser...');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  const auditReport = {
    checks: [],
    timestamp: new Date().toISOString(),
  };

  // Mock IS_TAURI environment if needed for titlebar
  await page.addInitScript(() => {
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = { plugins: {} };
    window.tauri = {
      version: '1.0.0',
      getCurrentWindow: async () => ({
        isMaximized: async () => false,
        minimize: async () => {},
        toggleMaximize: async () => {},
        close: async () => {},
        onResized: async () => () => {},
      }),
    };
  });

  console.log('[Audit] Navigating to http://localhost:1234...');
  await page.goto('http://localhost:1234', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // 1. Capture initial QR auth screen
  const qrScreenshotPath = path.join(outDir, 'audit_auth_qr.png');
  await page.screenshot({ path: qrScreenshotPath, fullPage: false });
  console.log('[Audit] Auth QR screen saved:', qrScreenshotPath);

  // Evaluate fonts and styles on Auth screen
  const authMetrics = await page.evaluate(() => {
    const bodyFont = window.getComputedStyle(document.body).fontFamily;
    const qrCanvas = document.querySelector('.qr-code-container, canvas, svg.qr-code, .auth-qr');
    const qrSize = qrCanvas ? { w: qrCanvas.clientWidth, h: qrCanvas.clientHeight } : null;
    const title = document.querySelector('h1, .auth-title, .title')?.textContent?.trim();
    return { bodyFont, qrSize, title };
  });
  console.log('[Audit] Auth screen metrics:', authMetrics);
  auditReport.checks.push({ name: 'Auth Screen', data: authMetrics });

  // 2. Click "Вход по номеру телефона" / switch auth mode if present
  const phoneBtn = await page.$('button:has-text("Вход по номеру телефона"), button:has-text("Log in by phone Number"), .btn-phone');
  if (phoneBtn) {
    console.log('[Audit] Clicking phone login button...');
    await phoneBtn.click();
    await page.waitForTimeout(2000);

    const phoneScreenshotPath = path.join(outDir, 'audit_auth_phone.png');
    await page.screenshot({ path: phoneScreenshotPath, fullPage: false });
    console.log('[Audit] Auth Phone screen saved:', phoneScreenshotPath);

    const phoneMetrics = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type,
        placeholder: i.placeholder,
        value: i.value,
        fontFamily: window.getComputedStyle(i).fontFamily,
      }));
      return { inputs };
    });
    auditReport.checks.push({ name: 'Phone Auth Screen', data: phoneMetrics });
  }

  // 3. Inspect Titlebar
  const titlebarMetrics = await page.evaluate(() => {
    const titlebarEl = document.querySelector('[class*="titlebar"]');
    if (!titlebarEl) return { found: false };
    const style = window.getComputedStyle(titlebarEl);
    const titleText = titlebarEl.querySelector('[class*="title"]')?.textContent?.trim();
    const versionText = titlebarEl.querySelector('[class*="version"]')?.textContent?.trim();
    const logoSvg = titlebarEl.querySelector('svg');
    const buttons = Array.from(titlebarEl.querySelectorAll('button')).map(b => b.title || b.getAttribute('aria-label'));
    return {
      found: true,
      titleText,
      versionText,
      hasLogo: Boolean(logoSvg),
      buttons,
      bg: style.backgroundColor,
      borderBottom: style.borderBottom,
    };
  });
  console.log('[Audit] Titlebar metrics:', titlebarMetrics);
  auditReport.checks.push({ name: 'Titlebar', data: titlebarMetrics });

  // 4. Test Badges styling directly by creating mock test elements with the exact classnames
  const badgeStyling = await page.evaluate(() => {
    // Check computed styles for active badge and normal badge
    const testActiveBadge = document.createElement('div');
    testActiveBadge.className = 'badge active';
    testActiveBadge.textContent = '12';
    document.body.appendChild(testActiveBadge);

    const testNormalBadge = document.createElement('div');
    testNormalBadge.className = 'badge unread';
    testNormalBadge.textContent = '5';
    document.body.appendChild(testNormalBadge);

    const activeStyle = window.getComputedStyle(testActiveBadge);
    const normalStyle = window.getComputedStyle(testNormalBadge);

    const result = {
      activeBadgeBg: activeStyle.backgroundColor,
      activeBadgeColor: activeStyle.color,
      normalBadgeBg: normalStyle.backgroundColor,
      normalBadgeColor: normalStyle.color,
    };

    testActiveBadge.remove();
    testNormalBadge.remove();
    return result;
  });
  console.log('[Audit] Badge styling:', badgeStyling);
  auditReport.checks.push({ name: 'Badge Contrast', data: badgeStyling });

  // 5. Test Audio API & MediaDevices
  const audioSupport = await page.evaluate(async () => {
    return {
      hasMediaDevices: typeof navigator.mediaDevices !== 'undefined',
      hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
      hasAudioContext: typeof window.AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined',
      hasMediaRecorder: typeof window.MediaRecorder !== 'undefined',
      supportedMimeTypes: {
        webmOpus: typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus'),
        oggOpus: typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/ogg;codecs=opus'),
        mp4: typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/mp4'),
      }
    };
  });
  console.log('[Audit] Audio/Microphone support:', audioSupport);
  auditReport.checks.push({ name: 'Microphone & Audio Support', data: audioSupport });

  // 6. Test Peer Colors definitions
  const peerColors = await page.evaluate(() => {
    const rootStyle = window.getComputedStyle(document.documentElement);
    const peerColorVars = [
      '--color-peer-1',
      '--color-peer-2',
      '--color-peer-3',
      '--color-peer-4',
      '--color-peer-5',
      '--color-peer-6',
      '--color-peer-7',
      '--color-peer-8',
    ].map(v => ({ var: v, value: rootStyle.getPropertyValue(v).trim() }));
    return peerColorVars;
  });
  console.log('[Audit] Peer colors:', peerColors);
  auditReport.checks.push({ name: 'Peer Colors', data: peerColors });

  // 7. Check absence of "Update Telegram" banner
  const updateBannerCheck = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, .btn, div'));
    const updateBtn = buttons.find(b => b.textContent?.includes('Обновить Telegram') || b.textContent?.includes('Update Telegram'));
    return {
      bannerFound: Boolean(updateBtn),
      bannerText: updateBtn ? updateBtn.textContent : null,
    };
  });
  console.log('[Audit] Update banner check:', updateBannerCheck);
  auditReport.checks.push({ name: 'Update Banner', data: updateBannerCheck });

  // Save report
  const reportPath = path.join(outDir, 'audit_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(auditReport, null, 2), 'utf-8');
  console.log('[Audit] Report written to', reportPath);

  await browser.close();
}

runAudit().catch(err => {
  console.error('[Audit Error]', err);
  process.exit(1);
});
