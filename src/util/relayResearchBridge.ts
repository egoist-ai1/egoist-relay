import type { UnlistenFn } from '@tauri-apps/api/event';
import { getGlobal } from '../global';

import type {
  RelayResearchArgs, RelayResearchEvent, RelayResearchInput, RelayResearchResult,
} from '../api/gramjs/methods/research';

import { callApi } from '../api/gramjs';
import { onBeforeUnload } from './schedulers';
type Operation = NonNullable<RelayResearchArgs['operation']>;
type Binding = NonNullable<RelayResearchArgs['expectedAccount']>;
type Request = {
  requestId: string;
  nonce: string;
  method: 'status' | 'capabilities' | 'run';
  provider?: string;
  operation?: Operation;
  input?: RelayResearchInput;
  jobId?: string;
  deadlineMs: number;
  expectedAccount?: Binding;
};
type ActiveRequest = {
  request: Request;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  account?: Binding;
  phase: 'status' | 'starting' | 'running';
  isTerminal: boolean;
  completionUncertain?: boolean;
  cancelCode?: string;
  pending?: Promise<RelayResearchResult | undefined>;
  cancellation?: Promise<void>;
};
type ProviderStatus = {
  provider: 'telegram';
  state: 'ready' | 'initializing' | 'auth_required' | 'unavailable';
  reason?: string;
  accountRef?: string;
  accountEpoch?: string;
  operations: Operation[];
};
const OPERATIONS: Operation[] = [
  'discover', 'chat_info', 'read', 'search', 'channel_history', 'chat_export', 'download', 'join_chat',
];
const MAX_DEADLINE_MS = 300000;
const MAX_READY_ATTEMPTS = 20;
const MAX_READY_WAIT_MS = 120000;
const READY_INITIAL_RETRY_MS = 250;
const READY_MAX_RETRY_MS = 5000;
const READY_RETRY_ERRORS = new Set(['BRIDGE_STARTING', 'BRIDGE_RECOVERY_WAIT', 'BRIDGE_UNAVAILABLE']);
const REQUEST_FIELDS = new Set([
  'requestId', 'nonce', 'method', 'provider', 'operation', 'input', 'jobId', 'deadlineMs', 'expectedAccount',
]);
const ACTIVE_REQUESTS = new Map<string, ActiveRequest>();
let startup: Promise<void> | undefined;
export function startRelayResearchBridge() {
  startup ??= registerBridge();
  return startup;
}
async function registerBridge() {
  const listeners: UnlistenFn[] = [];
  let isClosed = false;
  let readyAttempts = 0;
  let readyExpiresAt: number | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let readiness: Promise<void> | undefined;
  onBeforeUnload(stopBridge);
  try {
    const [{ listen }, { invoke }] = await Promise.all([
      import('@tauri-apps/api/event'), import('@tauri-apps/api/core'),
    ]);
    if (isClosed) {
      return;
    }
    listeners.push(await listen<Request>('relay-research-request', ({ payload }) => {
      if (!isClosed) {
        void handleRequest(payload).catch(() => undefined);
      }
    }));
    if (isClosed) {
      clearListeners();
      return;
    }
    listeners.push(await listen<{
      requestId: string;
      nonce: string;
    }>('relay-research-cancel', ({ payload }) => {
      const active = ACTIVE_REQUESTS.get(payload?.requestId);
      if (!isClosed && active && active.request.nonce === payload.nonce) {
        void cancelRequest(active, 'CANCELLED');
      }
    }));
    if (isClosed) {
      clearListeners();
      return;
    }
    await registerReady(() => invoke<void>('relay_research_ready'));
  } catch {
    stopBridge();
  }
  function registerReady(invokeReady: () => Promise<void>): Promise<void> {
    if (readiness) {
      return readiness;
    }
    readyExpiresAt ??= Date.now() + MAX_READY_WAIT_MS;
    if (isClosed || readyAttempts >= MAX_READY_ATTEMPTS || Date.now() >= readyExpiresAt) {
      return Promise.resolve();
    }
    readyAttempts++;
    readiness = Promise.resolve().then(invokeReady).catch((err: unknown) => {
      const remainingMs = readyExpiresAt! - Date.now();
      if (isClosed || readyAttempts >= MAX_READY_ATTEMPTS || remainingMs <= 0
        || typeof err !== 'string' || !READY_RETRY_ERRORS.has(err)) {
        return;
      }
      const retryMs = Math.min(READY_INITIAL_RETRY_MS * (2 ** (readyAttempts - 1)), READY_MAX_RETRY_MS, remainingMs);
      readyTimer = setTimeout(() => {
        readyTimer = undefined;
        void registerReady(invokeReady);
      }, retryMs);
    }).finally(() => {
      readiness = undefined;
    });
    return readiness;
  }
  function stopBridge() {
    isClosed = true;
    if (readyTimer !== undefined) {
      clearTimeout(readyTimer);
      readyTimer = undefined;
    }
    clearListeners();
    ACTIVE_REQUESTS.forEach((active) => {
      void cancelRequest(active, 'CANCELLED');
    });
  }
  function clearListeners() {
    listeners.splice(0).forEach((unlisten) => unlisten());
  }
}
async function handleRequest(request: Request) {
  if (!isAddressedRequest(request)) {
    return;
  }
  if (ACTIVE_REQUESTS.has(request.requestId)) {
    return;
  }
  if (!isValidRequest(request)) {
    await publish(request, {
      kind: 'error', code: 'INVALID_INPUT', reason: 'INVALID_INPUT',
    });
    return;
  }
  if (request.method !== 'run') {
    const status = await fetchStatus();
    await publish(request, {
      kind: 'status', providers: [status],
    });
    return;
  }
  if (request.provider !== 'telegram') {
    await publish(request, {
      kind: 'error', code: 'UNSUPPORTED', reason: 'UNSUPPORTED',
    });
    return;
  }
  if ([...ACTIVE_REQUESTS.values()].some((active) => active.request.provider === 'telegram')) {
    await publish(request, {
      kind: 'error', code: 'BUSY', reason: 'BUSY',
    });
    return;
  }
  const active: ActiveRequest = {
    request, expiresAt: Date.now() + request.deadlineMs, phase: 'status', isTerminal: false,
    timer: setTimeout(() => {
      void cancelRequest(active, 'DEADLINE_EXCEEDED');
    }, request.deadlineMs),
  };
  ACTIVE_REQUESTS.set(request.requestId, active);
  try {
    const status = await fetchStatus(active);
    if (active.cancelCode) {
      await settleCancellation(active);
      return;
    }
    if (status.state !== 'ready') {
      const code = status.state === 'initializing' ? 'INITIALIZING'
        : status.state === 'auth_required' ? 'AUTH_REQUIRED' : 'UNAVAILABLE';
      await publishError(active, code);
      return;
    }
    if (status.accountRef !== request.expectedAccount?.accountRef
      || status.accountEpoch !== request.expectedAccount?.accountEpoch) {
      await publishError(active, 'STALE_ACCOUNT');
      return;
    }
    active.account = {
      accountRef: status.accountRef!, accountEpoch: status.accountEpoch!,
    };
    await publish(request, {
      kind: 'status', providers: [status],
    });
    if (active.cancelCode) {
      await settleCancellation(active);
      return;
    }
    const deadlineMs = Math.min(request.input?.deadlineMs ?? MAX_DEADLINE_MS, active.expiresAt - Date.now());
    if (deadlineMs <= 0) {
      await cancelRequest(active, 'DEADLINE_EXCEEDED');
      await settleCancellation(active);
      return;
    }
    active.phase = 'starting';
    let result = await callWorker(active, {
      command: 'start', jobId: request.jobId,
      operation: request.operation, input: {
        ...request.input, deadlineMs,
      }, expectedAccount: active.account,
    });
    active.phase = 'running';
    while (result) {
      if (active.cancelCode) {
        await settleCancellation(active);
        return;
      }
      if (!isAccountReady()) {
        await cancelRequest(active, 'STALE_ACCOUNT');
        await settleCancellation(active);
        return;
      }
      for (const event of result.events) {
        if (active.cancelCode) {
          await settleCancellation(active);
          return;
        }
        await publish(request, event);
        if (event.kind === 'done' || event.kind === 'error') {
          active.isTerminal = true;
        }
      }
      if (result.isFinished) {
        if (!active.isTerminal) {
          await publishError(active, 'UNAVAILABLE');
        }
        return;
      }
      result = await callWorker(active, {
        command: 'next', jobId: request.jobId, expectedAccount: active.account,
      });
    }
    await publishError(active, 'INITIALIZING');
  } catch {
    await cancelRequest(active, 'UNAVAILABLE');
    await settleCancellation(active).catch(() => undefined);
  } finally {
    clearTimeout(active.timer);
    if (ACTIVE_REQUESTS.get(request.requestId) === active) {
      ACTIVE_REQUESTS.delete(request.requestId);
    }
  }
}
async function fetchStatus(active?: ActiveRequest): Promise<ProviderStatus> {
  if (!isAccountReady()) {
    const authState = getGlobal().auth.state;
    return {
      provider: 'telegram', state: authState ? 'auth_required' : 'initializing',
      reason: authState ? 'AUTH_REQUIRED' : 'INITIALIZING', operations: [...OPERATIONS],
    };
  }
  const result = active ? await callWorker(active, {
    command: 'status',
  }) : await callApi('relayResearch', {
    command: 'status',
  });
  const status = result?.events.find((event) => event.kind === 'status');
  const providers = status?.providers;
  const provider: unknown = Array.isArray(providers) ? providers[0] : undefined;
  if (provider && typeof provider === 'object' && 'state' in provider && 'accountRef' in provider
    && 'accountEpoch' in provider && typeof provider.accountRef === 'string'
    && typeof provider.accountEpoch === 'string'
    && ['ready', 'initializing', 'auth_required', 'unavailable'].includes(String(provider.state))) {
    return {
      provider: 'telegram', state: provider.state as ProviderStatus['state'],
      accountRef: provider.accountRef, accountEpoch: provider.accountEpoch, operations: [...OPERATIONS],
    };
  }
  return {
    provider: 'telegram', state: 'initializing', reason: 'INITIALIZING', operations: [...OPERATIONS],
  };
}
async function callWorker(active: ActiveRequest, args: RelayResearchArgs) {
  const pending = callApi('relayResearch', args);
  active.pending = pending;
  try {
    const result = await pending;
    if (result?.events.some((event) => event.kind === 'error' && event.completionUncertain === true)) {
      active.completionUncertain = true;
    }
    return result;
  } finally {
    if (active.pending === pending) {
      active.pending = undefined;
    }
  }
}
function cancelRequest(active: ActiveRequest, code: string): Promise<void> {
  active.cancelCode ??= code;
  active.cancellation ??= cancelWorker(active);
  return active.cancellation;
}
async function cancelWorker(active: ActiveRequest) {
  if (active.phase === 'starting') {
    await active.pending?.catch(() => undefined);
  }
  try {
    await callApi('relayResearch', {
      command: 'cancel', jobId: active.request.jobId,
    });
  } catch {
    // The active worker promise remains the settlement authority
  }
  await active.pending?.catch(() => undefined);
}
async function settleCancellation(active: ActiveRequest) {
  await active.cancellation;
  await publishError(active, active.cancelCode ?? 'CANCELLED');
}
async function publishError(active: ActiveRequest, code: string) {
  if (active.isTerminal) {
    return;
  }
  await publish(active.request, {
    kind: 'error', code, reason: active.completionUncertain ? 'cancelled_completion_uncertain' : code,
    completionUncertain: active.completionUncertain,
    accountRef: active.account?.accountRef, accountEpoch: active.account?.accountEpoch,
  });
  active.isTerminal = true;
}
async function publish(request: Request, event: RelayResearchEvent) {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke<void>('relay_research_reply', {
    requestId: request.requestId, nonce: request.nonce, event,
  });
}
function isAccountReady() {
  return getGlobal().auth.state === 'authorizationStateReady';
}
function isAddressedRequest(value: Request) {
  return value && typeof value === 'object'
    && typeof value.requestId === 'string' && /^[a-z0-9_-]{1,128}$/i.test(value.requestId)
    && typeof value.nonce === 'string' && /^[a-z0-9_-]{1,128}$/i.test(value.nonce);
}
function isValidRequest(value: Request) {
  if (Object.keys(value).some((key) => !REQUEST_FIELDS.has(key))
    || !['status', 'capabilities', 'run'].includes(value.method)
    || !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs <= 0 || value.deadlineMs > MAX_DEADLINE_MS) {
    return false;
  }
  if (value.method !== 'run') {
    return true;
  }
  return typeof value.jobId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.jobId)
    && Boolean(value.operation && OPERATIONS.includes(value.operation))
    && Boolean(value.expectedAccount && typeof value.expectedAccount.accountRef === 'string'
      && typeof value.expectedAccount.accountEpoch === 'string');
}
