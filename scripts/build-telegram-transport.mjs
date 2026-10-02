import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const outfileIndex = process.argv.indexOf('--outfile');
const outfile = outfileIndex >= 0 ? process.argv[outfileIndex + 1] : undefined;
if (!outfile || !path.isAbsolute(outfile)) throw new Error('Expected --outfile with an absolute output path');
const require = createRequire(import.meta.url);
const licensePath = path.join(path.dirname(require.resolve('ws/package.json')), 'LICENSE');
const license = await readFile(licensePath, 'utf8');

await build({
  stdin: {
    contents: "import { runTelegramTransportChild } from './telegram-transport.mjs'; runTelegramTransportChild();",
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    sourcefile: 'telegram-transport-entry.mjs',
    loader: 'js',
  },
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  banner: { js: `/* WebSocket library (ws)\n${license.replaceAll('*/', '* /')}\n*/` },
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
  external: ['bufferutil', 'utf-8-validate'],
});
