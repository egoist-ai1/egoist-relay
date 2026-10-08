/* eslint-disable @typescript-eslint/require-await */
// Fixtures model immediate promises at the external API boundary
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Api as GramJs } from '../../../lib/gramjs';
import { FloodWaitError } from '../../../lib/gramjs/errors';

import type { RelayResearchArgs, RelayResearchEvent, RelayResearchInput } from './research';

import { buildApiPeerId } from '../apiBuilders/peers';
import localDb from '../localDb';
import { relayResearch } from './research';

const mocks = vi.hoisted(() => ({
  binding: { state: 'ready', accountRef: 'account', accountEpoch: 'epoch-0' },
  invoke: vi.fn<(request: object, signal: AbortSignal) => Promise<unknown>>(),
  downloadMedia: vi.fn<(message: object, params: { start: number; end: number }) => Promise<Uint8Array>>(),
}));

vi.mock('./client', () => ({
  createResearchController: () => new AbortController(),
  finishResearchController: vi.fn(),
  getClient: () => ({ downloadMedia: mocks.downloadMedia }),
  getResearchAccountBinding: () => ({ ...mocks.binding }),
  invokeResearchRequest: (request: object, signal: AbortSignal) => mocks.invoke(request, signal),
}));

const MIB = 1024 ** 2;
const DAY_MS = 86400000;
const CHANNEL_ID = 1000000001n;
const DISCUSSION_ID = 1000000002n;
const NEWEST_DATE = 2000000000;
type Route = [abstract new (...args: never[]) => object, (request: never) => unknown];
type Cursor = { offsetId: number; offsetDate: number; scope: string; offsetTopic?: number };
let testNumber = 0;

function construct<T>(Class: new (args: never) => T, args: object) {
  return new Class(args as never);
}

function respond(...routes: Route[]) {
  mocks.invoke.mockImplementation(async (request) => {
    const route = routes.find(([Class]) => request instanceof Class);
    if (!route) {
      throw new Error(`UNEXPECTED_${request.constructor.name}`);
    }
    return route[1](request as never);
  });
}

function makeChannel(id: bigint, username: string, extra: object = {}) {
  const channel = construct(GramJs.Channel, {
    id, accessHash: 77n, title: `Title ${username}`, username, date: 1, broadcast: true, ...extra,
  });
  localDb.chats[buildApiPeerId(id, 'channel')] = channel;
  return channel;
}

function resolveRoute(): Route {
  return [GramJs.contacts.ResolveUsername, (request: { username: string }) => {
    const id = request.username === 'testchan' ? CHANNEL_ID : BigInt(2000000000 + request.username.length * 7
      + [...request.username].reduce((sum, char) => sum + char.charCodeAt(0), 0));
    return construct(GramJs.contacts.ResolvedPeer, {
      peer: construct(GramJs.PeerChannel, { channelId: id }), chats: [makeChannel(id, request.username)], users: [],
    });
  }];
}

function makeMessage(id: number, date: number, channelId = CHANNEL_ID, extra: object = {}) {
  return construct(GramJs.Message, {
    id, date, peerId: construct(GramJs.PeerChannel, { channelId }), message: `message ${id}`, out: false, ...extra,
  });
}

function channelMessages(messages: GramJs.Message[], count = messages.length) {
  return construct(GramJs.messages.ChannelMessages, {
    pts: 1, count, messages, topics: [], chats: [], users: [],
  });
}

function historyRoute(total: number, onRequest?: (request: GramJs.messages.GetHistory) => void): Route {
  return [GramJs.messages.GetHistory, (request: GramJs.messages.GetHistory) => {
    onRequest?.(request);
    const page: GramJs.Message[] = [];
    for (let id = request.offsetId ? Math.min(request.offsetId - 1, total) : total;
      id > request.minId && page.length < request.limit; id--) {
      page.push(makeMessage(id, NEWEST_DATE - (total - id) * 60));
    }
    return channelMessages(page, total);
  }];
}

function floodError(seconds: number, errorMessage = `FLOOD_WAIT_${seconds}`) {
  return new FloodWaitError({
    errorMessage, capture: seconds, request: undefined, code: 420,
  });
}

