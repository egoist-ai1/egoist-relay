// Fixtures model immediate promises at external API boundaries

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type MessagePacker from '../extensions/MessagePacker';
import type RequestState from '../network/RequestState';

import MTProtoSender from '../network/MTProtoSender';
import Api from '../tl/api';
import RPCResult from '../tl/core/RPCResult';
import TLMessage from '../tl/core/TLMessage';

import { AuthKey } from '../crypto/AuthKey';
import Logger from '../extensions/Logger';
type SenderInternals = {
  _sendQueue: MessagePacker;
  _sendQueueLongPoll: MessagePacker;
  _recentSentMessages: Map<bigint, unknown>;
  _sentMessageIdsByState: Map<RequestState, bigint>;
  _sentMessageIdsByContainer: Map<bigint, Set<bigint>>;
  _rememberSentMessage: (state: RequestState) => void;
};
function createSender() {
  const logger = new Logger('error');
  const sender = new MTProtoSender(new AuthKey(), {
    dcId: 1, logger,
  } as ConstructorParameters<typeof MTProtoSender>[1]);
  const internals = sender as unknown as SenderInternals;
  return {
    sender, internals,
  };
}
function createPart(index = 0, size = 16) {
  return new Api.upload.SaveFilePart({
    fileId: 11n, filePart: index, bytes: new Uint8Array(size).fill(index % 251),
  });
}
function trackPackedStates(sender: MTProtoSender, internals: SenderInternals) {
  const packed = internals._sendQueue.get()!;
  for (const state of packed.batch) {
    sender._pendingState.set(state.msgId!, state);
    internals._rememberSentMessage(state);
  }
  return packed;
}
function resolveBool(sender: MTProtoSender, state: RequestState) {
  const body = new Uint8Array(4);
  new DataView(body.buffer).setUint32(0, 0x997275b5, true);
  sender._handleRPCResult(new TLMessage(101n, 1, new RPCResult(state.msgId!, body)));
}
function expectNoMediaState(fixture: ReturnType<typeof createSender>) {
  expect(fixture.internals._sendQueue.values().filter(Boolean)).toHaveLength(0);
  expect(fixture.internals._sendQueue._pendingStates).toHaveLength(0);
  expect(fixture.sender._pendingState.values()).toHaveLength(0);
  expect(fixture.internals._recentSentMessages.size).toBe(0);
  expect(fixture.internals._sentMessageIdsByState.size).toBe(0);
  expect(fixture.internals._sentMessageIdsByContainer.size).toBe(0);
}
// GramJS runs in a dedicated worker where alert is unavailable
beforeAll(() => vi.stubGlobal('alert', undefined));
afterAll(() => vi.unstubAllGlobals());

describe('Relay media sender cancellation isolation', () => {
  test('Pre-aborted media never enters the sender queue', async () => {
    const fixture = createSender();
    const controller = new AbortController();
    controller.abort();
    await expect(fixture.sender.send(createPart(), controller.signal)).rejects.toMatchObject({
      completionUncertain: false,
    });
    await Promise.resolve();
    expectNoMediaState(fixture);
  });
  test('Canceling 1000 queued parts removes their states and retained payloads', async () => {
    const fixture = createSender();
    const controllers: AbortController[] = [];
    const promises: Promise<unknown>[] = [];
    for (let index = 0; index < 1000; index++) {
      const controller = new AbortController();
      controllers.push(controller);
      promises.push(fixture.sender.send(createPart(index, index === 0 ? 512 * 1024 : 16), controller.signal)!);
    }
    const settled = Promise.allSettled(promises);
    expect(fixture.internals._sendQueue._pendingStates).toHaveLength(1000);
    for (const controller of controllers) {
      controller.abort();
    }
    const results = await settled;
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    await Promise.resolve();
    expectNoMediaState(fixture);
  });
  test('An aborted media part leaves a sibling Ping in the same sent container resolvable', async () => {
    const fixture = createSender();
    const controller = new AbortController();
    const media = fixture.sender.send(createPart(0, 512 * 1024), controller.signal)!;
    const mediaRejection = expect(media).rejects.toMatchObject({
      completionUncertain: true,
    });
    const ping = fixture.sender.send(new Api.Ping({
      pingId: 77n,
    }))!;
    const packed = trackPackedStates(fixture.sender, fixture.internals);
    expect(packed.batch).toHaveLength(2);
    expect(packed.batch[0].containerId).toBe(packed.batch[1].containerId);
    controller.abort();
    await mediaRejection;
    expect(fixture.sender._pendingState.values()).toEqual([packed.batch[1]]);
    expect(fixture.internals._recentSentMessages.size).toBe(1);
    const response = new Api.Pong({
      msgId: packed.batch[1].msgId!, pingId: 77n,
    });
    fixture.sender._handleRPCResult(new TLMessage(201n, 1, new RPCResult(packed.batch[1].msgId!, response.getBytes())));
    expect(await ping).toMatchObject({
      pingId: 77n,
    });
    await Promise.resolve();
    expectNoMediaState(fixture);
  });
  test('Late success for an aborted sent part cannot resurrect it or consume a sibling response', async () => {
    const fixture = createSender();
    const firstController = new AbortController();
    const first = fixture.sender.send(createPart(), firstController.signal)!;
    const rejection = expect(first).rejects.toThrow('Request aborted');
    const second = fixture.sender.send(createPart(1), new AbortController().signal)!;
    const packed = trackPackedStates(fixture.sender, fixture.internals);
    firstController.abort();
    await rejection;
    expect(() => resolveBool(fixture.sender, packed.batch[0])).not.toThrow();
    expect(fixture.sender._pendingState.values()).toEqual([packed.batch[1]]);
    resolveBool(fixture.sender, packed.batch[1]);
    expect(await second).toBe(true);
    await Promise.resolve();
    expectNoMediaState(fixture);
  });
  test('Successful completion detaches the abort listener and a later abort preserves settlement', async () => {
    const fixture = createSender();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = fixture.sender.send(createPart(), controller.signal)!;
    const packed = trackPackedStates(fixture.sender, fixture.internals);
    resolveBool(fixture.sender, packed.batch[0]);
    expect(await result).toBe(true);
    await Promise.resolve();
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), {
      once: true,
    });
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    controller.abort();
    expect(await result).toBe(true);
    expectNoMediaState(fixture);
  });
});
