import { Api as GramJs } from '../../../lib/gramjs';
import type { SizeType } from '../../../lib/gramjs/client/TelegramClient';
import { getInputPeer } from '../../../lib/gramjs/Utils';

import { buildApiPeerId } from '../apiBuilders/peers';
import { buildInputPeerFromLocalDb } from '../gramjsBuilders';
import localDb from '../localDb';
import {
  createResearchController, finishResearchController, getClient, getResearchAccountBinding, invokeResearchRequest,
} from './client';
export const RELAY_RESEARCH_OPERATIONS = [
  'discover', 'chat_info', 'read', 'search', 'channel_history', 'chat_export', 'download', 'join_chat',
] as const;
type Operation = typeof RELAY_RESEARCH_OPERATIONS[number];
type Binding = {
  accountRef: string;
  accountEpoch: string;
};
export type RelayResearchEvent = {
  kind: string;
  [key: string]: unknown;
};
export type RelayResearchInput = {
  query?: string;
  channel?: string;
  scope?: string;
  url?: string;
  urls?: string[];
  limit?: number;
  pageSize?: number;
  deadlineMs?: number;
  cursor?: string;
  topicId?: number;
  after?: number;
  before?: number;
  includeMedia?: boolean;
  exportFormats?: string[];
  confirmedJoin?: boolean;
};
export type RelayResearchArgs = {
  command: 'status' | 'start' | 'next' | 'cancel';
  jobId?: string;
  operation?: Operation;
  input?: RelayResearchInput;
  expectedAccount?: Binding;
};
export type RelayResearchResult = {
  events: RelayResearchEvent[];
  isFinished: boolean;
};
type Cursor = {
  version: number;
  scope: string;
  epoch: string;
  offsetId: number;
  offsetRate: number;
  offsetDate: number;
  offsetPeerId?: string;
};
type Job = Binding & {
  id: string;
  operation: Operation;
  input: RelayResearchInput;
  limit: number;
  pageSize: number;
  expiresAt: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  iterator?: AsyncGenerator<RelayResearchEvent>;
  pending?: Promise<IteratorResult<RelayResearchEvent>>;
  cursor: Cursor;
  count: number;
  seen: Set<string>;
  mediaSeen: Set<string>;
  bytes: number;
  isPartial: boolean;
  partialReason?: string;
};
type Peer = {
  id: string;
  input: GramJs.TypeInputPeer;
  entity?: GramJs.TypeChat | GramJs.TypeUser;
  username?: string;
};
type Message = GramJs.Message | GramJs.MessageService;
type CoverageMode = 'accessible_chat' | 'selected_membership' | 'account_server_search'
  | 'account_dialogs' | 'account_message_search';
