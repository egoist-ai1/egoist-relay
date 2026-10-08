/* eslint-disable @typescript-eslint/require-await */
// Fixtures model immediate promises at the Tauri and worker boundaries
import { beforeAll, describe, expect, test, vi } from 'vitest';

import type { RelayResearchArgs, RelayResearchEvent } from '../api/gramjs/methods/research';

import { startRelayResearchBridge } from './relayResearchBridge';

type Handler = (event: { payload: Record<string, unknown> }) => void;
type Call = { command: string; args: unknown; options?: { headers?: Record<string, string> } };

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: Record<string, unknown> }) => void>(),
  calls: [] as Array<{ command: string; args: unknown; options?: { headers?: Record<string, string> } }>,
  worker: vi.fn<(args: RelayResearchArgs) => Promise<{ events: RelayResearchEvent[]; isFinished: boolean }>>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: Handler) => {
    mocks.handlers.set(name, handler);
    return () => undefined;
  },
}));
Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args?: unknown, options?: Call['options']) => {
      mocks.calls.push({ command, args, options });
    },
  },
});
vi.mock('../global', () => ({
  getGlobal: () => ({ auth: { state: 'authorizationStateReady' } }),
}));
vi.mock('../api/gramjs', () => ({
  callApi: (_name: string, args: RelayResearchArgs) => mocks.worker(args),
}));

const NONCE = 'a'.repeat(64);
const ACCOUNT = { accountRef: 'account', accountEpoch: 'epoch' };
const BYTES = Uint8Array.from([1, 2, 3, 4]);

function statusResult(extra: object = {}) {
  return {
    events: [{
      kind: 'status', providers: [{
        provider: 'telegram', state: 'ready', ...ACCOUNT, operations: [], maxConcurrent: 3,
        features: ['offset_date', 'media_spool'], ...extra,
      }],
    }],
    isFinished: true,
  };
}

function send(requestId: string, extra: object = {}) {
  mocks.handlers.get('relay-research-request')!({
    payload: {
      requestId, nonce: NONCE, method: 'run', provider: 'telegram', operation: 'download',
      input: { url: 'https://t.me/a/1' }, jobId: `job-${requestId}`, deadlineMs: 30000, expectedAccount: ACCOUNT,
      ...extra,
    },
  });
}

async function settle(requestId: string) {
  await vi.waitFor(() => {
    const replies = mocks.calls.filter((call) => call.command === 'relay_research_reply'
      && (call.args as { requestId: string }).requestId === requestId);
    expect(replies.some((call) => ['done', 'error'].includes((call.args as { event: { kind: string } }).event.kind)))
      .toBe(true);
  });
}

function eventsOf(requestId: string) {
  return mocks.calls.filter((call) => call.command === 'relay_research_reply'
    && (call.args as { requestId: string }).requestId === requestId)
    .map((call) => (call.args as { event: RelayResearchEvent }).event);
}

beforeAll(async () => {
  await startRelayResearchBridge();
});