function account(extra: object = {}) {
  return { accountRef: mocks.binding.accountRef, accountEpoch: mocks.binding.accountEpoch, ...extra };
}

let jobCounter = 0;
async function runJob(operation: NonNullable<RelayResearchArgs['operation']>, input: RelayResearchInput) {
  const jobId = `job-${testNumber}-${jobCounter++}`;
  const events: RelayResearchEvent[] = [];
  let result = await relayResearch({
    command: 'start', jobId, operation, input, expectedAccount: account(),
  });
  events.push(...result.events);
  while (!result.isFinished) {
    result = await relayResearch({ command: 'next', jobId, expectedAccount: account() });
    events.push(...result.events);
  }
  return events;
}

function last(events: RelayResearchEvent[]) {
  return events[events.length - 1];
}

function recordsOf(events: RelayResearchEvent[]) {
  return events.filter((event) => event.kind === 'records')
    .flatMap((event) => event.records as Array<Record<string, unknown>>);
}

function decodeCursor(value: unknown) {
  return JSON.parse(atob(String(value))) as Cursor;
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function joinBytes(parts: Uint8Array[]) {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  parts.forEach((part) => {
    joined.set(part, offset);
    offset += part.length;
  });
  return joined;
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

beforeEach(() => {
  testNumber++;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 0, 1) + testNumber * 2 * DAY_MS);
  mocks.binding.accountEpoch = `epoch-${testNumber}`;
  mocks.invoke.mockReset();
  mocks.downloadMedia.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('status and parallel runs', () => {
  test('status advertises operations, slots and features', async () => {
    const result = await relayResearch({ command: 'status' });
    const provider = (result.events[0].providers as Array<Record<string, unknown>>)[0];
    expect(provider.operations).toEqual(expect.arrayContaining([
      'channel_history', 'probe', 'comments', 'topics', 'similar_channels', 'invite_preview',
    ]));
    expect(provider.maxConcurrent).toBe(3);
    expect(provider.features).toEqual(expect.arrayContaining([
      'offset_date', 'min_id', 'probe', 'flood_wait', 'peer_cache', 'media_resume', 'media_spool',
    ]));
    expect((provider.features as string[]).length).toBeLessThanOrEqual(16);
  });

  test('three runs may be open together and the fourth is refused', async () => {
    const started = [];
    for (let index = 0; index < 3; index++) {
      const result = await relayResearch({
        command: 'start', jobId: `parallel-${testNumber}-${index}`, operation: 'channel_history',
        input: { channel: '@testchan' }, expectedAccount: account(),
      });
      expect(result.events[0].kind).toBe('scope');
      started.push(`parallel-${testNumber}-${index}`);
    }
    const refused = await relayResearch({
      command: 'start', jobId: `parallel-${testNumber}-3`, operation: 'channel_history',
      input: { channel: '@testchan' }, expectedAccount: account(),
    });
    expect(refused.events[0]).toMatchObject({ kind: 'error', code: 'BUSY' });
    await relayResearch({ command: 'cancel', jobId: started[0] });
    const again = await relayResearch({
      command: 'start', jobId: `parallel-${testNumber}-4`, operation: 'channel_history',
      input: { channel: '@testchan' }, expectedAccount: account(),
    });
    expect(again.events[0].kind).toBe('scope');
    for (const jobId of [...started.slice(1), `parallel-${testNumber}-4`]) {
      await relayResearch({ command: 'cancel', jobId });
    }
  });
});

describe('history parameters', () => {
  test('offsetDate and minId reach the first page, a cursor takes over afterwards', async () => {
    const requests: GramJs.messages.GetHistory[] = [];
    respond(resolveRoute(), historyRoute(450, (request) => requests.push(request)));
    const events = await runJob('channel_history', {
      channel: '@testchan', limit: 50, pageSize: 50, offsetDate: 1900000000, minId: 400,
    });
    expect(requests[0]).toMatchObject({ offsetId: 0, offsetDate: 1900000000, minId: 400, limit: 50 });
    expect(recordsOf(events)).toHaveLength(50);
    const done = last(events);
    expect(done).toMatchObject({ kind: 'done', outcome: 'partial', reason: 'ITEM_LIMIT' });
    const cursor = decodeCursor(done.nextCursor);
    expect(cursor.offsetId).toBe(401);
    const next = await runJob('channel_history', {
      channel: '@testchan', limit: 50, pageSize: 50, offsetDate: 1900000000, minId: 400,
      cursor: String(done.nextCursor),
    });
    expect(requests[1]).toMatchObject({ offsetId: 401, offsetDate: 0, minId: 400 });
    expect(last(next)).toMatchObject({ kind: 'done', outcome: 'empty', count: 0 });
  });

  test('minId ends the walk without a partial flag when fewer messages than a page remain', async () => {
    respond(resolveRoute(), historyRoute(450));
    const events = await runJob('channel_history', { channel: '@testchan', limit: 100, pageSize: 100, minId: 445 });
    expect(recordsOf(events).map((record) => record.messageId)).toEqual([450, 449, 448, 447, 446]);
    expect(last(events)).toMatchObject({ kind: 'done', outcome: 'results', count: 5, partial: false });
  });

  test('a date range without a cursor starts at before + 1, with a cursor it does not', async () => {
    const requests: GramJs.messages.GetHistory[] = [];
    respond(resolveRoute(), historyRoute(300, (request) => requests.push(request)));
    await runJob('channel_history', { channel: '@testchan', limit: 10, pageSize: 10, before: 1950000000 });
    expect(requests[0].offsetDate).toBe(1950000001);
    const second = requests.length;
    await runJob('channel_history', {
      channel: '@testchan', limit: 10, pageSize: 10, before: 1950000000, offsetDate: 1940000000,
    });
    expect(requests[second].offsetDate).toBe(1940000000);
    const third = requests.length;
    await runJob('channel_history', { channel: '@testchan', limit: 10, pageSize: 10 });
    expect(requests[third].offsetDate).toBe(0);
  });

  test('the old scan limit of 1000 messages is gone and a backstop of 20000 remains', async () => {
    let calls = 0;
    respond(resolveRoute(), [GramJs.messages.GetHistory, (request: GramJs.messages.GetHistory) => {
      calls++;
      const start = request.offsetId ? request.offsetId - 1 : 30000;
      const page = Array.from({ length: request.limit }, (_, index) => makeMessage(start - index, NEWEST_DATE));
      return channelMessages(page, 30000);
    }]);
    const events = await runJob('channel_history', { channel: '@testchan', limit: 1000, pageSize: 100, before: 1000 });
    expect(calls).toBe(200);
    expect(recordsOf(events)).toHaveLength(0);
    const done = last(events);
    expect(done).toMatchObject({ kind: 'done', outcome: 'partial', reason: 'SCAN_LIMIT', count: 0 });
    expect(decodeCursor(done.nextCursor).offsetId).toBe(30000 - 20000 + 1);
  });

  test('1500 messages pass in one job although more than 1000 are inspected', async () => {
    respond(resolveRoute(), historyRoute(1500));
    const events = await runJob('channel_history', { channel: '@testchan', limit: 1000, pageSize: 100 });
    expect(recordsOf(events)).toHaveLength(1000);
    expect(last(events)).toMatchObject({ outcome: 'partial', reason: 'ITEM_LIMIT' });
  });

  test('a request without the new fields asks Telegram exactly what the previous bridge asked', async () => {
    const requests: GramJs.messages.GetHistory[] = [];
    respond(resolveRoute(), historyRoute(450, (request) => requests.push(request)));
    await runJob('channel_history', { channel: '@testchan', limit: 20, pageSize: 20, after: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      offsetId: 0, offsetDate: 0, addOffset: 0, limit: 20, maxId: 0, minId: 0, hash: 0n,
    });
  });

  test('cursors issued without the new fields keep their scope hash', async () => {
    respond(resolveRoute(), historyRoute(450));
    const input = { channel: '@testchan', limit: 20, pageSize: 20 };
    const events = await runJob('channel_history', input);
    const cursor = decodeCursor(last(events).nextCursor);
    const legacyScope = createHash('sha256').update(JSON.stringify({
      operation: 'channel_history', query: undefined, channel: input.channel, scope: undefined, url: undefined,
      urls: undefined, topicId: undefined, after: undefined, before: undefined, includeMedia: undefined,
    })).digest('hex');
    expect(cursor.scope).toBe(legacyScope);
    const again = await runJob('channel_history', { ...input, cursor: String(last(events).nextCursor) });
    expect(again[0].kind).toBe('scope');
    expect(recordsOf(again)).toHaveLength(20);
    const other = await runJob('channel_history', { ...input, minId: 5, cursor: String(last(events).nextCursor) });
    expect(other[0]).toMatchObject({ kind: 'error', code: 'STALE_CURSOR' });
  });
});

describe('FLOOD_WAIT', () => {
  test('a wait is returned to the daemon with seconds and kind, never slept on', async () => {
    respond(resolveRoute(), [GramJs.messages.GetHistory, () => {
      throw floodError(31);
    }]);
    const events = await runJob('channel_history', { channel: '@testchan', limit: 20 });
    expect(last(events)).toMatchObject({
      kind: 'error', code: 'RATE_LIMITED', seconds: 31, waitKind: 'FLOOD_WAIT', retryAfterMs: 31000,
    });
  });

  test('premium and slow-mode waits keep their kind', async () => {
    respond(resolveRoute(), [GramJs.messages.GetHistory, () => {
      throw floodError(8, 'FLOOD_PREMIUM_WAIT_8');
    }]);
    expect(last(await runJob('channel_history', { channel: '@testchan' }))).toMatchObject({
      code: 'RATE_LIMITED', seconds: 8, waitKind: 'PREMIUM_FLOOD_WAIT',
    });
  });

  test('with partialOnFlood a delivered page is kept and the run ends with a checked cursor', async () => {
    let calls = 0;
    respond(resolveRoute(), [GramJs.messages.GetHistory, (request: GramJs.messages.GetHistory) => {
      calls++;
      if (calls === 2) {
        throw floodError(31);
      }
      return channelMessages(
        Array.from({ length: request.limit }, (_, index) => makeMessage(450 - index, NEWEST_DATE)), 450,
      );
    }]);
    const events = await runJob('channel_history', {
      channel: '@testchan', limit: 200, pageSize: 100, partialOnFlood: true,
    });
    expect(recordsOf(events)).toHaveLength(100);
    const done = last(events);
    expect(done).toMatchObject({
      kind: 'done', outcome: 'partial', partial: true, reason: 'FLOOD_WAIT', count: 100,
      floodWait: { seconds: 31, waitKind: 'FLOOD_WAIT' },
    });
    expect(decodeCursor(done.nextCursor).offsetId).toBe(351);
  });

  test('without a delivered page the wait is an error even with partialOnFlood', async () => {
    respond(resolveRoute(), [GramJs.messages.GetHistory, () => {
      throw floodError(12);
    }]);
    const events = await runJob('channel_history', { channel: '@testchan', partialOnFlood: true });
    expect(last(events)).toMatchObject({ kind: 'error', code: 'RATE_LIMITED', seconds: 12 });
  });

  test('a ceiling of the worker itself is reported as a budget wait', async () => {
    respond(resolveRoute(), [GramJs.messages.GetHistory, (request: GramJs.messages.GetHistory) => channelMessages([
      makeMessage(1, NEWEST_DATE, (request.peer as GramJs.InputPeerChannel).channelId),
    ])]);
    const kinds: Array<unknown> = [];
    for (let index = 0; index < 13; index++) {
      const events = await runJob('channel_history', { channel: `@chan${String(index).padStart(2, '0')}`, limit: 1 });
      kinds.push(last(events).kind === 'error' ? last(events) : undefined);
    }
    expect(kinds.slice(0, 12).every((value) => value === undefined)).toBe(true);
    expect(kinds[12]).toMatchObject({
      code: 'RATE_LIMITED', waitKind: 'RESOLVE_BUDGET', seconds: expect.any(Number),
    });
    vi.setSystemTime(Date.now() + 61000);
    const retry = await runJob('channel_history', { channel: '@chan12', limit: 1 });
    expect(last(retry).kind).not.toBe('error');
  });
});

describe('peer cache', () => {
  test('a name is resolved once per account epoch', async () => {
    let resolves = 0;
    const [Class, resolver] = resolveRoute();
    respond([Class, (request: never) => {
      resolves++;
      return resolver(request);
    }], historyRoute(10));
    await runJob('channel_history', { channel: '@testchan', limit: 1 });
    await runJob('channel_history', { channel: 'TESTCHAN', limit: 1 });
    await runJob('channel_history', { channel: 'https://t.me/testchan', limit: 1 });
    expect(resolves).toBe(1);
    mocks.binding.accountEpoch = `${mocks.binding.accountEpoch}-changed`;
    await runJob('channel_history', { channel: '@testchan', limit: 1 });
    expect(resolves).toBe(2);
  });
});

describe('probe', () => {
  function probeRoutes(searchRoute: Route): Route[] {
    return [
      resolveRoute(),
      [GramJs.channels.GetFullChannel, () => construct(GramJs.messages.ChatFull, {
        fullChat: construct(GramJs.ChannelFull, {
          id: CHANNEL_ID, participantsCount: 1234, adminsCount: 3, onlineCount: 50, linkedChatId: DISCUSSION_ID,
        }),
        chats: [makeChannel(CHANNEL_ID, 'testchan', { forum: true })], users: [],
      })],
      [GramJs.messages.GetHistory, () => channelMessages([makeMessage(4321, NEWEST_DATE)], 4321)],
      searchRoute,
    ];
  }

  function countingSearch(counts: Record<string, number>, calls: string[]): Route {
    return [GramJs.messages.Search, (request: GramJs.messages.Search) => {
      const kind = request.filter instanceof GramJs.InputMessagesFilterPhotos ? 'photo'
        : request.filter instanceof GramJs.InputMessagesFilterVideo ? 'video' : 'document';
      calls.push(`Search:${kind}:limit${request.limit}`);
      return construct(GramJs.messages.ChannelMessages, {
        pts: 1, count: counts[kind], inexact: kind === 'video' ? true : undefined,
        messages: [], topics: [], chats: [], users: [],
      });
    }];
  }

  test('counts of messages, members and media come without reading history', async () => {
    const calls: string[] = [];
    respond(...probeRoutes(countingSearch({ photo: 10, video: 20, document: 30 }, calls)));
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (request, signal) => {
      calls.push(request instanceof GramJs.contacts.ResolveUsername ? 'ResolveUsername'
        : request instanceof GramJs.channels.GetFullChannel ? 'GetFullChannel'
          : request instanceof GramJs.messages.GetHistory ? `GetHistory:limit${request.limit}` : '');
      return original(request, signal);
    });
    const events = await runJob('probe', { channel: '@testchan' });
    const [record] = recordsOf(events);
    expect(record).toMatchObject({
      type: 'telegram.probe', id: `probe:${buildApiPeerId(CHANNEL_ID, 'channel')}`,
      counts: {
        messages: 4321, participants: 1234, admins: 3, online: 50, photo: 10, video: 20, document: 30,
      },
      inexact: ['video'], newest: { messageId: 4321, date: NEWEST_DATE }, isForum: true, hasComments: true,
    });
    expect(last(events)).toMatchObject({ kind: 'done', outcome: 'results', count: 1, partial: false });
    expect(calls.filter(Boolean)).toEqual([
      'ResolveUsername', 'GetFullChannel', 'GetHistory:limit1', 'Search:photo:limit1', 'Search:video:limit1',
      'Search:document:limit1',
    ]);
    expect((record.counts as Record<string, number>).banned).toBeUndefined();
    expect(recordsOf(events)).toHaveLength(1);
  });

  test('missing counters make the record partial but keep the numbers that are known', async () => {
    respond(...probeRoutes([GramJs.messages.Search, () => {
      throw Object.assign(new Error('BAD'), { errorMessage: 'SEARCH_QUERY_EMPTY' });
    }]));
    const events = await runJob('probe', { channel: '@testchan' });
    expect((recordsOf(events)[0].counts as Record<string, number>).messages).toBe(4321);
    expect(last(events)).toMatchObject({ kind: 'done', outcome: 'partial', reason: 'COUNTERS_UNAVAILABLE' });
  });

  test('a wait during the counters stops the probe', async () => {
    respond(...probeRoutes([GramJs.messages.Search, () => {
      throw floodError(20);
    }]));
    expect(last(await runJob('probe', { channel: '@testchan' }))).toMatchObject({
      code: 'RATE_LIMITED', seconds: 20,
    });
  });
});

describe('comments, topics, similar channels and invites', () => {
  test('comments are read from the discussion group and linked to the post', async () => {
    const requests: GramJs.messages.GetReplies[] = [];
    makeChannel(DISCUSSION_ID, 'testchat', { megagroup: true, broadcast: undefined });
    respond(resolveRoute(), [GramJs.messages.GetReplies, (request: GramJs.messages.GetReplies) => {
      requests.push(request);
      return channelMessages([
        makeMessage(12, NEWEST_DATE, DISCUSSION_ID), makeMessage(11, NEWEST_DATE - 60, DISCUSSION_ID),
      ], 2);
    }]);
    const events = await runJob('comments', { url: 'https://t.me/testchan/77', limit: 10, pageSize: 10, minId: 5 });
    expect(requests[0]).toMatchObject({ msgId: 77, minId: 5, offsetId: 0 });
    const records = recordsOf(events);
    expect(records.map((record) => record.messageId)).toEqual([12, 11]);
    expect(records[0].id).toBe(`${buildApiPeerId(DISCUSSION_ID, 'channel')}:12`);
    expect(records[0].commentOn).toEqual({ peerId: buildApiPeerId(CHANNEL_ID, 'channel'), messageId: 77 });
    expect(last(events)).toMatchObject({ kind: 'done', outcome: 'results', count: 2 });
  });

  test('a comment whose chat is unknown to the account is access denied, not mixed into the channel', async () => {
    delete localDb.chats[buildApiPeerId(DISCUSSION_ID, 'channel')];
    respond(resolveRoute(), [GramJs.messages.GetReplies, () => channelMessages(
      [makeMessage(12, NEWEST_DATE, DISCUSSION_ID)],
    )]);
    expect(last(await runJob('comments', { url: 'https://t.me/testchan/77' }))).toMatchObject({
      kind: 'error', code: 'ACCESS_DENIED',
    });
  });

  test('forum topics page with a topic offset in the cursor', async () => {
    const requests: GramJs.messages.GetForumTopics[] = [];
    const topic = (id: number) => construct(GramJs.ForumTopic, {
      id, date: 100 + id, peer: construct(GramJs.PeerChannel, { channelId: CHANNEL_ID }), title: `Topic ${id}`,
      topMessage: id * 10,
    });
    respond(resolveRoute(), [GramJs.messages.GetForumTopics, (request: GramJs.messages.GetForumTopics) => {
      requests.push(request);
      const topics = request.offsetTopic ? [topic(8)] : [topic(10), topic(9)];
      return construct(GramJs.messages.ForumTopics, {
        count: 3, topics, messages: [makeMessage(90, 5000)], chats: [], users: [], pts: 1,
      });
    }]);
    const events = await runJob('topics', { channel: '@testchan', limit: 10, pageSize: 2, query: 'topic' });
    expect(recordsOf(events).map((record) => record.topicId)).toEqual([10, 9, 8]);
    expect(recordsOf(events)[0].id).toBe(`${buildApiPeerId(CHANNEL_ID, 'channel')}:topic:10`);
    expect(requests[0]).toMatchObject({ offsetTopic: 0, offsetId: 0, offsetDate: 0, limit: 2, q: 'topic' });
    expect(requests[1]).toMatchObject({ offsetTopic: 9, offsetId: 90, offsetDate: 5000, limit: 2 });
    expect(last(events)).toMatchObject({ kind: 'done', outcome: 'results', count: 3 });
  });

  test('similar channels come as chat records tied to the source', async () => {
    respond(resolveRoute(), [GramJs.channels.GetChannelRecommendations, () => construct(GramJs.messages.Chats, {
      chats: [makeChannel(3000000001n, 'similarone'), makeChannel(3000000002n, 'similartwo')],
    })]);
    const events = await runJob('similar_channels', { channel: '@testchan' });
    const records = recordsOf(events);
    expect(records.map((record) => record.type)).toEqual(['telegram.chat', 'telegram.chat']);
    expect(records[0].similarTo).toBe(buildApiPeerId(CHANNEL_ID, 'channel'));
    expect(last(events)).toMatchObject({ outcome: 'results', count: 2 });
  });

  test('an invite is previewed without joining and its hash never enters the record', async () => {
    const calls: string[] = [];
    respond([GramJs.messages.CheckChatInvite, () => {
      calls.push('CheckChatInvite');
      return construct(GramJs.ChatInvite, {
        title: 'Closed club', about: 'About', participantsCount: 10, channel: true, megagroup: true,
        participants: [], photo: construct(GramJs.PhotoEmpty, { id: 0n }), color: 0,
      });
    }]);
    const events = await runJob('invite_preview', { channel: 'https://t.me/+AbCdEfGhIjKl' });
    const [record] = recordsOf(events);
    expect(record).toMatchObject({
      type: 'telegram.invite_preview', membershipState: 'not_member', title: 'Closed club', participantsCount: 10,
      isMegagroup: true, isPublic: false, isPaid: false,
    });
    expect(calls).toEqual(['CheckChatInvite']);
    expect(JSON.stringify(events)).not.toContain('AbCdEfGhIjKl');
  });
});

describe('media', () => {
  const SIZE = 3 * MIB + 10;
  const CONTENT = Uint8Array.from({ length: SIZE }, (_, index) => (index * 7 + Math.floor(index / 4096)) % 251);

  function mediaRoutes(): Route[] {
    const document = construct(GramJs.Document, {
      id: 99n, accessHash: 1n, fileReference: new Uint8Array(), date: 1, mimeType: 'video/mp4', size: BigInt(SIZE),
      attributes: [], dcId: 2,
    });
    const message = makeMessage(5, NEWEST_DATE, CHANNEL_ID, {
      media: construct(GramJs.MessageMediaDocument, { document }),
    });
    mocks.downloadMedia.mockImplementation(async (_message, { start, end }) => CONTENT.slice(start, end + 1));
    return [resolveRoute(), [GramJs.channels.GetMessages, () => channelMessages([message])]];
  }

  function collectJsonBytes(events: RelayResearchEvent[]) {
    return joinBytes(events.filter((event) => event.kind === 'media_chunk')
      .map((event) => base64ToBytes(String(event.base64))));
  }

  test('a full download keeps the base64 chunks of the previous bridge', async () => {
    respond(...mediaRoutes());
    const events = await runJob('download', { url: 'https://t.me/testchan/5' });
    const open = events.find((event) => event.kind === 'media_open')!;
    expect(open).toMatchObject({ declaredBytes: SIZE });
    expect(open.resumeFrom).toBeUndefined();
    expect(open.sink).toBeUndefined();
    const chunks = events.filter((event) => event.kind === 'media_chunk');
    expect(chunks.map((chunk) => chunk.sequence)).toEqual(chunks.map((_, index) => index));
    expect(chunks.every((chunk) => typeof chunk.base64 === 'string' && chunk.bytes === undefined)).toBe(true);
    expect(sha256(collectJsonBytes(events))).toBe(sha256(CONTENT));
    expect(events.find((event) => event.kind === 'media_close')).toMatchObject({ totalBytes: SIZE });
  });

  test('a resumed download starts at the aligned offset and the joined file equals the original', async () => {
    respond(...mediaRoutes());
    const first = await runJob('download', { url: 'https://t.me/testchan/5' });
    const prefix = collectJsonBytes(first).slice(0, 2 * MIB);
    mocks.downloadMedia.mockClear();
    const resumed = await runJob('download', { url: 'https://t.me/testchan/5', resumeOffset: 2 * MIB });
    expect(mocks.downloadMedia.mock.calls.map(([, params]) => params.start)).toEqual([2 * MIB, 3 * MIB]);
    const open = resumed.find((event) => event.kind === 'media_open')!;
    expect(open).toMatchObject({ declaredBytes: SIZE, resumeFrom: 2 * MIB });
    expect(resumed.filter((event) => event.kind === 'media_chunk')[0].sequence).toBe(0);
    expect(resumed.find((event) => event.kind === 'media_close')).toMatchObject({ totalBytes: SIZE });
    const joined = joinBytes([prefix, collectJsonBytes(resumed)]);
    expect(joined.length).toBe(SIZE);
    expect(sha256(joined)).toBe(sha256(CONTENT));
  });

  test('the spool sink sends each piece as raw bytes with a fingerprint, never base64', async () => {
    respond(...mediaRoutes());
    const input = {
      url: 'https://t.me/testchan/5', mediaSink: 'spool' as const, mediaKey: '0123456789abcdef0123456789abcdef',
    };
    const events = await runJob('download', input);
    const open = events.find((event) => event.kind === 'media_open')!;
    expect(open.sink).toBe('spool');
    expect(String(open.fingerprint)).toMatch(/^[a-f0-9]{16}$/);
    const chunks = events.filter((event) => event.kind === 'media_chunk');
    expect(chunks.every((chunk) => chunk.bytes instanceof Uint8Array && chunk.base64 === undefined)).toBe(true);
    expect(chunks.map((chunk) => chunk.sequence)).toEqual([0, 1, 2, 3]);
    expect(sha256(joinBytes(chunks.map((chunk) => chunk.bytes as Uint8Array)))).toBe(sha256(CONTENT));
    const again = await runJob('download', input);
    expect(again.find((event) => event.kind === 'media_open')!.fingerprint).toBe(open.fingerprint);
    const resumed = await runJob('download', { ...input, resumeOffset: 2 * MIB });
    expect(resumed.find((event) => event.kind === 'media_open')).toMatchObject({
      resumeFrom: 2 * MIB, sink: 'spool', fingerprint: open.fingerprint,
    });
    expect(resumed.filter((event) => event.kind === 'media_chunk')).toHaveLength(2);
  });

  test('a resume point at or beyond the real size is a mismatch the daemon can act on', async () => {
    respond(...mediaRoutes());
    expect(last(await runJob('download', { url: 'https://t.me/testchan/5', resumeOffset: 4 * MIB }))).toMatchObject({
      kind: 'error', code: 'RESUME_MISMATCH',
    });
    expect(mocks.downloadMedia).not.toHaveBeenCalled();
  });
});

describe('input validation', () => {
  const cases: Array<[NonNullable<RelayResearchArgs['operation']>, RelayResearchInput | Record<string, unknown>]> = [
    ['channel_history', { channel: 'testchan', offsetDate: 0 }],
    ['channel_history', { channel: 'testchan', minId: 1.5 }],
    ['channel_history', { channel: 'testchan', partialOnFlood: 'yes' }],
    ['channel_history', { channel: 'testchan', mediaSink: 'spool' }],
    ['channel_history', { channel: 'testchan', mediaKey: '0123456789abcdef0123456789abcdef' }],
    ['download', { url: 'https://t.me/testchan/5', mediaSink: 'spool', mediaKey: 'ABCDEF0123456789ABCDEF0123456789' }],
    ['download', { url: 'https://t.me/testchan/5', mediaSink: 'file' }],
    ['download', { url: 'https://t.me/testchan/5', resumeOffset: 4096 }],
    ['download', { urls: ['https://t.me/testchan/5', 'https://t.me/testchan/6'], resumeOffset: 1048576 }],
    ['channel_history', { channel: 'testchan', resumeOffset: 1048576 }],
    ['comments', { url: 'https://t.me/testchan' }],
    ['comments', { channel: 'testchan' }],
    ['invite_preview', { channel: 'testchan' }],
    ['probe', { url: 'https://t.me/testchan/5' }],
    ['channel_history', { channel: 'testchan', path: 'C:/x' }],
  ];

  test.each(cases)('%s rejects %j', async (operation, input) => {
    const result = await relayResearch({
      command: 'start', jobId: `invalid-${testNumber}`, operation, input,
      expectedAccount: account(),
    });
    expect(result.events[0]).toMatchObject({ kind: 'error', code: 'INVALID_INPUT' });
  });
});
