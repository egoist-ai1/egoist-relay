import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = (await readFile(new URL('../tauri/vendor/tauri/src/path/init.js', import.meta.url), 'utf8'))
  .replace('__TEMPLATE_sep__', JSON.stringify('\\')).replace('__TEMPLATE_delimiter__', JSON.stringify(';'));

test('path metadata initializes the existing native plugin object', () => {
  const window = { __TAURI_INTERNALS__: { plugins: {} } };
  vm.runInNewContext(source, { window });
  assert.equal(window.__TAURI_INTERNALS__.plugins.path.sep, '\\');
  assert.equal(window.__TAURI_INTERNALS__.plugins.path.delimiter, ';');
});

test('foreign frames without Tauri internals remain unchanged', () => {
  for (const window of [{}, { __TAURI_INTERNALS__: {} }]) {
    const before = JSON.stringify(window);
    assert.doesNotThrow(() => vm.runInNewContext(source, { window }));
    assert.equal(JSON.stringify(window), before);
  }
});