type ResearchRecord = Record<string, unknown> & {
  type: string;
  id: string;
};
const JOBS = new Map<string, Job>();
let isStartingJob = false;
const MAX_RECORDS = 1000;
const MAX_PAGE = 100;
const MAX_DEADLINE = 300000;
const DEFAULT_DEADLINE = MAX_DEADLINE;
const MEDIA_CHUNK_BYTES = 49152;
const MEDIA_FETCH_BYTES = 1024 ** 2;
const MAX_MEDIA_BYTES = 1024 ** 3;
const MAX_JOB_BYTES = 2 * MAX_MEDIA_BYTES;
const MAX_JOB_MEDIA = 500;
const MAX_TEXT_BYTES = 4 * 1024 ** 2;
const TEXT_PART_CHARS = 8192;
const MAX_FRAME_BYTES = 240000;
const MAX_RESOLVE_PAGES = 10;
const COVERAGE_SCOPES: Record<CoverageMode, string> = {
  accessible_chat: 'channel', selected_membership: 'membership', account_server_search: 'public_channels',
  account_dialogs: 'account_channels', account_message_search: 'platform_search',
};
const PHOTO_SIZE_TYPES: readonly SizeType[] = ['u', 'v', 'w', 'y', 'd', 'x', 'c', 'm', 'b', 'a', 's', 'f', 'i', 'j'];
const INPUT_FIELDS = new Set([
  'query', 'channel', 'scope', 'url', 'urls', 'limit', 'pageSize', 'deadlineMs', 'cursor', 'topicId',
  'after', 'before', 'includeMedia', 'exportFormats', 'confirmedJoin',
]);
const SECRET_FIELDS = new Set(['accessHash', 'fileReference', 'authKey', 'phone', 'session', 'auth_key', 'keys']);
export async function relayResearch(args: RelayResearchArgs): Promise<RelayResearchResult> {
  let job: Job | undefined;
  let shouldReleaseJob = false;
  try {
    if (!args || !['status', 'start', 'next', 'cancel'].includes(args.command)) {
      throw new Error('INVALID_INPUT');
    }
    if (args.command === 'status') {
      const account = getResearchAccountBinding();
      return {
        events: [{
          kind: 'status', providers: [{
            provider: 'telegram', ...account,
            operations: [...RELAY_RESEARCH_OPERATIONS],
          }],
        }], isFinished: true,
      };
    }
    if (!args.jobId || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(args.jobId)) {
      throw new Error('INVALID_INPUT');
    }
    if (args.command === 'cancel') {
      job = JOBS.get(args.jobId);
      if (job) {
        job.controller.abort(new Error('CANCELLED'));
        await job.pending?.catch(() => undefined);
        await job.iterator!.return(undefined).catch(() => undefined);
        releaseJob(job);
      }
      return {
        events: [], isFinished: true,
      };
    }
    if (args.command === 'start') {
      if (JOBS.size || isStartingJob) {
        throw new Error('BUSY');
      }
      const account = getResearchAccountBinding();
      if (account.state !== 'ready') {
        throw new Error(account.state === 'initializing' ? 'INITIALIZING' : 'UNAVAILABLE');
      }
      if (!args.expectedAccount || args.expectedAccount.accountRef !== account.accountRef
        || args.expectedAccount.accountEpoch !== account.accountEpoch) {
        throw new Error('STALE_ACCOUNT');
      }
      if (!args.operation || !RELAY_RESEARCH_OPERATIONS.includes(args.operation)) {
        throw new Error('UNSUPPORTED');
      }
      const input = validateInput(args.input, args.operation);
      const limit = input.limit ?? MAX_RECORDS;
      const pageSize = Math.min(input.pageSize ?? MAX_PAGE, limit);
      const deadline = input.deadlineMs ?? DEFAULT_DEADLINE;
      const expiresAt = Date.now() + deadline;
      isStartingJob = true;
      let cursor: Cursor;
      try {
        cursor = await loadCursor(args.operation, input, account.accountEpoch);
      } finally {
        isStartingJob = false;
      }
      const current = getResearchAccountBinding();
      if (current.accountRef !== account.accountRef || current.accountEpoch !== account.accountEpoch
        || current.state !== 'ready') {
        throw new Error('STALE_ACCOUNT');
      }
      if (Date.now() >= expiresAt) {
        throw new Error('DEADLINE_EXCEEDED');
      }
      const controller = createResearchController(args.jobId);
      job = {
        ...account, id: args.jobId, operation: args.operation, input, limit, pageSize, controller,
        expiresAt, cursor, count: 0, seen: new Set(), mediaSeen: new Set(), bytes: 0, isPartial: false,
        timer: setTimeout(() => controller.abort(new Error('DEADLINE_EXCEEDED')), expiresAt - Date.now()),
      };
      job.iterator = collect(job);
      JOBS.set(job.id, job);
      return {
        events: [{
          kind: 'scope', accountRef: job.accountRef, accountEpoch: job.accountEpoch,
        }], isFinished: false,
      };
    }
    job = JOBS.get(args.jobId);
    if (!job) {
      throw new Error('NOT_FOUND');
    }
    if (job.pending) {
      throw new Error('BUSY');
    }
    shouldReleaseJob = true;
    if (!args.expectedAccount || args.expectedAccount.accountRef !== job.accountRef
      || args.expectedAccount.accountEpoch !== job.accountEpoch) {
      throw new Error('STALE_ACCOUNT');
    }
    checkJob(job);
    job.pending = job.iterator!.next();
    const step = await job.pending;
    job.pending = undefined;
    checkJob(job);
    if (step.done) {
      releaseJob(job);
      return {
        events: [], isFinished: true,
      };
    }
    const event = {
      ...step.value, accountRef: job.accountRef, accountEpoch: job.accountEpoch,
    };
    const isFinished = event.kind === 'done' || event.kind === 'error';
    if (isFinished) {
      await job.iterator!.return(undefined);
      releaseJob(job);
    }
    return {
      events: [event], isFinished,
    };
  } catch (error) {
    const failure = shouldReleaseJob && job?.controller.signal.aborted ? job.controller.signal.reason : error;
    const event = buildError(failure, job);
    if (error && typeof error === 'object' && 'completionUncertain' in error && error.completionUncertain === true) {
      event.completionUncertain = true;
      event.reason = 'cancelled_completion_uncertain';
    }
    if (job && shouldReleaseJob) {
      await job.iterator!.return(undefined).catch(() => undefined);
      releaseJob(job);
    }
    return {
      events: [event], isFinished: true,
    };
  }
}
async function* collect(job: Job): AsyncGenerator<RelayResearchEvent> {
  let coverage: CoverageMode = 'accessible_chat';
  if (job.operation === 'join_chat') {
    coverage = 'selected_membership';
    yield* collectJoin(job);
  } else if (job.operation === 'chat_info') {
    const peer = await resolvePeer(requireText(job.input.channel), job);
    let result: unknown;
    if (peer.input instanceof GramJs.InputPeerChannel) {
      result = await request(job, new GramJs.channels.GetFullChannel({
        channel: new GramJs.InputChannel({
          channelId: peer.input.channelId, accessHash: peer.input.accessHash,
        }),
      }));
    } else if (peer.input instanceof GramJs.InputPeerChat) {
      result = await request(job, new GramJs.messages.GetFullChat({
        chatId: peer.input.chatId,
      }));
    } else if (peer.input instanceof GramJs.InputPeerUser) {
      result = await request(job, new GramJs.users.GetFullUser({
        id: new GramJs.InputUser({
          userId: peer.input.userId, accessHash: peer.input.accessHash,
        }),
      }));
    } else if (peer.input instanceof GramJs.InputPeerSelf) {
      result = await request(job, new GramJs.users.GetFullUser({
        id: new GramJs.InputUserSelf(),
      }));
    } else {
      throw new Error('UNSUPPORTED');
    }
    yield* emitRecord(job, {
      schemaVersion: 1, type: 'telegram.chat', id: peer.id, ...source(peer),
      observedAt: new Date().toISOString(), observedFields: observe(result),
    }, coverage);
  } else if (job.operation === 'read' || job.operation === 'download') {
    const urls = job.input.urls ?? [requireText(job.input.url)];
    for (const url of urls.slice(0, job.limit)) {
      const parsed = parsePost(url);
      const peer = await resolvePeer(parsed.channel, job);
      const result = peer.input instanceof GramJs.InputPeerChannel
        ? await request(job, new GramJs.channels.GetMessages({
          channel: new GramJs.InputChannel({
            channelId: peer.input.channelId, accessHash: peer.input.accessHash,
          }),
          id: [new GramJs.InputMessageID({
            id: parsed.messageId,
          })],
        }))
        : await request(job, new GramJs.messages.GetMessages({
          id: [new GramJs.InputMessageID({
            id: parsed.messageId,
          })],
        }));
      const messages = readMessages(result);
      const message = messages.find((item) => item.id === parsed.messageId);
      if (!message) {
        job.isPartial = true;
        job.partialReason = 'MESSAGE_NOT_FOUND';
        continue;
      }
      if (getPeerId(message.peerId) !== peer.id) {
        throw new Error('SOURCE_MISMATCH');
      }
      if (parsed.topicId && getReplyThreadId(message) !== parsed.topicId) {
        throw new Error('SOURCE_MISMATCH');
      }
      yield* emitMessage(job, message, peer, coverage, url);
      if (job.operation === 'download' || job.input.includeMedia) {
        yield* collectMedia(job, message, peer, url);
      }
    }
    if (urls.length > job.limit) {
      job.isPartial = true;
      job.partialReason = 'ITEM_LIMIT';
    }
  } else if (job.operation === 'discover' && job.input.scope !== 'dialogs') {
    coverage = 'account_server_search';
    const result = await request(job, new GramJs.contacts.Search({
      q: requireText(job.input.query), limit: job.pageSize,
    }));
    const entities = job.input.scope === 'profiles' ? [...result.chats, ...result.users] : result.chats;
    for (const entity of entities.slice(0, Math.min(job.pageSize, job.limit))) {
      const peer = peerFromEntity(entity);
      yield* emitRecord(job, {
        schemaVersion: 1, type: 'telegram.chat', id: peer.id, ...source(peer),
        observedAt: new Date().toISOString(), observedFields: observe(entity),
      }, coverage);
    }
    if (entities.length >= job.pageSize) {
      job.isPartial = true;
      job.partialReason = 'SERVER_SEARCH_BOUND';
    }
  } else {
    coverage = job.operation === 'discover' ? 'account_dialogs'
      : job.operation === 'search' && !job.input.channel ? 'account_message_search' : 'accessible_chat';
    yield* collectPages(job, coverage);
  }
  const nextCursor = job.isPartial && job.cursor.offsetId ? encodeCursor(job.cursor) : undefined;
  yield {
    kind: 'done', outcome: job.isPartial ? 'partial' : job.count ? 'results' : 'empty', count: job.count,
    coverage: buildCoverage(job, coverage, true), partial: job.isPartial, nextCursor, reason: job.partialReason,
  };
}
async function* collectPages(job: Job, coverage: CoverageMode): AsyncGenerator<RelayResearchEvent> {
  const peer = job.input.channel ? await resolvePeer(job.input.channel, job) : undefined;
  let scannedCount = 0;
  while (job.count < job.limit && scannedCount < MAX_RECORDS) {
    const limit = Math.min(job.pageSize, job.limit - job.count, MAX_RECORDS - scannedCount);
    const previousCursor = encodeCursor(job.cursor);
    if (job.operation === 'discover') {
      const result = await fetchDialogs(job, limit, job.cursor);
      if (!('dialogs' in result)) {
        throw new Error('UNSUPPORTED');
      }
      scannedCount += result.dialogs.length;
      const query = requireText(job.input.query).toLocaleLowerCase();
      for (const dialog of result.dialogs) {
        const current = findPeer(dialog instanceof GramJs.DialogCommunity
          ? new GramJs.PeerChannel({
            channelId: dialog.communityId,
          }) : dialog.peer);
        if (!current) {
          continue;
        }
        const entity = current.entity;
        const label = entity && 'title' in entity ? entity.title
          : entity && 'firstName' in entity ? `${entity.firstName ?? ''} ${entity.lastName ?? ''}` : '';
        if (query !== '*' && !`${label} ${current.username ?? ''}`.toLocaleLowerCase().includes(query)) {
          continue;
        }
        yield* emitRecord(job, {
          schemaVersion: 1, type: 'telegram.dialog', id: current.id, ...source(current),
          observedAt: new Date().toISOString(), observedFields: observe(dialog), entity: observe(current.entity),
        }, coverage);
      }
      updateDialogCursor(job.cursor, result);
      if (result.dialogs.length < limit) {
        break;
      }
    } else {
      const params = {
        offsetId: job.cursor.offsetId, offsetDate: 0, addOffset: 0, limit,
        maxId: 0, minId: 0, hash: 0n,
      };
      const result = job.operation === 'search'
        ? await searchPage(job, peer, limit)
        : peer && job.input.topicId
          ? await request(job, new GramJs.messages.GetReplies({
            ...params, peer: peer.input, msgId: job.input.topicId,
          }))
          : peer ? await request(job, new GramJs.messages.GetHistory({
            ...params, peer: peer.input,
          }))
            : undefined;
      if (!result) {
        throw new Error('INVALID_INPUT');
      }
      const messages = readMessages(result);
      if (!messages.length) {
        break;
      }
      scannedCount += messages.length;
      for (const message of messages) {
        if (peer && getPeerId(message.peerId) !== peer.id) {
          throw new Error('SOURCE_MISMATCH');
        }
        if (job.input.topicId && getReplyThreadId(message) !== job.input.topicId && message.id !== job.input.topicId) {
          throw new Error('SOURCE_MISMATCH');
        }
        const current = findPeer(message.peerId) ?? peer;
        if (!current) {
          throw new Error('INACCESSIBLE');
        }
        const isInRange = (!job.input.after || message.date >= job.input.after)
          && (!job.input.before || message.date <= job.input.before);
        if (isInRange) {
          yield* emitMessage(job, message, current, coverage);
          if (job.input.includeMedia) {
            yield* collectMedia(job, message, current);
          }
        }
      }
      const last = messages[messages.length - 1];
      job.cursor.offsetId = last.id;
      job.cursor.offsetDate = last.date;
      job.cursor.offsetPeerId = findPeer(last.peerId)?.id;
      if ('nextRate' in result && typeof result.nextRate === 'number') {
        job.cursor.offsetRate = result.nextRate;
      }
      if (messages.length < limit || (job.input.after && last.date < job.input.after)) {
        break;
      }
    }
    if (encodeCursor(job.cursor) === previousCursor) {
      throw new Error('CURSOR_STALLED');
    }
    if (job.count >= job.limit) {
      job.isPartial = true;
      job.partialReason = 'ITEM_LIMIT';
      break;
    }
    if (scannedCount >= MAX_RECORDS) {
      job.isPartial = true;
      job.partialReason = 'SCAN_LIMIT';
      break;
    }
  }
}
async function searchPage(job: Job, peer: Peer | undefined, limit: number) {
  if (peer) {
    return request(job, new GramJs.messages.Search({
      peer: peer.input, q: requireText(job.input.query),
      topMsgId: job.input.topicId, filter: new GramJs.InputMessagesFilterEmpty(), minDate: job.input.after ?? 0,
      maxDate: job.input.before ?? 0, offsetId: job.cursor.offsetId, addOffset: 0, limit, maxId: 0, minId: 0, hash: 0n,
    }));
  }
  const offsetPeer = job.cursor.offsetPeerId ? buildInputPeerFromLocalDb(job.cursor.offsetPeerId) : undefined;
  if (job.cursor.offsetPeerId && !offsetPeer) {
    throw new Error('INACCESSIBLE');
  }
  if (job.input.scope === 'posts') {
    const flood = await request(job, new GramJs.channels.CheckSearchPostsFlood({
      query: requireText(job.input.query),
    }));
    if (!flood.queryIsFree && flood.remains <= 0) {
      throw Object.assign(new Error('RATE_LIMITED'), {
        retryAfterMs: Math.max(0, (flood.waitTill ?? 0) * 1000 - Date.now()),
      });
    }
    return request(job, new GramJs.channels.SearchPosts({
      query: requireText(job.input.query),
      offsetRate: job.cursor.offsetRate, offsetPeer: offsetPeer ?? new GramJs.InputPeerEmpty(),
      offsetId: job.cursor.offsetId, limit,
    }));
  }
  return request(job, new GramJs.messages.SearchGlobal({
    q: requireText(job.input.query),
    groupsOnly: job.input.scope === 'public_groups' ? true : undefined,
    filter: new GramJs.InputMessagesFilterEmpty(), minDate: job.input.after ?? 0, maxDate: job.input.before ?? 0,
    offsetRate: job.cursor.offsetRate, offsetPeer: offsetPeer ?? new GramJs.InputPeerEmpty(),
    offsetId: job.cursor.offsetId, limit,
  }));
}
function* emitMessage(job: Job, message: Message, peer: Peer, coverage: CoverageMode, url?: string) {
  const id = `${peer.id}:${message.id}`;
  if (job.seen.has(`telegram.message:${id}`)) {
    return;
  }
  const text = message instanceof GramJs.Message ? message.message : '';
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
    throw new Error('RECORD_TOO_LARGE');
  }
  const record = {
    schemaVersion: 1, type: 'telegram.message', id, peerId: peer.id, messageId: message.id,
    ...source(peer, message.id, url), observedAt: new Date().toISOString(), date: message.date,
    topicId: getTopicId(message), threadId: getReplyThreadId(message),
    observedFields: observe(message, true), omittedFields: [...SECRET_FIELDS],
  };
  if (text.length <= TEXT_PART_CHARS) {
    yield* emitRecord(job, {
      ...record, text,
    }, coverage);
    return;
  }
  job.seen.add(`telegram.message:${id}`);
  job.count++;
  for (let index = 0, offset = 0; offset < text.length; index++, offset += TEXT_PART_CHARS) {
    const part = {
      ...record, textPart: {
        index, text: text.slice(offset, offset + TEXT_PART_CHARS),
        final: offset + TEXT_PART_CHARS >= text.length,
      },
    };
    assertFrame(part);
    yield {
      kind: 'records', records: [part], coverage: buildCoverage(job, coverage),
    };
  }
}
function* emitRecord(job: Job, record: ResearchRecord, coverage: CoverageMode) {
  const key = `${record.type}:${record.id}`;
  if (job.seen.has(key)) {
    return;
  }
  assertFrame(record);
  job.seen.add(key);
  job.count++;
  yield {
    kind: 'records', records: [record], coverage: buildCoverage(job, coverage),
  };
}
async function* collectMedia(job: Job, message: Message, peer: Peer, url?: string): AsyncGenerator<RelayResearchEvent> {
  if (!(message instanceof GramJs.Message) || !message.media) {
    return;
  }
  const mediaKey = `${peer.id}:${message.id}`;
  if (job.mediaSeen.has(mediaKey)) {
    return;
  }
  if (job.mediaSeen.size >= MAX_JOB_MEDIA) {
    job.isPartial = true;
    job.partialReason = 'MEDIA_ITEM_LIMIT';
    return;
  }
  job.mediaSeen.add(mediaKey);
  if (message.noforwards || (peer.entity && 'noforwards' in peer.entity && peer.entity.noforwards)) {
    job.isPartial = true;
    job.partialReason = 'MEDIA_RESTRICTED';
    return;
  }
  let size = 0;
  let mimeType: string;
  let filename = `telegram-${message.id}.bin`;
  let sizeType: SizeType | undefined;
  if (message.media instanceof GramJs.MessageMediaDocument && message.media.document instanceof GramJs.Document) {
    const document = message.media.document;
    size = Number(document.size);
    mimeType = document.mimeType;
    const attribute = document.attributes.find((item) => item instanceof GramJs.DocumentAttributeFilename);
    if (attribute instanceof GramJs.DocumentAttributeFilename) {
      filename = `telegram-${message.id}-${attribute.fileName}`;
    }
  } else if (message.media instanceof GramJs.MessageMediaPhoto && message.media.photo instanceof GramJs.Photo) {
    for (const image of message.media.photo.sizes) {
      const candidate = image instanceof GramJs.PhotoSize ? image.size
        : image instanceof GramJs.PhotoSizeProgressive ? Math.max(...image.sizes) : 0;
      if (candidate > size && isPhotoSizeType(image.type)) {
        size = candidate;
        sizeType = image.type;
      }
    }
    mimeType = 'image/jpeg';
    filename = `telegram-${message.id}.jpg`;
  } else {
    job.isPartial = true;
    job.partialReason = 'UNSUPPORTED_MEDIA';
    return;
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_MEDIA_BYTES || job.bytes + size > MAX_JOB_BYTES) {
    job.isPartial = true;
    job.partialReason = 'MEDIA_SIZE_LIMIT';
    return;
  }
  filename = filename.replace(/[^a-z0-9._-]/gi, '_').slice(0, 120).replace(/\.+$/, '') || 'telegram-media.bin';
  const mediaId = `media-${job.count}-${message.id}`;
  const locator = source(peer, message.id, url);
  yield {
    kind: 'media_open', mediaId, fileName: filename, mimeType, declaredBytes: size,
    sourceUrl: locator.sourceUrl, sourceLocator: locator.sourceLocator,
  };
  const callback: {
    (): void;
    isCanceled?: boolean;
  } = () => {
  };
  const onAbort = () => {
    callback.isCanceled = true;
  };
  job.controller.signal.addEventListener('abort', onAbort, {
    once: true,
  });
  try {
    let sequence = 0;
    for (let offset = 0; offset < size; offset += MEDIA_FETCH_BYTES) {
      checkJob(job);
      const end = Math.min(size, offset + MEDIA_FETCH_BYTES) - 1;
      const bytes = await getClient().downloadMedia(message, {
        start: offset, end, sizeType, progressCallback: callback, isResearchRequest: true,
      });
      checkJob(job);
      if (!(bytes instanceof Uint8Array) || bytes.length !== end - offset + 1) {
        throw new Error('MEDIA_INCOMPLETE');
      }
      job.bytes += bytes.length;
      for (let chunkOffset = 0; chunkOffset < bytes.length; chunkOffset += MEDIA_CHUNK_BYTES) {
        checkJob(job);
        yield {
          kind: 'media_chunk', mediaId, sequence: sequence++,
          base64: bytesToBase64(bytes.subarray(chunkOffset, chunkOffset + MEDIA_CHUNK_BYTES)),
        };
      }
    }
    yield {
      kind: 'media_close', mediaId, totalBytes: size,
    };
  } finally {
    job.controller.signal.removeEventListener('abort', onAbort);
  }
}
async function* collectJoin(job: Job): AsyncGenerator<RelayResearchEvent> {
  if (job.input.confirmedJoin !== true) {
    throw new Error('JOIN_CONFIRMATION_REQUIRED');
  }
  const channel = requireText(job.input.channel);
  const invite = parseInvite(channel);
  let membershipState = 'unconfirmed';
  let peer: Peer | undefined;
  if (invite) {
    const checked = await request(job, new GramJs.messages.CheckChatInvite({
      hash: invite,
    }));
    if (checked instanceof GramJs.ChatInvite && (checked.subscriptionPricing || checked.subscriptionFormId)) {
      throw new Error('STARS_PAYMENT_UNSUPPORTED');
    }
    if (checked instanceof GramJs.ChatInviteAlready) {
      peer = peerFromEntity(checked.chat);
      membershipState = 'member';
    } else {
      try {
        const result = await request(job, new GramJs.messages.ImportChatInvite({
          hash: invite,
        }));
        if (!(result instanceof GramJs.messages.ChatInviteJoinResultOk)) {
          throw new Error('UNSUPPORTED');
        }
        if ('chats' in result.updates && result.updates.chats[0]) {
          peer = peerFromEntity(result.updates.chats[0]);
        }
      } catch (error) {
        if (getErrorMessage(error) === 'INVITE_REQUEST_SENT') {
          membershipState = 'pending_approval';
        } else if (!shouldReadJoinBack(error)) {
          throw error;
        }
      }
      if (membershipState !== 'pending_approval') {
        const readback = await request(job, new GramJs.messages.CheckChatInvite({
          hash: invite,
        }));
        if (readback instanceof GramJs.ChatInviteAlready) {
          peer = peerFromEntity(readback.chat);
          membershipState = 'member';
        }
      }
    }
  } else {
    peer = await resolvePeer(channel, job);
    if (!(peer.input instanceof GramJs.InputPeerChannel)) {
      throw new Error('UNSUPPORTED');
    }
    const selected = new GramJs.InputChannel({
      channelId: peer.input.channelId, accessHash: peer.input.accessHash,
    });
    if (await fetchChannelMembership(job, selected)) {
      membershipState = 'member';
    } else {
      try {
        await request(job, new GramJs.channels.JoinChannel({
          channel: selected,
        }));
      } catch (error) {
        if (getErrorMessage(error) === 'INVITE_REQUEST_SENT') {
          membershipState = 'pending_approval';
        } else if (!shouldReadJoinBack(error)) {
          throw error;
        }
      }
      if (membershipState !== 'pending_approval' && await fetchChannelMembership(job, selected)) {
        membershipState = 'member';
      }
    }
  }
  if (membershipState !== 'member') {
    job.isPartial = true;
    job.partialReason = membershipState.toUpperCase();
  }
  const locator = peer ? source(peer) : {
    sourceUrl: undefined, sourceLocator: `telegram:invite-scope:${job.cursor.scope}`,
  };
  yield* emitRecord(job, {
    schemaVersion: 1, type: 'telegram.membership', id: peer?.id ?? job.cursor.scope,
    sourceUrl: locator.sourceUrl, sourceLocator: locator.sourceLocator,
    observedAt: new Date().toISOString(), membershipState, selectedByHuman: true,
  }, 'selected_membership');
}
async function fetchChannelMembership(job: Job, channel: GramJs.InputChannel) {
  try {
    const result = await request(job, new GramJs.channels.GetParticipant({
      channel,
      participant: new GramJs.InputPeerSelf(),
    }));
    return result.participant instanceof GramJs.ChannelParticipant
      || result.participant instanceof GramJs.ChannelParticipantSelf
      || result.participant instanceof GramJs.ChannelParticipantCreator
      || result.participant instanceof GramJs.ChannelParticipantAdmin;
  } catch (error) {
    if (getErrorMessage(error) === 'USER_NOT_PARTICIPANT') {
      return false;
    }
    throw error;
  }
}
function shouldReadJoinBack(error: unknown) {
  return buildError(error).code === 'UNSUPPORTED' && getErrorMessage(error) !== 'UNSUPPORTED';
}
async function resolvePeer(value: string, job: Job): Promise<Peer> {
  checkJob(job);
  if (value.startsWith('https://')) {
    const parts = parseTelegramUrl(value).pathname.split('/').filter(Boolean);
    if (parts[0] === 's') {
      parts.shift();
    }
    if (parts[0] === 'c' && parts.length === 2 && /^\d{1,20}$/.test(parts[1]) && BigInt(parts[1]) > 0n) {
      value = buildApiPeerId(BigInt(parts[1]), 'channel');
    } else if (parts.length === 1) {
      value = parts[0];
    } else {
      throw new Error('UNSUPPORTED');
    }
  }
  if (value === 'me' || value === 'saved') {
    const user = await request(job, new GramJs.users.GetUsers({
      id: [new GramJs.InputUserSelf()],
    }));
    if (!user[0]) {
      throw new Error('AUTH_REQUIRED');
    }
    return peerFromEntity(user[0]);
  }
  if (/^-?\d{1,20}$/.test(value)) {
    const cached = localDb.chats[value] ?? localDb.users[value];
    if (cached) {
      return peerFromEntity(cached);
    }
    const cursor = {
      ...job.cursor, offsetId: 0, offsetDate: 0, offsetPeerId: undefined,
    };
    for (let page = 0; page < MAX_RESOLVE_PAGES; page++) {
      const dialogs = await fetchDialogs(job, MAX_PAGE, cursor);
      const entity = localDb.chats[value] ?? localDb.users[value];
      if (entity) {
        return peerFromEntity(entity);
      }
      if (!('dialogs' in dialogs) || dialogs.dialogs.length < MAX_PAGE) {
        break;
      }
      updateDialogCursor(cursor, dialogs);
    }
    throw new Error('INACCESSIBLE');
  }
  const username = value.replace(/^@/, '');
  if (!username || !/^[a-z0-9_]{3,64}$/i.test(username)) {
    throw new Error('INVALID_INPUT');
  }
  const result = await request(job, new GramJs.contacts.ResolveUsername({
    username,
  }));
  const peer = findPeer(result.peer);
  if (!peer) {
    throw new Error('INACCESSIBLE');
  }
  return peer;
}
async function fetchDialogs(job: Job, limit: number, cursor: Cursor) {
  const offsetPeer = cursor.offsetPeerId ? buildInputPeerFromLocalDb(cursor.offsetPeerId) : undefined;
  if (cursor.offsetPeerId && !offsetPeer) {
    throw new Error('INACCESSIBLE');
  }
  return request(job, new GramJs.messages.GetDialogs({
    offsetDate: cursor.offsetDate, offsetId: cursor.offsetId,
    offsetPeer: offsetPeer ?? new GramJs.InputPeerEmpty(), limit, hash: 0n, excludePinned: true,
  }));
}
function updateDialogCursor(cursor: Cursor, result: GramJs.messages.TypeDialogs) {
  if (!('dialogs' in result) || !result.dialogs.length) {
    return;
  }
  const last = [...result.dialogs].reverse().find((dialog) => !(dialog instanceof GramJs.DialogCommunity));
  if (!last || last instanceof GramJs.DialogCommunity) {
    return;
  }
  cursor.offsetPeerId = getPeerId(last.peer);
  cursor.offsetId = last.topMessage;
  const message = result.messages.find((item) => item.id === last.topMessage
    && !(item instanceof GramJs.MessageEmpty) && getPeerId(item.peerId) === cursor.offsetPeerId);
  cursor.offsetDate = message && !(message instanceof GramJs.MessageEmpty) ? message.date : 0;
}
function findPeer(peer: GramJs.TypePeer): Peer | undefined {
  const id = getPeerId(peer);
  const entity = localDb.chats[id] ?? localDb.users[id];
  return entity ? peerFromEntity(entity) : undefined;
}
function peerFromEntity(entity: GramJs.TypeChat | GramJs.TypeUser): Peer {
  const id = entity instanceof GramJs.User || entity instanceof GramJs.UserEmpty
    ? buildApiPeerId(entity.id, 'user') : entity instanceof GramJs.Chat || entity instanceof GramJs.ChatEmpty
      || entity instanceof GramJs.ChatForbidden ? buildApiPeerId(entity.id, 'chat')
      : buildApiPeerId(entity.id, 'channel');
  return {
    id, input: getInputPeer(entity), entity, username: 'username' in entity ? entity.username : undefined,
  };
}
function getPeerId(peer: GramJs.TypePeer) {
  return peer instanceof GramJs.PeerChannel ? buildApiPeerId(peer.channelId, 'channel')
    : peer instanceof GramJs.PeerChat ? buildApiPeerId(peer.chatId, 'chat') : buildApiPeerId(peer.userId, 'user');
}
function source(peer: Peer, messageId?: number, selectedUrl?: string) {
  const publicUrl = peer.username ? `https://t.me/${peer.username}${messageId ? `/${messageId}` : ''}` : undefined;
  return {
    sourceUrl: selectedUrl ?? publicUrl,
    sourceLocator: `telegram:peer:${peer.id}${messageId ? `:message:${messageId}` : ''}`,
  };
}
function readMessages(result: GramJs.messages.TypeMessages): Message[] {
  if (!('messages' in result)) {
    throw new Error('UNSUPPORTED');
  }
  return result.messages.filter((message): message is Message => message instanceof GramJs.Message
    || message instanceof GramJs.MessageService);
}
function getTopicId(message: Message) {
  return message.replyTo instanceof GramJs.MessageReplyHeader && message.replyTo.forumTopic
    ? message.replyTo.replyToTopId ?? message.replyTo.replyToMsgId : undefined;
}