describe('relayResearchBridge', () => {
  test('registers once and tells native code it is ready', () => {
    expect(mocks.handlers.has('relay-research-request')).toBe(true);
    expect(mocks.handlers.has('relay-research-cancel')).toBe(true);
    expect(mocks.calls.some((call) => call.command === 'relay_research_ready')).toBe(true);
  });

  test('a status request forwards the slots and the features the worker advertises', async () => {
    mocks.worker.mockResolvedValue(statusResult());
    mocks.handlers.get('relay-research-request')!({
      payload: { requestId: 'status-1', nonce: NONCE, method: 'status', deadlineMs: 5000 },
    });
    await vi.waitFor(() => {
      expect(eventsOf('status-1')).toHaveLength(1);
    });
    const provider = (eventsOf('status-1')[0].providers as Array<Record<string, unknown>>)[0];
    expect(provider).toMatchObject({ maxConcurrent: 3, features: ['offset_date', 'media_spool'] });
    expect(provider.operations).toEqual(expect.arrayContaining(['probe', 'comments', 'topics', 'invite_preview']));
  });

  test('invalid slot counts and feature lists from the worker are dropped', async () => {
    mocks.worker.mockResolvedValue(statusResult({ maxConcurrent: 'many', features: ['Bad Name'] }));
    mocks.handlers.get('relay-research-request')!({
      payload: { requestId: 'status-2', nonce: NONCE, method: 'status', deadlineMs: 5000 },
    });
    await vi.waitFor(() => {
      expect(eventsOf('status-2')).toHaveLength(1);
    });
    const provider = (eventsOf('status-2')[0].providers as Array<Record<string, unknown>>)[0];
    expect(provider.maxConcurrent).toBeUndefined();
    expect(provider.features).toBeUndefined();
  });

  test('raw media pieces go to the native chunk command with their addressing headers, not as JSON', async () => {
    let step = 0;
    mocks.worker.mockImplementation(async (args) => {
      if (args.command === 'status') {
        return statusResult();
      }
      if (args.command === 'start') {
        return { events: [{ kind: 'scope', ...ACCOUNT }], isFinished: false };
      }
      step++;
      if (step === 1) {
        return { events: [{ kind: 'media_open', mediaId: 'media-1', sink: 'spool' }], isFinished: false };
      }
      if (step === 2) {
        return { events: [{ kind: 'media_chunk', mediaId: 'media-1', sequence: 0, bytes: BYTES }], isFinished: false };
      }
      return {
        events: [{ kind: 'done', outcome: 'results', count: 0, coverage: {} }], isFinished: true,
      };
    });
    send('media-1');
    await settle('media-1');
    const chunk = mocks.calls.find((call) => call.command === 'relay_research_media_chunk')!;
    expect(chunk.args).toBe(BYTES);
    expect(chunk.options!.headers).toEqual({
      'x-request-id': 'media-1', 'x-nonce': NONCE, 'x-media-id': 'media-1', 'x-sequence': '0',
    });
    const replies = eventsOf('media-1').map((event) => event.kind);
    expect(replies).toEqual(['status', 'scope', 'media_open', 'done']);
    expect(JSON.stringify(eventsOf('media-1'))).not.toContain('"bytes"');
  });

  test('a base64 chunk of the previous path still goes through the JSON reply', async () => {
    let step = 0;
    mocks.worker.mockImplementation(async (args) => {
      if (args.command === 'status') {
        return statusResult();
      }
      if (args.command === 'start') {
        return { events: [{ kind: 'scope', ...ACCOUNT }], isFinished: false };
      }
      step++;
      return step === 1
        ? { events: [{ kind: 'media_chunk', mediaId: 'm', sequence: 0, base64: 'AQIDBA==' }], isFinished: false }
        : { events: [{ kind: 'done', outcome: 'results', count: 0, coverage: {} }], isFinished: true };
    });
    send('json-1');
    await settle('json-1');
    expect(eventsOf('json-1').map((event) => event.kind)).toEqual(['status', 'scope', 'media_chunk', 'done']);
    expect(mocks.calls.filter((call) => call.command === 'relay_research_media_chunk'
      && call.options?.headers?.['x-request-id'] === 'json-1')).toHaveLength(0);
  });

  test('a rate limit error from the worker reaches native code with its seconds and kind', async () => {
    mocks.worker.mockImplementation(async (args) => {
      if (args.command === 'status') {
        return statusResult();
      }
      if (args.command === 'start') {
        return { events: [{ kind: 'scope', ...ACCOUNT }], isFinished: false };
      }
      return {
        events: [{
          kind: 'error', code: 'RATE_LIMITED', seconds: 31, waitKind: 'FLOOD_WAIT', retryAfterMs: 31000,
        }],
        isFinished: true,
      };
    });
    send('flood-1');
    await settle('flood-1');
    expect(eventsOf('flood-1').pop()).toMatchObject({
      kind: 'error', code: 'RATE_LIMITED', seconds: 31, waitKind: 'FLOOD_WAIT', retryAfterMs: 31000,
    });
  });

  test('three Telegram runs may be active together and the fourth is answered BUSY', async () => {
    const release: Array<() => void> = [];
    mocks.worker.mockImplementation(async (args) => {
      if (args.command === 'status') {
        return statusResult();
      }
      if (args.command === 'start') {
        return { events: [{ kind: 'scope', ...ACCOUNT }], isFinished: false };
      }
      if (args.command === 'cancel') {
        return { events: [], isFinished: true };
      }
      await new Promise<void>((resolve) => {
        release.push(resolve);
      });
      return { events: [{ kind: 'done', outcome: 'empty', count: 0, coverage: {} }], isFinished: true };
    });
    for (const id of ['par-1', 'par-2', 'par-3']) {
      send(id);
    }
    await vi.waitFor(() => {
      expect(release).toHaveLength(3);
    });
    send('par-4');
    await settle('par-4');
    expect(eventsOf('par-4')[0]).toMatchObject({ kind: 'error', code: 'BUSY' });
    release.splice(0).forEach((resolve) => resolve());
    for (const id of ['par-1', 'par-2', 'par-3']) {
      await settle(id);
      expect(eventsOf(id).pop()).toMatchObject({ kind: 'done', outcome: 'empty' });
    }
  });
});
