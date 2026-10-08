import { describe, expect, test } from 'vitest';

import {
  buildBudgetError, createRequestBudget, createResolveBudget, describeFlood, isValidResumeOffset, MEDIA_ALIGN_BYTES,
  normalizePeerCacheKey, PeerCache, planMediaRanges, RequestBudget,
} from './researchSupport';

const MIB = MEDIA_ALIGN_BYTES;

describe('RequestBudget', () => {
  test('accepts up to the limit and reports the wait until the oldest stamp expires', () => {
    let now = 1000;
    const budget = new RequestBudget([{ limit: 3, windowMs: 60000 }], () => now);
    expect(budget.take()).toBe(0);
    now += 10000;
    expect(budget.take()).toBe(0);
    now += 10000;
    expect(budget.take()).toBe(0);
    now += 10000;
    expect(budget.take()).toBe(30000);
    // A refused request is not recorded, so the wait does not grow
    now += 29999;
    expect(budget.take()).toBe(1);
    now += 1;
    expect(budget.take()).toBe(0);
  });

  test('every window must have room, the longest wait wins', () => {
    let now = 0;
    const budget = new RequestBudget([{ limit: 2, windowMs: 1000 }, { limit: 3, windowMs: 10000 }], () => now);
    expect(budget.take()).toBe(0);
    expect(budget.take()).toBe(0);
    now = 1000;
    expect(budget.take()).toBe(0);
    now = 2000;
    expect(budget.take()).toBe(8000);
  });

  test('resolve budget allows 12 per minute and 500 per day, request budget 240 per minute', () => {
    let now = 0;
    const resolve = createResolveBudget(() => now);
    for (let index = 0; index < 12; index++) {
      expect(resolve.take()).toBe(0);
    }
    expect(resolve.take()).toBe(60000);
    const requests = createRequestBudget(() => now);
    for (let index = 0; index < 240; index++) {
      expect(requests.take()).toBe(0);
    }
    expect(requests.take()).toBe(60000);
    now = 60000;
    expect(requests.take()).toBe(0);
    // The daily window fills over a day of one request per five seconds
    const daily = createResolveBudget(() => now);
    let taken = 0;
    for (now = 0; now < 86400000 && taken < 500; now += 5000) {
      if (daily.take() === 0) {
        taken++;
      }
    }
    expect(taken).toBe(500);
    expect(daily.take()).toBeGreaterThan(0);
  });

  test('budget error carries seconds, kind and retryAfterMs in the shape the bridge forwards', () => {
    const error = buildBudgetError('RESOLVE_BUDGET', 12345);
    expect(error.message).toBe('RATE_LIMITED');
    expect(error.seconds).toBe(13);
    expect(error.retryAfterMs).toBe(13000);
    expect(error.waitKind).toBe('RESOLVE_BUDGET');
    expect(buildBudgetError('REQUEST_BUDGET', 0).seconds).toBe(1);
    expect(buildBudgetError('REQUEST_BUDGET', 10 ** 10).seconds).toBe(86400);
  });
});

describe('PeerCache', () => {
  test('keeps entries by epoch, expires them and evicts the oldest', () => {
    let now = 0;
    const cache = new PeerCache<number>(() => now);
    cache.set('e1', 'a', 1);
    expect(cache.get('e1', 'a')).toBe(1);
    expect(cache.get('e2', 'a')).toBeUndefined();
    expect(cache.size).toBe(0);
    cache.set('e2', 'a', 2);
    now = 6 * 3600000 - 1;
    expect(cache.get('e2', 'a')).toBe(2);
    now = 6 * 3600000;
    expect(cache.get('e2', 'a')).toBeUndefined();
  });

  test('stays within 5000 entries and a read renews the position', () => {
    const cache = new PeerCache<number>(() => 0);
    for (let index = 0; index < 5000; index++) {
      cache.set('e', `k${index}`, index);
    }
    expect(cache.get('e', 'k0')).toBe(0);
    cache.set('e', 'extra', -1);
    expect(cache.size).toBe(5000);
    expect(cache.get('e', 'k0')).toBe(0);
    expect(cache.get('e', 'k1')).toBeUndefined();
  });

  test('keys ignore the at sign and letter case', () => {
    expect(normalizePeerCacheKey('@SomeChannel')).toBe(normalizePeerCacheKey('somechannel'));
  });
});