function getReplyThreadId(message: Message) {
  return message.replyTo instanceof GramJs.MessageReplyHeader
    ? message.replyTo.replyToTopId ?? message.replyTo.replyToMsgId : undefined;
}
function isPhotoSizeType(value: string): value is SizeType {
  return PHOTO_SIZE_TYPES.some((type) => type === value);
}

function buildCoverage(job: Job, mode: CoverageMode, isFinal = false) {
  return { scope: COVERAGE_SCOPES[mode], mode, accessible: true,
    completeness: isFinal && !job.isPartial ? 'complete' : 'partial' };
}
async function request<T extends GramJs.AnyRequest>(job: Job, value: T) {
  checkJob(job);
  const result = await invokeResearchRequest(value, job.controller.signal);
  checkJob(job);
  return result;
}
function checkJob(job: Job) {
  const account = getResearchAccountBinding();
  if (account.accountRef !== job.accountRef || account.accountEpoch !== job.accountEpoch || account.state !== 'ready') {
    job.controller.abort(new Error('STALE_ACCOUNT'));
  }
  if (Date.now() >= job.expiresAt) {
    job.controller.abort(new Error('DEADLINE_EXCEEDED'));
  }
  if (job.controller.signal.aborted) {
    throw job.controller.signal.reason;
  }
}
function releaseJob(job: Job) {
  clearTimeout(job.timer);
  if (JOBS.get(job.id) === job) {
    JOBS.delete(job.id);
  }
  finishResearchController(job.id);
}
function validateInput(value: RelayResearchInput | undefined, operation: Operation): RelayResearchInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !INPUT_FIELDS.has(key))) {
    throw new Error('INVALID_INPUT');
  }
  const numericLimits = [['limit', MAX_RECORDS], ['pageSize', MAX_PAGE], ['deadlineMs', MAX_DEADLINE]] as const;
  for (const [key, maximum] of numericLimits) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > maximum)) {
      throw new Error('INVALID_INPUT');
    }
  }
  if (value.urls && (!Array.isArray(value.urls) || value.urls.length > MAX_RECORDS
    || value.urls.some((url) => typeof url !== 'string'))) {
    throw new Error('INVALID_INPUT');
  }
  if (value.topicId !== undefined && (!Number.isSafeInteger(value.topicId) || value.topicId <= 0)) {
    throw new Error('INVALID_INPUT');
  }
  for (const key of ['after', 'before'] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) {
      throw new Error('INVALID_INPUT');
    }
  }
  for (const key of ['query', 'channel', 'url', 'cursor', 'scope'] as const) {
    if (value[key] !== undefined) {
      requireText(value[key]);
    }
  }
  if ((value.includeMedia !== undefined && typeof value.includeMedia !== 'boolean')
    || (value.confirmedJoin !== undefined && typeof value.confirmedJoin !== 'boolean')
    || (value.exportFormats !== undefined && (!Array.isArray(value.exportFormats)
      || value.exportFormats.some((format) => !['jsonl', 'markdown', 'html'].includes(format))))) {
    throw new Error('INVALID_INPUT');
  }
  if (value.after !== undefined && value.before !== undefined && value.after > value.before) {
    throw new Error('INVALID_INPUT');
  }
  if (operation === 'discover' || operation === 'search') {
    requireText(value.query);
  }
  if (['chat_info', 'channel_history', 'chat_export', 'join_chat'].includes(operation)) {
    requireText(value.channel);
  }
  if (operation === 'read' || operation === 'download') {
    if (Boolean(value.url) === Boolean(value.urls) || !((value.urls?.length ?? 1) > 0)) {
      throw new Error('INVALID_INPUT');
    }
    (value.urls ?? [requireText(value.url)]).forEach(parsePost);
  }
  if (value.scope && !['public_groups', 'dialogs', 'profiles', 'posts'].includes(value.scope)) {
    throw new Error('UNSUPPORTED');
  }
  if (operation === 'discover' && value.scope === 'posts') {
    throw new Error('UNSUPPORTED');
  }
  if (operation === 'search' && value.scope === 'profiles') {
    throw new Error('UNSUPPORTED');
  }
  if (operation === 'join_chat' && value.confirmedJoin !== true) {
    throw new Error('JOIN_CONFIRMATION_REQUIRED');
  }
  return value;
}
function requireText(value: string | undefined) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048
    || [...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error('INVALID_INPUT');
  }
  return value.trim();
}
function parseTelegramUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me'].includes(url.hostname)) {
    throw new Error('INVALID_INPUT');
  }
  return url;
}
function parsePost(value: string) {
  const url = parseTelegramUrl(value);
  if (url.searchParams.has('comment')) {
    throw new Error('UNSUPPORTED');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 's') {
    parts.shift();
  }
  const isPrivate = parts[0] === 'c';
  if (isPrivate && (!/^\d{1,20}$/.test(parts[1] ?? '') || BigInt(parts[1]) <= 0n)) {
    throw new Error('INVALID_INPUT');
  }
  const channel = isPrivate ? buildApiPeerId(BigInt(parts[1] || '0'), 'channel') : parts[0];
  const ids = parts.slice(isPrivate ? 2 : 1).map(Number);
  if (!channel || !ids.length || ids.length > 2 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('INVALID_INPUT');
  }
  return {
    channel, messageId: ids[ids.length - 1], topicId: ids.length > 1 ? ids[0] : undefined,
  };
}
function parseInvite(value: string) {
  if (!value.startsWith('https://')) {
    return undefined;
  }
  const path = parseTelegramUrl(value).pathname;
  const hash = /^\/(?:\+|joinchat\/)([a-z0-9_-]{5,128})\/?$/i.exec(path)?.[1];
  return hash;
}
async function loadCursor(operation: Operation, input: RelayResearchInput, epoch: string): Promise<Cursor> {
  const raw = JSON.stringify({
    operation, query: input.query, channel: input.channel, scope: input.scope,
    url: input.url, urls: input.urls, topicId: input.topicId, after: input.after, before: input.before,
    includeMedia: input.includeMedia,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const scope = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!input.cursor) {
    return {
      version: 1, scope, epoch, offsetId: 0, offsetRate: 0, offsetDate: 0,
    };
  }
  if (input.cursor.length > 2048) {
    throw new Error('INVALID_CURSOR');
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(input.cursor), (char) => char.charCodeAt(0))));
  } catch {
    throw new Error('INVALID_CURSOR');
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || !('version' in candidate && 'scope' in candidate && 'epoch' in candidate
      && 'offsetId' in candidate && 'offsetRate' in candidate && 'offsetDate' in candidate)) {
    throw new Error('INVALID_CURSOR');
  }
  const { version, scope: boundScope, epoch: boundEpoch, offsetId, offsetRate, offsetDate } = candidate;
  const offsetPeerId = 'offsetPeerId' in candidate ? candidate.offsetPeerId : undefined;
  if (typeof version !== 'number' || typeof boundScope !== 'string' || typeof boundEpoch !== 'string'
    || typeof offsetId !== 'number' || typeof offsetRate !== 'number' || typeof offsetDate !== 'number'
    || (offsetPeerId !== undefined && typeof offsetPeerId !== 'string')) {
    throw new Error('INVALID_CURSOR');
  }
  if (version !== 1 || boundScope !== scope || boundEpoch !== epoch
    || [offsetId, offsetRate, offsetDate].some((number) => !Number.isSafeInteger(number) || number < 0)
    || (offsetPeerId !== undefined && !/^-?\d{1,20}$/.test(offsetPeerId))) {
    throw new Error('STALE_CURSOR');
  }
  return { version, scope: boundScope, epoch: boundEpoch, offsetId, offsetRate, offsetDate, offsetPeerId };
}
function encodeCursor(cursor: Cursor) {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(cursor)));
}
function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}
function observe(value: unknown, omitMessageText = false, depth = 0): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return {
      byteLength: value.length,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => observe(item, false, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (depth > 24) {
    throw new Error('RECORD_TOO_COMPLEX');
  }
  const fields: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELDS.has(key) || (omitMessageText && depth === 0 && key === 'message')) {
      continue;
    }
    if (typeof item !== 'function' && item !== undefined) {
      fields[key] = observe(item, false, depth + 1);
    }
  }
  return fields;
}
function assertFrame(record: Record<string, unknown>) {
  if (new TextEncoder().encode(JSON.stringify(record)).length > MAX_FRAME_BYTES) {
    throw new Error('RECORD_TOO_LARGE');
  }
}
function getErrorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'errorMessage' in error && typeof error.errorMessage === 'string') {
    return error.errorMessage;
  }
  return error instanceof Error ? error.message : '';
}
function buildError(error: unknown, job?: Job): RelayResearchEvent {
  const message = getErrorMessage(error);
  let code = ['CANCELLED', 'DEADLINE_EXCEEDED', 'STALE_ACCOUNT', 'AUTH_REQUIRED', 'INITIALIZING', 'BUSY', 'NOT_FOUND',
    'UNAVAILABLE',
    'INVALID_INPUT', 'INVALID_CURSOR', 'STALE_CURSOR', 'SOURCE_MISMATCH', 'CURSOR_STALLED',
    'JOIN_CONFIRMATION_REQUIRED'].includes(message)
    ? message : 'UNSUPPORTED';
  if (/FLOOD|RATE_LIMIT/.test(message)) {
    code = 'RATE_LIMITED';
  }
  if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|USER_BANNED|INACCESSIBLE/.test(message)) {
    code = 'ACCESS_DENIED';
  }
  if (/AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED/.test(message)) {
    code = 'AUTH_REQUIRED';
  }
  if (/FILE_REFERENCE/.test(message)) {
    code = 'FILE_REFERENCE_EXPIRED';
  }
  if (/STARS|PAYMENT/.test(message)) {
    code = 'STARS_PAYMENT_UNSUPPORTED';
  }
  const seconds = error && typeof error === 'object' && 'seconds' in error ? Number(error.seconds) : undefined;
  const retry = error && typeof error === 'object' && 'retryAfterMs' in error ? Number(error.retryAfterMs) : undefined;
  const completionUncertain = Boolean(error && typeof error === 'object' && 'completionUncertain' in error
    && error.completionUncertain);
  return {
    kind: 'error', code, reason: completionUncertain ? 'cancelled_completion_uncertain' : code,
    completionUncertain,
    retryAfterMs: code === 'RATE_LIMITED' ? Math.min(86400000, Math.max(0, retry ?? (seconds ?? 0) * 1000)) : undefined,
    accountRef: job?.accountRef, accountEpoch: job?.accountEpoch,
  };
}
