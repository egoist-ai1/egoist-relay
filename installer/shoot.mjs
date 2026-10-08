// Снимки интерфейса установщика: Edge headless по тому же ui/index.html (режим предпросмотра без оболочки).
// Запуск: node installer/shoot.mjs <папка вывода>
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const page = path.resolve(import.meta.dirname, 'ui/index.html');
const out = path.resolve(process.argv[2] || 'shots');
mkdirSync(out, { recursive: true });
const states = [
  ['01-welcome', 'state=welcome'],
  ['02-welcome-update', 'state=welcome&existing=1.7.0&mode=update'],
  ['03-verify', 'state=verify'],
  ['04-prepare', 'state=prepare'],
  ['05-progress', 'state=progress&pct=62'],
  ['06-prompt-close-app', 'state=prompt'],
  ['07-error', 'state=error'],
  ['08-done', 'state=done'],
  ['09-done-launched', 'state=done&launched=1&existing=1.7.0'],
  ['10-license', 'state=license'],
];
for (const theme of ['dark', 'light']) for (const [name, q] of states) {
  const file = path.join(out, `${name}-${theme}.png`);
  const url = `${pathToFileURL(page).href}?${q}&theme=${theme}`;
  const r = spawnSync(edge, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=720,460',
    '--virtual-time-budget=2500', `--screenshot=${file}`, url], { encoding: 'utf8', timeout: 60000 });
  console.log(name, theme, r.status, r.error?.message ?? '');
}