describe('describeFlood', () => {
  test('reads seconds from the platform error and classifies the kind', () => {
    expect(describeFlood({ errorMessage: 'FLOOD_WAIT_31', seconds: 31 })).toEqual({
      seconds: 31, waitKind: 'FLOOD_WAIT',
    });
    expect(describeFlood({ errorMessage: 'FLOOD_PREMIUM_WAIT_8', seconds: 8 })).toEqual({
      seconds: 8, waitKind: 'PREMIUM_FLOOD_WAIT',
    });
    expect(describeFlood({ errorMessage: 'SLOWMODE_WAIT_5', seconds: 5 })).toEqual({
      seconds: 5, waitKind: 'SLOWMODE_WAIT',
    });
    expect(describeFlood({ errorMessage: 'FLOOD_WAIT_X', seconds: 2.2 })?.seconds).toBe(3);
    expect(describeFlood({ errorMessage: 'FLOOD_WAIT_X', seconds: 10 ** 7 })?.seconds).toBe(86400);
  });

  test('own budget errors and unrelated errors', () => {
    expect(describeFlood(buildBudgetError('REQUEST_BUDGET', 5000))).toEqual({
      seconds: 5, waitKind: 'REQUEST_BUDGET',
    });
    expect(describeFlood(Object.assign(new Error('RATE_LIMITED'), { retryAfterMs: 4200 }))).toEqual({
      seconds: 5, waitKind: 'FLOOD_WAIT',
    });
    expect(describeFlood({ errorMessage: 'PEER_FLOOD' })).toBeUndefined();
    expect(describeFlood(new Error('CHANNEL_PRIVATE'))).toBeUndefined();
    expect(describeFlood(undefined)).toBeUndefined();
    expect(describeFlood('FLOOD_WAIT_1')).toBeUndefined();
  });
});

describe('resume offsets', () => {
  test('offsets are whole mebibytes inside the file', () => {
    expect(isValidResumeOffset(0, 10)).toBe(true);
    expect(isValidResumeOffset(2 * MIB, 3 * MIB)).toBe(true);
    expect(isValidResumeOffset(3 * MIB, 3 * MIB)).toBe(false);
    expect(isValidResumeOffset(MIB + 1)).toBe(false);
    expect(isValidResumeOffset(-MIB)).toBe(false);
    expect(isValidResumeOffset(1.5 * MIB)).toBe(false);
    expect(isValidResumeOffset('1048576')).toBe(false);
    expect(isValidResumeOffset(MIB)).toBe(true);
  });

  test('ranges cover the rest of the file without crossing a mebibyte boundary', () => {
    const size = 3 * MIB + 100;
    const ranges = planMediaRanges(size, 2 * MIB);
    expect(ranges).toEqual([
      { start: 2 * MIB, end: 3 * MIB - 1 },
      { start: 3 * MIB, end: size - 1 },
    ]);
    const full = planMediaRanges(size, 0);
    expect(full).toHaveLength(4);
    expect(full.reduce((sum, range) => sum + range.end - range.start + 1, 0)).toBe(size);
    expect(planMediaRanges(2 * MIB, 0).at(-1)!.end).toBe(2 * MIB - 1);
    const resumed = planMediaRanges(size, 2 * MIB).reduce((sum, range) => sum + range.end - range.start + 1, 0);
    expect(resumed + 2 * MIB).toBe(size);
  });

  test('a resume point outside the file is a mismatch', () => {
    expect(() => planMediaRanges(2 * MIB, 2 * MIB)).toThrow('RESUME_MISMATCH');
    expect(() => planMediaRanges(2 * MIB, 3 * MIB)).toThrow('RESUME_MISMATCH');
    expect(() => planMediaRanges(2 * MIB, 5)).toThrow('RESUME_MISMATCH');
    expect(() => planMediaRanges(0, 0)).toThrow('RESUME_MISMATCH');
  });
});
