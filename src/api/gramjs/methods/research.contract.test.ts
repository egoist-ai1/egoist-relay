// The research bridge lives in four files written in two languages; this test keeps their shared lists equal
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { RELAY_RESEARCH_FEATURES, RELAY_RESEARCH_MAX_PARALLEL, RELAY_RESEARCH_OPERATIONS } from './research';

function read(path: string) {
  return readFileSync(path, 'utf8');
}

function quoted(source: string) {
  return [...source.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

const bridge = read('src/util/relayResearchBridge.ts');
const helper = read('runtime/research/bridge-server.mjs');
const rust = read('tauri/src/research_bridge.rs');

describe('research bridge contract', () => {
  test('the Telegram operations are the same in the worker, the renderer bridge, the helper and Rust', () => {
    const operations = [...RELAY_RESEARCH_OPERATIONS].sort();
    const rendererBlock = /const OPERATIONS: Operation\[\] = \[([\s\S]*?)\];/.exec(bridge)![1];
    expect(quoted(rendererBlock).sort()).toEqual(operations);
    const helperBlock = /telegram: \[([\s\S]*?)\],\n\s*x:/.exec(helper)![1];
    expect(quoted(helperBlock).sort()).toEqual(operations);
    const rustBlock = /"telegram" => \{([\s\S]*?)\n\s*\}\n\s*"x"/.exec(rust)![1];
    const rustOperations = [...rustBlock.matchAll(/"([a-z_]+)"/g)].map((match) => match[1])
      .filter((name) => name !== 'common');
    const common = ['discover', 'read', 'search', 'channel_history', 'chat_export', 'download'];
    expect([...new Set([...rustOperations, ...common])].sort()).toEqual(operations);
  });

  test('every layer allows the same number of parallel Telegram runs', () => {
    expect(RELAY_RESEARCH_MAX_PARALLEL).toBe(3);
    expect(bridge).toContain('const MAX_PARALLEL_TELEGRAM = 3;');
    expect(helper).toContain('telegram: 3, x: 1, instagram: 1');
    expect(rust).toContain('const MAX_TELEGRAM_RUNS: usize = 3;');
  });

  test('advertised features are short identifiers within the native limit', () => {
    expect(RELAY_RESEARCH_FEATURES.length).toBeLessThanOrEqual(16);
    expect(RELAY_RESEARCH_FEATURES.every((feature) => /^[a-z0-9_]{1,32}$/.test(feature))).toBe(true);
    expect(rust).toContain('const MAX_FEATURES: usize = 16;');
  });

  test('the raw chunk command has its own permission and a main-only capability', () => {
    expect(read('tauri/build.rs')).toContain('"relay_research_media_chunk"');
    expect(read('tauri/src/lib.rs')).toContain('research_bridge::relay_research_media_chunk');
    const permissions = read('tauri/permissions/research-bridge.toml');
    expect(permissions).toContain('identifier = "relay-research-media"');
    expect(permissions).toContain('commands.allow = ["relay_research_media_chunk"]');
    const capability = JSON.parse(read('tauri/capabilities/research-media-main.json')) as {
      local: boolean; webviews: string[]; permissions: string[];
    };
    expect(capability).toMatchObject({ local: true, webviews: ['main'], permissions: ['relay-research-media'] });
    const defaults = read('tauri/capabilities/default.json');
    expect(defaults).not.toContain('relay-research-media');
  });

  test('the header names of the raw chunk are the ones Rust reads', () => {
    for (const name of ['x-request-id', 'x-nonce', 'x-media-id', 'x-sequence']) {
      expect(bridge).toContain(`'${name}'`);
      expect(rust).toContain(`"${name}"`);
    }
  });
});
