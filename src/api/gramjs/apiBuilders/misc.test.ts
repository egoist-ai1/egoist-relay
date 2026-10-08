import { describe, expect, test } from 'vitest';

import type { Api as GramJs } from '../../../lib/gramjs';

import { buildApiSession, buildApiWebSession } from './misc';

function makeAuthorization(overrides: Record<string, unknown> = {}) {
  return {
    current: true, hash: BigInt(42), deviceModel: 'PC', platform: 'Windows', systemVersion: '11',
    appName: 'Relay', appVersion: '1.7.0', dateCreated: 1790000000, dateActive: 1790001000,
    ip: '1.1.1.1', country: 'RU', region: 'MSK', ...overrides,
  } as unknown as GramJs.Authorization;
}

describe('buildApiSession', () => {
  test('сохраняет время входа и активности отдельно', () => {
    const session = buildApiSession(makeAuthorization());
    expect(session.dateCreated).toBe(1790000000);
    expect(session.dateActive).toBe(1790001000);
  });

  test('если Telegram не отдал время входа, оно 0, а не выдуманное', () => {
    const session = buildApiSession(makeAuthorization({ dateCreated: undefined }));
    expect(session.dateCreated).toBe(0);
    expect(session.dateActive).toBe(1790001000);
  });
});

describe('buildApiWebSession', () => {
  test('сохраняет время входа веб-сеанса', () => {
    const session = buildApiWebSession({
      hash: BigInt(7), botId: BigInt(5), domain: 'x.io', browser: 'Chrome', platform: 'Win',
      dateCreated: 1790000000, dateActive: 1790001000, ip: '2.2.2.2', region: 'MSK',
    } as unknown as GramJs.WebAuthorization);
    expect(session.dateCreated).toBe(1790000000);
    expect(session.dateActive).toBe(1790001000);
  });
});
