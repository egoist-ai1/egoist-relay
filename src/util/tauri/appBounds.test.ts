import { describe, expect, it } from 'vitest';

import { resolveAppBounds } from './appBounds';

describe('native service geometry', () => {
  it.each([
    [72, 40, 800, 560], [144, 80, 800, 560], [108, 60, 1652, 1160],
  ])('follows measured sidebar %ipx and titlebar %ipx', (x, y, width, height) => {
    expect(resolveAppBounds({ x, y, width: width - x, height: height - y },
      { width, height }, { width, height })).toEqual({ x, y, width: width - x, height: height - y });
  });
  it('converts browser zoom CSS pixels to native logical coordinates', () => {
    expect(resolveAppBounds({ x: 72, y: 40, width: 328, height: 240 },
      { width: 400, height: 280 }, { width: 800, height: 560 }))
      .toEqual({ x: 144, y: 80, width: 656, height: 480 });
  });
  it('rounds edges together and clamps to the window', () => {
    expect(resolveAppBounds({ x: 72.4, y: 40.6, width: 1000, height: 1000 },
      { width: 800, height: 560 }, { width: 800, height: 560 }))
      .toEqual({ x: 72, y: 41, width: 728, height: 519 });
  });
  it('rejects hidden, non-finite and out-of-window geometry', () => {
    for (const rect of [
      { x: 0, y: 0, width: 0, height: 0 }, { x: -1, y: 0, width: 2, height: 2 },
      { x: NaN, y: 0, width: 2, height: 2 }, { x: 900, y: 40, width: 10, height: 10 },
    ]) expect(() => resolveAppBounds(rect, { width: 800, height: 560 }, { width: 800, height: 560 })).toThrow();
  });
});
