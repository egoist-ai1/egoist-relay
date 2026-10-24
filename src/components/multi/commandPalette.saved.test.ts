import { describe, expect, test } from 'vitest';

import type { MediaOperation } from './mediaOperations.types';

import { buildSavedEntries } from './commandPalette.saved';

const format = {
  getServiceTitle: (service: MediaOperation['service']) => (
    { telegram: 'Telegram', x: 'X', instagram: 'Instagram' }
  )[service],
  formatDate: (timestamp: number) => `д${timestamp}`,
};

function operation(patch: Partial<MediaOperation>): MediaOperation {
  return {
    id: 'op', attempt: 1, revision: 1, kind: 'save', service: 'x', stage: 'completed', createdAt: 1, updatedAt: 2,
    files: [{
      path: 'C:\\Users\\Owner\\Videos\\clip.mp4', fileName: 'clip.mp4', mimeType: 'video/mp4', size: 10,
    }],
    ...patch,
  };
}

describe('Saved entries of the command palette', () => {
  test('Only completed save and download operations are listed, newest first', () => {
    const entries = buildSavedEntries([
      operation({ id: 'old', completedAt: 10 }),
      operation({ id: 'failed', stage: 'failed' }),
      operation({ id: 'send', kind: 'send' }),
      operation({ id: 'download', kind: 'download', completedAt: 30 }),
      operation({ id: 'empty', files: [] }),
    ], format);
    expect(entries.map((entry) => entry.id)).toEqual(['download:0', 'old:0']);
  });

  test('Query and fragment of the source URL and the full file path stay out of the index', () => {
    const [entry] = buildSavedEntries([
      operation({ sourceUrl: 'https://x.com/user/status/1?token=SECRET#frag', completedAt: 5 }),
    ], format);
    const indexed = JSON.stringify([entry.title, entry.subtitle, entry.keywords]);
    expect(indexed).not.toContain('SECRET');
    expect(indexed).not.toContain('frag');
    expect(indexed).not.toContain('Owner');
    expect(entry.keywords).toContain('x.com');
    expect(entry.subtitle).toBe('X · x.com · д5');
    expect(entry.payload).toEqual({ type: 'file', operationId: 'op', index: 0 });
  });

  test('Every file of a multi-file operation is a separate entry with its own index', () => {
    const files = ['a.jpg', 'b.jpg'].map((fileName) => ({
      path: `C:\\${fileName}`, fileName, mimeType: 'image/jpeg', size: 1,
    }));
    const entries = buildSavedEntries([operation({ files })], format);
    expect(entries.map((entry) => entry.payload)).toEqual([
      { type: 'file', operationId: 'op', index: 0 },
      { type: 'file', operationId: 'op', index: 1 },
    ]);
  });

  test('A malformed source URL does not break the list', () => {
    expect(buildSavedEntries([operation({ sourceUrl: 'not a url' })], format)).toHaveLength(1);
  });
});
