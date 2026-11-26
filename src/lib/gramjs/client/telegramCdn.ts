import type TelegramClient from './TelegramClient';

import { concat } from '../../../util/encoding/buffer';
import waitForMediaTransfer from '../../../util/waitForMediaTransfer';
import { ConnectionTCPObfuscated, MTProtoSender } from '../network';
import { Api, serializeBytes } from '../tl';

import { AuthKey } from '../crypto/AuthKey';
import { readBigIntFromBuffer, sha1 } from '../Helpers';
import { LAYER } from '../tl/AllTLObjects';

const CONNECTION_TIMEOUT = 12_000;
const IDLE_TIMEOUT = 30_000;
type CdnSender = { sender: MTProtoSender; expires?: ReturnType<typeof setTimeout> };
const sessions = new WeakMap<TelegramClient, Map<number, Promise<CdnSender>>>();

export async function readCdnPublicKey(pem: string) {
  const match = pem.trim().match(/^-----BEGIN (RSA PUBLIC KEY|PUBLIC KEY)-----\s+([A-Za-z0-9+/=\s]+)-----END \1-----$/);
  if (!match || match[2].length > 1024) throw new Error('MEDIA_CDN_INVALID_KEY');
  const der = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
  let offset = 0;
  const read = (tag: number) => {
    if (der[offset++] !== tag) throw new Error('MEDIA_CDN_INVALID_KEY');
    let length = der[offset++];
    if (length >= 128) {
      const lengthBytes = length - 128;
      if (lengthBytes < 1 || lengthBytes > 2) throw new Error('MEDIA_CDN_INVALID_KEY');
      length = 0;
      for (let i = 0; i < lengthBytes; i++) length = length * 256 + der[offset++];
    }
    const start = offset;
    const end = start + length;
    if (!Number.isSafeInteger(end) || end > der.length) throw new Error('MEDIA_CDN_INVALID_KEY');
    offset = end;
    return { start, end };
  };
  const root = read(0x30);
  if (root.end !== der.length) throw new Error('MEDIA_CDN_INVALID_KEY');
  offset = root.start;
  if (match[1] === 'PUBLIC KEY') {
    read(0x30);
    const bits = read(0x03);
    if (bits.end !== root.end || der[bits.start] !== 0) throw new Error('MEDIA_CDN_INVALID_KEY');
    offset = bits.start + 1;
    const pair = read(0x30);
    if (pair.end !== bits.end) throw new Error('MEDIA_CDN_INVALID_KEY');
    offset = pair.start;
  }
  const nField = read(0x02);
  const eField = read(0x02);
  const n = der.subarray(nField.start + 1, nField.end);
  const e = der.subarray(eField.start, eField.end);
  if (der[nField.start] !== 0 || n.length !== 256 || n[0] < 128
    || eField.end !== root.end || e.length !== 3 || readBigIntFromBuffer(e, false) !== 65537n) {
    throw new Error('MEDIA_CDN_INVALID_KEY');
  }
  const fingerprint = readBigIntFromBuffer((await sha1(concat(serializeBytes(n), serializeBytes(e)))).slice(-8),
    true, true);
  return { fingerprint, key: { n: readBigIntFromBuffer(n, false), e: 65537 } };
}

async function openCdnSender(client: TelegramClient, dcId: number) {
  const [config, cdnConfig] = await waitForMediaTransfer(Promise.all([
    client.invoke(new Api.help.GetConfig()), client.invoke(new Api.help.GetCdnConfig()),
  ]), () => false, CONNECTION_TIMEOUT);
  const endpoint = config.dcOptions.find((option) => option.cdn && option.id === dcId
    && !option.ipv6 && option.port === 443);
  if (!endpoint) throw new Error('MEDIA_CDN_NO_ENDPOINT');
  const publicKeys = await Promise.all(cdnConfig.publicKeys.filter((entry) => entry.dcId === dcId)
    .map((entry) => readCdnPublicKey(entry.publicKey)));
  if (!publicKeys.length) throw new Error('MEDIA_CDN_NO_KEY');
  const connection = new ConnectionTCPObfuscated({
    ip: endpoint.ipAddress, port: endpoint.port, dcId, loggers: client._log,
  });
  const sender = new MTProtoSender(new AuthKey(), {
    logger: client._log,
    dcId,
    retries: 1,
    retriesToFallback: 0,
    retryMainConnectionDelay: CONNECTION_TIMEOUT,
    delay: 1000,
    autoReconnect: false,
    shouldForceHttpTransport: false,
    shouldAllowHttpTransport: false,
    connectTimeout: CONNECTION_TIMEOUT,
    authKeyCallback: undefined,
    authServerKeys: new Map(publicKeys.map(({ fingerprint, key }) => [fingerprint, key])),
    isExported: true,
  });
  try {
    await waitForMediaTransfer(sender.connect(connection, false), () => false, CONNECTION_TIMEOUT,
      () => sender.disconnect(), () => sender.disconnect());
    return { sender } satisfies CdnSender;
  } catch (error) {
    sender.disconnect();
    throw error;
  }
}

export async function requestCdnFile(
  client: TelegramClient, dcId: number, request: Api.upload.GetCdnFile, signal: AbortSignal,
) {
  let pool = sessions.get(client);
  if (!pool) {
    pool = new Map();
    sessions.set(client, pool);
  }
  let pending = pool.get(dcId);
  if (pending && !await pending.then(({ sender }) => sender.isConnected(), () => false)) {
    if (pool.get(dcId) === pending) pool.delete(dcId);
    pending = pool.get(dcId);
  }
  pending ??= openCdnSender(client, dcId);
  pool.set(dcId, pending);
  const active = pending;
  try {
    const session = await active;
    clearTimeout(session.expires);
    session.expires = setTimeout(() => {
      // После обрыва у этого дата-центра уже может быть новая сессия.
      if (pool.get(dcId) === active) pool.delete(dcId);
      session.sender.disconnect();
    }, IDLE_TIMEOUT);
    signal.throwIfAborted();
    // Сессия CDN получает отдельный ключ и только нейтральные параметры клиента.
    const init = new Api.InvokeWithLayer({
      layer: LAYER,
      query: new Api.InitConnection({
        apiId: client.apiId,
        deviceModel: 'Desktop',
        systemVersion: '1.0',
        appVersion: '1.0',
        langCode: 'en',
        langPack: '',
        systemLangCode: 'en',
        query: request,
      }),
    });
    return await session.sender.send(init, signal) as Api.upload.TypeCdnFile;
  } catch (error) {
    if (!signal.aborted) {
      if (pool.get(dcId) === active) pool.delete(dcId);
      void active.then(({ sender, expires }) => {
        clearTimeout(expires);
        sender.disconnect();
      }, () => undefined);
    }
    throw error;
  }
}
