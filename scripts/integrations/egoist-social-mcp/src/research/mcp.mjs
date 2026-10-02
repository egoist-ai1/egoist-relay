#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectResearch } from './client.mjs';
import { MAX_FRAME_BYTES, RESEARCH_VERSION, readResearchConfig } from './config.mjs';
import { createLocalResearchIndex } from './local-index.mjs';
import { safeResearchError } from './ipc.mjs';

const object = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (maxLength, extra = {}) => ({ type: 'string', minLength: 1, maxLength, ...extra });
const JOB = str(36, { pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' });
const PROVIDER = { type: 'string', enum: ['telegram', 'x', 'instagram'] };
const limits = {
  limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
  pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  deadlineMs: { type: 'integer', minimum: 1000, maximum: 300000, default: 120000 },
  cursor: str(2048),
};
const input = (fields, required) => object({ ...limits, ...fields }, required);
const branch = (operation, fields, required, provider = ['chat_info'].includes(operation) ? { type: 'string', const: 'telegram' } : operation === 'article' ? { type: 'string', const: 'x' } : ['profile', 'read_thread'].includes(operation) ? { type: 'string', enum: ['x', 'instagram'] } : PROVIDER) => object({
  provider,
  operation: { type: 'string', const: operation },
  input: input(fields, required),
  idempotencyKey: str(256),
}, ['provider', 'operation', 'input']);
const postBranches = (operation, fields, required) => {
  const branches = [branch(operation, fields, required, operation === 'article' ? { type: 'string', const: 'x' } : { type: 'string', enum: ['x', 'instagram'] })];
  if (operation !== 'article') {
    const telegramFields = { ...fields }; delete telegramFields.includeReplies;
    branches.push(branch(operation, telegramFields, required, { type: 'string', const: 'telegram' }));
  }
  return branches;
};
const submitSchema = {
  oneOf: [
    ...['search', 'discover'].map(operation => branch(operation, { query: str(512), channel: str(256), scope: { type: 'string', enum: ['public_groups', 'dialogs', 'profiles', 'tags', 'posts'] } }, ['query'])),
    ...['channel_history', 'chat_export', 'chat_info', 'profile'].map(operation => branch(operation, { channel: str(256), topicId: { type: 'integer', minimum: 1, maximum: 2147483647 }, after: { type: 'integer', minimum: 0, maximum: 4102444800 }, before: { type: 'integer', minimum: 0, maximum: 4102444800 }, includeMedia: { type: 'boolean' }, exportFormats: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['jsonl', 'markdown', 'html'] } } }, ['channel'])),
    branch('read_thread', { url: str(2048), includeMedia: { type: 'boolean' }, exportFormats: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['jsonl', 'markdown', 'html'] } } }, ['url']),
    ...['read', 'download', 'article'].flatMap(operation => [
      ...postBranches(operation, { url: str(2048), includeMedia: { type: 'boolean' }, includeReplies: { type: 'boolean' }, exportFormats: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['jsonl', 'markdown', 'html'] } } }, ['url']),
      ...postBranches(operation, { urls: { type: 'array', minItems: 1, maxItems: 1000, items: str(2048) }, includeMedia: { type: 'boolean' }, includeReplies: { type: 'boolean' } }, ['urls']),
    ]),
    ...[{ url: str(2048) }, { urls: { type: 'array', minItems: 1, maxItems: 20, items: str(2048) } }].map(source => branch('transcribe', { ...source, limit: { type: 'integer', minimum: 1, maximum: 20, default: 20 }, language: str(4, { pattern: '^(auto|[a-z]{2,3})$' }) }, Object.keys(source))),
  ],
  type: 'object',
};
const definition = (name, description, inputSchema, method, readOnly = false) => ({
  name, description, inputSchema, method,
  annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: true },
});
const selectedJobs = { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: JOB };
export const RESEARCH_TOOLS = Object.freeze([
  { ...definition('social_index_jobs', 'Build or verify a local derived index of ONLY these exact accepted completed or nonempty partial export jobs. Read each job first. It indexes records.jsonl; transcripts and unselected files are excluded. Partial coverage and missing fields remain explicit. Same bytes are idempotent; changed sources require explicit replaceChanged=true. No account requests, private profile reads, implicit crawling or source edits. Finite atomic operation with disk reserve and deadline.', object({jobIds:selectedJobs,replaceChanged:{type:'boolean',default:false},deadlineMs:limits.deadlineMs},['jobIds']), 'index_jobs'), annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false} },
  { ...definition('social_search_index', 'Search ONLY the explicitly selected indexed job snapshots locally, even while Relay is offline. Query uses literal Unicode AND terms and quoted phrases, without arbitrary SQL/FTS operators. Results give observed source, snippet, JSONL line/byte locator and content/source hashes. Partial corpus stays incomplete; no results applies only to this selected snapshot. Sources are verified before each search; missing/changed index is an error. Index exact jobs first; use the opaque query/snapshot-bound nextCursor for lossless pagination.', object({jobIds:selectedJobs,query:str(1024),limit:{type:'integer',minimum:1,maximum:100,default:20},cursor:str(1024),deadlineMs:limits.deadlineMs},['jobIds','query']), 'search_index',true), annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false} },
  definition('social_status', 'Read the shared research daemon, independent provider queues and actual Relay-owned bridge readiness. Existing account authorization and a working bridge are separate states. No credentials or source contents are returned. A missing bridge is unavailable, not a request to log in again.', object(), 'status', true),
  definition('social_capabilities', 'Inspect current Telegram, X and Instagram account-owned capabilities before collection. No keys, cookies or profiles are copied. ready requires an actual app-owned account check; unavailable/challenge/denied never means no posts. Operations depend on the current app build and platform.', object(), 'capabilities', true),
  definition('social_submit', 'Queue discovery, account/source info, exact posts, free search, history, chat export, supported media, X articles or local audio/video transcription through existing authorized Relay accounts. Three providers run concurrently; each has a serial queue. Inspect social_job after submit. Chat exports produce source JSONL and requested Markdown/HTML; large collections continue with source/account-bound cursors in finite 1000-record/300-second jobs. transcribe downloads selected media and uses installed FFmpeg/Whisper, up to 20 sources within the same deadline; transcript files have approximate timestamps and separate media/segment counts. Text/photos/video/audio/documents retain observed metadata and explicit missing/partial fields. read_thread reads only an exact human-requested X/Instagram conversation URL and may change its normal read status; do not enumerate private conversations. Telegram topics/date filters supported where available. Instagram profile/tag routes do not promise universal keyword search. No joining, send, publish, like, follow, paid search, challenge bypass, arbitrary URLs or unbounded download. idempotencyKey deduplicates an identical normalized request; no automatic retry after unknown completion.', submitSchema, 'submit'),
  definition('social_job', 'Read one exact job: state, accepted count, workspace files, evidence, coverage and continuation cursor. queued/running are incomplete; partial/interrupted/cancelled preserve accepted data. Read back before resuming or retrying; count zero with unavailable/denied is not an empty source.', object({ jobId: JOB }), 'get', true),
  definition('social_cancel', 'Cancel one owned research job. Preserve accepted source files, incomplete media and manifests. Cancellation affects only the research namespace and never closes Relay, aborts UI calls, logs out or deletes material. Poll social_job until the transport settles.', object({ jobId: JOB }), 'cancel'),
  definition('telegram_join_chat', 'Join ONLY the exact Telegram group/channel or invite selected by the human user. This is a membership mutation, separate from discovery/read. Never join groups mentioned only by posts or search results and never pay Stars. Read membership after uncertain completion; pending approval is not membership. Idempotency applies only to the same target/request.', object({ channel: str(256), deadlineMs: limits.deadlineMs, idempotencyKey: str(256) }, ['channel']), 'submit_join'),
]);

