import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { startSocialWarmup, WARMUP_READY_DELAY_MS, WARMUP_STEP_GAP_MS } from './socialWarmup';

const COMMANDS = ['multi_prewarm_x', 'multi_prewarm_instagram'] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(overrides: Partial<Parameters<typeof startSocialWarmup>[0]> = {}) {
  const state = { enabled: true, ready: false, lastInputAt: 0 };
  const run = vi.fn(() => Promise.resolve());
  const cancel = startSocialWarmup({
    commands: COMMANDS,
    isEnabled: () => state.enabled,
    isTelegramReady: () => state.ready,
    getLastInputAt: () => state.lastInputAt,
    run,
    ...overrides,
  });
  return { state, run, cancel };
}

describe('startSocialWarmup', () => {
  test('does nothing until Telegram is ready', async () => {
    const { run } = setup();
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).not.toHaveBeenCalled();
  });

  test('waits for readiness to settle and for the user to be idle, then warms up one view at a time', async () => {
    const { state, run } = setup();
    state.ready = true;
    await vi.advanceTimersByTimeAsync(WARMUP_READY_DELAY_MS - 1500);
    expect(run).not.toHaveBeenCalled();

    state.lastInputAt = Date.now();
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith('multi_prewarm_x');

    await vi.advanceTimersByTimeAsync(WARMUP_STEP_GAP_MS + 1200);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith('multi_prewarm_instagram');

    await vi.advanceTimersByTimeAsync(60000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('a lost connection resets the readiness delay', async () => {
    const { state, run } = setup();
    state.ready = true;
    await vi.advanceTimersByTimeAsync(WARMUP_READY_DELAY_MS - 1500);
    state.ready = false;
    await vi.advanceTimersByTimeAsync(2000);
    state.ready = true;
    await vi.advanceTimersByTimeAsync(WARMUP_READY_DELAY_MS - 1500);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('is silent when disabled and starts after the setting is turned on', async () => {
    const { state, run } = setup();
    state.ready = true;
    state.enabled = false;
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).not.toHaveBeenCalled();
    state.enabled = true;
    await vi.advanceTimersByTimeAsync(WARMUP_READY_DELAY_MS + 7000);
    expect(run).toHaveBeenCalled();
  });

  test('reports a failed command and still tries the next one', async () => {
    const onError = vi.fn();
    const run = vi.fn((command: string) => (
      command === 'multi_prewarm_x' ? Promise.reject(new Error('x')) : Promise.resolve()
    ));
    const { state } = setup({ run, onError });
    state.ready = true;
    await vi.advanceTimersByTimeAsync(WARMUP_READY_DELAY_MS + WARMUP_STEP_GAP_MS + 4000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('cancel stops everything', async () => {
    const { state, run, cancel } = setup();
    state.ready = true;
    cancel();
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).not.toHaveBeenCalled();
  });
});
