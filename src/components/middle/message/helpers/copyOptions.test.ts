import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ApiMessage } from '../../../../api/types';

const { showNotification, copyCommand } = vi.hoisted(() => ({
  showNotification: vi.fn(), copyCommand: vi.fn(),
}));
vi.mock('../../../../global', () => ({ getActions: () => ({ showNotification }) }));
vi.mock('../../../../global/helpers', () => ({
  getMessageContact: () => undefined,
  getMessagePhoto: () => undefined,
  getMessageText: () => undefined,
  getPhotoMediaHash: () => undefined,
  getWebPagePhoto: () => undefined,
  getWebPageVideo: () => undefined,
  hasMediaLocalBlobUrl: () => false,
}));
vi.mock('../../../../util/browser/windowEnvironment', () => ({ IS_SAFARI: false }));
vi.mock('../../../../util/mediaLoader', () => ({ fetch: vi.fn() }));
vi.mock('./getSelectionAsFormattedText', () => ({ captureMessageCopyRequest: vi.fn() }));

import { getMessageCopyOptions } from './copyOptions';

const originalCopyCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
const message: ApiMessage = { id: 1, chatId: 'test-chat', date: 1, isOutgoing: false, content: {} };

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(document, 'execCommand', { configurable: true, value: copyCommand });
});

afterEach(() => {
  if (originalCopyCommand) Object.defineProperty(document, 'execCommand', originalCopyCommand);
  else Reflect.deleteProperty(document, 'execCommand');
});

describe('Link copy feedback', () => {
  test('Reports clipboard rejection without confirming or closing the menu', () => {
    copyCommand.mockReturnValue(false);
    const afterEffect = vi.fn();
    const options = getMessageCopyOptions(message, undefined, 1, 'thread', 'https://example.com', true, afterEffect);
    options.find((option) => option.label === 'lng_context_copy_link')!.handler();

    expect(copyCommand).toHaveBeenCalledWith('copy');
    expect(afterEffect).not.toHaveBeenCalled();
    expect(showNotification).toHaveBeenCalledWith({ message: { key: 'GeneralError' } });
    expect(document.querySelector('textarea.visually-hidden')).toBeFalsy();
  });

  test('Confirms a successful clipboard write once', () => {
    copyCommand.mockReturnValue(true);
    const afterEffect = vi.fn();
    const options = getMessageCopyOptions(message, undefined, 1, 'thread', 'https://example.com', true, afterEffect);
    options.find((option) => option.label === 'lng_context_copy_link')!.handler();

    expect(afterEffect).toHaveBeenCalledOnce();
    expect(showNotification).not.toHaveBeenCalled();
  });
});
