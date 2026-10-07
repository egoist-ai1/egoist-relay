import { chromium } from 'playwright';

async function capture() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1240, height: 840 },
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  page.on('console', (msg) => {
    console.log('[Browser Console]', msg.type(), msg.text());
  });

  page.on('pageerror', (err) => {
    console.error('[Browser Error]', err.message);
  });

  console.log('Navigating to http://localhost:1234...');
  await page.goto('http://localhost:1234', { waitUntil: 'networkidle', timeout: 15000 }).catch((e) => {
    console.log('Navigation wait caught:', e.message);
  });

  await page.waitForTimeout(3000);

  const screenshotPath = 'C:\\Users\\Egoist\\.gemini\\antigravity\\brain\\4ff9024b-109b-4a67-8989-aeb4844ccf59\\preview.png';
  await page.screenshot({ path: screenshotPath });
  console.log('Screenshot saved to', screenshotPath);

  await browser.close();
}

capture().catch((err) => {
  console.error('Capture error:', err);
  process.exit(1);
});