function valid(schema, value) {
  if (schema.oneOf) return schema.oneOf.filter(option => valid(option, value)).length === 1;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
    if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, item]) => !schema.properties?.[key] || valid(schema.properties[key], item));
  }
  if (schema.type === 'array') return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && (!schema.uniqueItems || new Set(value.map(item => JSON.stringify(item))).size === value.length) && value.every(item => valid(schema.items, item));
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'string') return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity) && (!schema.pattern || new RegExp(schema.pattern).test(value));
  return false;
}
export const validateResearchArguments = (schema, value) => valid(schema, value);

const INDEX_CODES = new Set(['INVALID_INDEX_REQUEST','INDEX_JOB_UNAVAILABLE','INVALID_CORPUS','INDEX_SOURCE_CHANGED','INDEX_NORMALIZATION_CHANGED','INDEX_MISSING','INDEX_INVALID_DB','INDEX_BUSY','INDEX_LIMIT','INDEX_CANCELLED','INDEX_DEADLINE','INDEX_CURSOR_STALE','INDEX_DISK_RESERVE','INDEX_STORAGE_FAILED']);
const indexFailure = code => Object.assign(new Error(code),{code});
const bounded = async (operation,end) => {
  if(Date.now()>=end)throw indexFailure('INDEX_DEADLINE');
  let timer;
  try { return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(indexFailure('INDEX_DEADLINE')),end-Date.now());})]); }
  finally { clearTimeout(timer); }
};
export function createResearchDispatcher({ connect = connectResearch, readConfig = readResearchConfig, createIndex = createLocalResearchIndex } = {}) {
  let negotiated = false;
  let initialized = false;
  let connection;
  let localIndex;
  const getConnection = () => connection ??= Promise.resolve().then(() => connect()).catch(problem => { connection = undefined; throw problem; });
  const getIndex = () => localIndex ??= Promise.resolve().then(() => readConfig()).then(config => createIndex({stateRoot:config.stateRoot,outputRoot:config.outputRoot})).catch(problem => {localIndex=undefined;throw problem;});
  const response = (id, result) => ({ jsonrpc: '2.0', id, result });
  const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  return async (request) => {
    const id = typeof request?.id === 'string' && request.id.length <= 128 || Number.isSafeInteger(request?.id) ? request.id : null;
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
      (request.id !== undefined && !(typeof request.id === 'string' && request.id.length <= 128 || typeof request.id === 'number' && Number.isSafeInteger(request.id)))) {
      return error(id, -32600, 'Invalid JSON-RPC request.');
    }
    if (request.id === undefined) {
      if (request.method === 'notifications/initialized' && negotiated) initialized = true;
      return undefined;
    }
    if (request.method === 'initialize') {
      if (negotiated) return error(id, -32600, 'Session already initialized.');
      if (typeof request.params?.protocolVersion !== 'string' || !request.params.capabilities || typeof request.params.capabilities !== 'object' || Array.isArray(request.params.capabilities) ||
          typeof request.params.clientInfo?.name !== 'string' || typeof request.params.clientInfo?.version !== 'string') return error(id, -32602, 'protocolVersion, capabilities and clientInfo are required.');
      negotiated = true;
      return response(id, {
        protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26'].includes(request.params.protocolVersion) ? request.params.protocolVersion : '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'egoist-social', version: RESEARCH_VERSION },
        instructions: 'Inspect actual provider capabilities. Account access comes from the trusted Relay-owned bridge and the existing authorized sessions; no profile/key/cookie cloning or repeated login. Missing bridge does not mean missing account authorization. Independent provider queues and persistent finite jobs: submit returns an ID; read it before interpreting, continuing or retrying. Read/export/download are separate from the exact human-selected Telegram join mutation. No send/publication or automatic join of discovered groups. Private threads require an exact human target and can change normal read status. EOF leaves daemon/jobs running. No universal complete scrape, throughput or media promise.',
      });
    }
    if (request.method === 'ping') return response(id, {});
    if (!initialized) return error(id, -32002, 'Initialize the MCP session first.');
    if (request.method === 'tools/list') {
      if (request.params && Object.keys(request.params).length) return error(id, -32602, 'This bounded tool catalogue has no cursor.');
      return response(id, { tools: RESEARCH_TOOLS.map(({ method, ...tool }) => tool) });
    }
    if (request.method !== 'tools/call') return error(id, -32601, 'Method not found.');
    const params = request.params;
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key))) return error(id, -32602, 'Malformed tool call.');
    const tool = RESEARCH_TOOLS.find(item => item.name === params.name);
    if (!tool) return error(id, -32602, 'Unknown research tool.');
    const args = params.arguments ?? {};
    if (!valid(tool.inputSchema, args)) return error(id, -32602, 'Arguments do not match the bounded research schema.');
    try {
      let result;
      if(tool.method==='index_jobs') {
        const end=Date.now()+(args.deadlineMs??300000);
        const client=await bounded(getConnection(),end);
        const jobs=[];
        for(let offset=0;offset<args.jobIds.length;offset+=8) {
          const batch=args.jobIds.slice(offset,offset+8);
          const returned = await bounded(Promise.all(batch.map(jobId=>client.call('get',{jobId}))),end);
          if(returned.some((job,index)=>!job||job.id!==batch[index]))throw indexFailure('INVALID_CORPUS');
          jobs.push(...returned);
        }
        const index=await bounded(getIndex(),end);
        result=await index.indexJobs({jobs,replaceChanged:args.replaceChanged??false,deadlineMs:Math.max(1,end-Date.now())});
      } else if(tool.method==='search_index') {
        const end=Date.now()+(args.deadlineMs??30000);
        const index=await bounded(getIndex(),end);
        result=await index.search({...args,deadlineMs:Math.max(1,end-Date.now())});
      } else {
        const client=await getConnection();
        result=await client.call(tool.method,args);
      }
      const reply=response(id,{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false});
      if(Buffer.byteLength(JSON.stringify(reply))+1>MAX_FRAME_BYTES)throw indexFailure('RESEARCH_FRAME_TOO_LARGE');
      return reply;
    } catch (problem) {
      const result = INDEX_CODES.has(problem?.code) ? {code:problem.code,recovery:problem.code==='INDEX_MISSING'?'Index the exact selected accepted jobs before searching.':problem.code==='INDEX_SOURCE_CHANGED'?'The selected source snapshot changed. Review the exact job and explicitly rebuild it with replaceChanged=true.':problem.code==='INDEX_NORMALIZATION_CHANGED'?'The selected derived snapshot uses older text roles. Explicitly index the exact selected accepted job IDs before searching again.':'Read the exact selected job/index state before retrying; no unfinished snapshot is committed.'} : safeResearchError(problem);
      return response(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: true });
    }
  };
}

