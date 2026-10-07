import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { assertSafeRelative, requireCondition, validateRuntime } from './release-policy.mjs';
import { readBoundedBody, validateArchiveEntry } from './release-runtime-archive.mjs';

// CI accepts only a reviewed public GitHub release archive, never a personal installer.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = (await import('./release-runtime-manifest.json', { with: { type: 'json' } })).default;
try {
  let exists = false;
  try { await access(path.join(root, 'runtime')); exists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!exists) {
    const expectedHash = process.env.RELAY_PUBLIC_RUNTIME_SHA256 || '';
    requireCondition(/^[a-f0-9]{64}$/.test(expectedHash), 'CI needs reviewed RELAY_PUBLIC_RUNTIME_SHA256');
    let url = process.env.RELAY_PUBLIC_RUNTIME_URL || ''; let response;
    for (let redirects = 0; redirects < 5; redirects += 1) {
      const parsed = new URL(url);
      requireCondition(parsed.protocol === 'https:' && !parsed.username && !parsed.password
        && ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname),
      'CI runtime URL must be a public HTTPS GitHub release without credentials');
      response = await fetch(parsed, { redirect: 'manual', signal: globalThis.AbortSignal.timeout(600000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        url = new URL(response.headers.get('location'), parsed).href; await response.body?.cancel(); continue;
      }
      requireCondition(response.ok, `Public runtime download failed (HTTP ${response.status})`); break;
    }
    requireCondition(response?.ok, 'Public runtime download exceeded redirect limit');
    const limit = manifest.files.reduce((total, file) => total + file.bytes + 65536, 1048576);
    const data = await readBoundedBody(response.body, limit, response.headers.get('content-length'));
    requireCondition(createHash('sha256').update(data).digest('hex') === expectedHash,
      'Public runtime archive checksum mismatch');
    const expected = new Map(manifest.files.map((entry) => [entry.path, entry])); const seen = new Set();
    const files = unzipSync(data, { filter: (entry) => validateArchiveEntry(entry, expected, seen) });
    requireCondition(Object.keys(files).length === expected.size, 'Runtime archive contains unexpected entries');
    // Validate every entry before writing a single file.
    for (const [relative, bytes] of Object.entries(files)) {
      assertSafeRelative(relative); const entry = expected.get(relative);
      requireCondition(entry && bytes.length === entry.bytes && createHash('sha256').update(bytes).digest('hex') === entry.sha256,
        `Runtime archive entry rejected: ${relative}`);
    }
    for (const [relative, bytes] of Object.entries(files)) {
      const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' });
    }
  }
  await validateRuntime(root, manifest);
  process.stdout.write(`CI public runtime verified: ${manifest.files.length} files\n`);
} catch (error) { process.stderr.write(`CI runtime staging failed: ${error.message}\n`); process.exitCode = 1; }
