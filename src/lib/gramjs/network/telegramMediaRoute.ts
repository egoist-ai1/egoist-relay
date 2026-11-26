import type { RouteCandidate, RouteKind } from './connectionPolicy';

import { bufferFromHex, buffersEqual, concat } from '../../../util/encoding/buffer';
import { createObfuscatedHeader } from '../crypto/obfuscatedHeader';
import { raceRoutes, RouteHealth } from './connectionPolicy';

const ABRIDGED_TAG = bufferFromHex('efefefef');
const PROBE_TIMEOUT = 10_000;
const PROBE_VALIDITY = 90_000;
const PROBE_RETRY_INTERVAL = 10_000;
const MAX_RESPONSE_SIZE = 1024;
const PQ_REQUEST = 0xbe7e8ef1;
const PQ_RESPONSE = 0x05162463;
const PAYLOAD_LENGTH = 40;
const NONCE_OFFSET = 24;
const MTPROTO_BODY_OFFSET = 20;

type MediaRoute = {
  health: RouteHealth;
  expiresAt: number;
  selected?: RouteKind;
  preference?: Promise<RouteKind | undefined>;
};

const mediaRoutes = new Map<string, MediaRoute>();

export function getMediaRoute(url: string): MediaRoute {
  const current = mediaRoutes.get(url);
  if (current) return current;
  const created = { expiresAt: 0, health: new RouteHealth() };
  mediaRoutes.set(url, created);
  return created;
}

export function resetMediaRoutes() {
  mediaRoutes.clear();
}

export function selectMediaRoute(state: MediaRoute, candidates: RouteCandidate[], staggerMs = 0) {
  if (state.preference && Date.now() < state.expiresAt) return state.preference;
  state.expiresAt = Number.POSITIVE_INFINITY;
  state.preference = raceRoutes(candidates, probe, { staggerMs }).then(({ candidate, failures }) => {
    failures.forEach(({ kind }) => state.health.recordFailure(kind));
    state.health.recordProbeSuccess(candidate.kind);
    state.selected = candidate.kind;
    state.expiresAt = Date.now() + PROBE_VALIDITY;
    return candidate.kind;
  }, () => {
    state.selected = undefined;
    state.expiresAt = Date.now() + PROBE_RETRY_INTERVAL;
    return undefined;
  });
  return state.preference;
}

// Проверяем ответ Telegram, потому что локальный мост может принять WebSocket до соединения с дата-центром
function probe(candidate: RouteCandidate, signal: AbortSignal) {
  return new Promise<RouteKind>((resolve, reject) => {
    const socket = new WebSocket(candidate.url, 'binary');
    socket.binaryType = 'arraybuffer';
    const { header, encryptor, decryptor } = createObfuscatedHeader(ABRIDGED_TAG);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    let response = new Uint8Array(0);
    const noop = () => undefined;
    const deadline = setTimeout(() => finish(false), PROBE_TIMEOUT);

    function abort() {
      finish(false);
    }
    function finish(isValid: boolean) {
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
      socket.onmessage = noop;
      socket.onopen = noop;
      socket.onclose = noop;
      socket.onerror = noop;
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      if (isValid) resolve(candidate.kind);
      else reject(new Error('Telegram media route did not answer'));
    }

    signal.addEventListener('abort', abort, { once: true });
    socket.onopen = () => {
      const packet = new Uint8Array(1 + PAYLOAD_LENGTH);
      packet[0] = PAYLOAD_LENGTH / 4;
      const view = new DataView(packet.buffer, 1);
      const stamp = Date.now();
      const msgId = (BigInt(Math.floor(stamp / 1000)) << 32n)
        | (BigInt(stamp % 1000) * (1n << 30n) / 1000n << 2n);
      view.setBigUint64(8, msgId, true);
      view.setUint32(16, PAYLOAD_LENGTH - MTPROTO_BODY_OFFSET, true);
      view.setUint32(MTPROTO_BODY_OFFSET, PQ_REQUEST, true);
      packet.set(nonce, 1 + NONCE_OFFSET);
      socket.send(concat(header, encryptor.encrypt(packet)));
    };
    socket.onmessage = ({ data }) => {
      if (!(data instanceof ArrayBuffer) || response.length + data.byteLength > MAX_RESPONSE_SIZE) {
        finish(false);
        return;
      }
      response = concat(response, decryptor.encrypt(new Uint8Array(data)));
      const prefixLength = response[0] === 127 ? 4 : 1;
      if (response.length < prefixLength + PAYLOAD_LENGTH) return;
      const view = new DataView(response.buffer, response.byteOffset + prefixLength);
      finish(view.getBigUint64(0, true) === 0n && view.getUint32(MTPROTO_BODY_OFFSET, true) === PQ_RESPONSE
        && buffersEqual(response.subarray(prefixLength + NONCE_OFFSET, prefixLength + PAYLOAD_LENGTH), nonce));
    };
    socket.onerror = abort;
    socket.onclose = abort;
  });
}