function writeResearchFrame(output, value, deadlineMs) {
  const frame = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw indexFailure('RESEARCH_FRAME_TOO_LARGE');
  if (output.destroyed || output.writableEnded || output.writableFinished) throw indexFailure('RESEARCH_OUTPUT_CLOSED');
  return new Promise((resolve, reject) => {
    let done = false, returned = false, callbackDone = false, needsDrain = false, drained = false;
    const cleanup = () => { output.removeListener('error', onError); output.removeListener('close', onClose); output.removeListener('drain', onDrain); };
    const settle = problem => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (problem) {
        // Destroy only this output transport. Keep the error guard through Node's
        // callback/error/close next-tick sequence, then remove every listener.
        try { if (!output.destroyed) output.destroy(); } catch {}
        setImmediate(cleanup); reject(problem);
      } else { cleanup(); resolve(); }
    };
    const finish = () => { if (returned && callbackDone && (!needsDrain || drained)) settle(); };
    const onError = () => settle(indexFailure('RESEARCH_OUTPUT_FAILED'));
    const onClose = () => settle(indexFailure('RESEARCH_OUTPUT_CLOSED'));
    const onDrain = () => { drained = true; finish(); };
    const timer = setTimeout(() => settle(indexFailure('RESEARCH_OUTPUT_DEADLINE')), deadlineMs);
    output.on('error', onError); output.on('close', onClose); output.on('drain', onDrain);
    try {
      needsDrain = !output.write(frame, problem => { if (problem) onError(); else { callbackDone = true; finish(); } });
      returned = true; finish();
    } catch { onError(); }
  });
}
export async function runResearchStdio({ input = process.stdin, output = process.stdout, dispatch = createResearchDispatcher(), outputDeadlineMs = 30000 } = {}) {
  if(!Number.isSafeInteger(outputDeadlineMs)||outputDeadlineMs<1||outputDeadlineMs>60000)throw indexFailure('INVALID_INPUT');
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buffer.includes(10)) {
      const end = buffer.indexOf(10);
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      if(output.destroyed||output.writableEnded||output.writableFinished)throw indexFailure('RESEARCH_OUTPUT_CLOSED');
      let result;
      if (line.length > MAX_FRAME_BYTES) result = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Research frame exceeds its bound.' } };
      else {
        let request;
        try { request = JSON.parse(line.toString('utf8')); }
        catch { result = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }; }
        if (request !== undefined) result = await dispatch(request);
      }
      if (result) await writeResearchFrame(output, result, outputDeadlineMs);
    }
    if (buffer.length > MAX_FRAME_BYTES) {
      await writeResearchFrame(output, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Research frame exceeds its bound.' } }, outputDeadlineMs);
      return;
    }
  }
  // The daemon is intentionally shared and outlives this stdio client.
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runResearchStdio().catch(() => { process.stderr.write('Research MCP transport stopped.\n'); process.exitCode = 1; });
}

