import { describe, expect, test } from 'vitest';

import MediaOperationQueue from './mediaOperationQueue';

async function flush() {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve();
  }
}

describe('Application media queue', () => {
  test('One worker owns media and only eight captures may wait', async () => {
    const queue = new MediaOperationQueue();
    queue.setLocked(false);
    let finish!: () => void;
    const starts: number[] = [];
    queue.add({
      id: '0',
      kind: 'save',
      run: () => new Promise<void>((resolve) => {
        starts.push(0);
        finish = resolve;
      }),
    });
    for (let index = 1; index <= 8; index++) {
      queue.add({
        id: String(index),
        kind: 'save',
        run: () => {
          starts.push(index);
          return Promise.resolve();
        },
      });
    }
    expect(() => queue.add({ id: '9', kind: 'save', run: () => Promise.resolve() })).toThrow('MEDIA_QUEUE_FULL');
    await flush();
    expect(starts).toEqual([0]);
    expect(queue.cancel('4')).toBe(true);
    finish();
    for (let index = 0; index < 12; index++) {
      await flush();
    }
    expect(starts).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
    expect(queue.size).toBe(0);
  });

  test('Lock holds future sends while local saving remains independent', async () => {
    const queue = new MediaOperationQueue();
    const starts: string[] = [];
    queue.add({
      id: 'send',
      kind: 'send',
      run: () => {
        starts.push('send');
        return Promise.resolve();
      },
    });
    queue.add({
      id: 'save',
      kind: 'save',
      run: () => {
        starts.push('save');
        return Promise.resolve();
      },
    });
    await flush();
    expect(starts).toEqual(['save']);
    queue.setLocked(false);
    await flush();
    expect(starts).toEqual(['save', 'send']);
  });

  test('A failed task releases the worker and a canceled waiting task never starts', async () => {
    const queue = new MediaOperationQueue();
    const starts: string[] = [];
    queue.add({
      id: 'canceled',
      kind: 'send',
      run: () => {
        starts.push('canceled');
        return Promise.resolve();
      },
    });
    queue.cancel('canceled');
    queue.add({ id: 'failed', kind: 'save', run: () => Promise.reject(new Error('DISK_FULL')) });
    queue.add({
      id: 'next',
      kind: 'save',
      run: () => {
        starts.push('next');
        return Promise.resolve();
      },
    });
    await flush();
    expect(starts).toEqual(['next']);
  });
});
