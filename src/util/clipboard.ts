import type { ClipboardTextContent, ClipboardTextFormat } from '../types/messageCopy';

export const CLIPBOARD_ITEM_SUPPORTED = window.navigator.clipboard && window.ClipboardItem;

const IMAGE_COPY_TIMEOUT = 15000;
const MAX_IMAGE_COPY_PIXELS = 32 * 1024 * 1024;

const textCopyEl = document.createElement('textarea');
textCopyEl.setAttribute('readonly', '');
textCopyEl.tabIndex = -1;
textCopyEl.className = 'visually-hidden';

export const copyTextToClipboard = (str: string): boolean => {
  textCopyEl.value = str;
  document.body.appendChild(textCopyEl);
  const selection = document.getSelection();
  let isCopied = false;

  if (selection) {
    // Store previous selection
    const rangeToRestore = selection.rangeCount > 0 && selection.getRangeAt(0);
    textCopyEl.select();
    isCopied = document.execCommand('copy');
    // Restore the original selection
    if (rangeToRestore) {
      selection.removeAllRanges();
      selection.addRange(rangeToRestore);
    }
  }

  document.body.removeChild(textCopyEl);
  return isCopied;
};

export async function copyImageToClipboard(imageUrl?: string | Promise<string | undefined>): Promise<boolean> {
  if (!imageUrl || !CLIPBOARD_ITEM_SUPPORTED || !navigator.clipboard.write) return false;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('CLIPBOARD_IMAGE_TIMEOUT'));
    }, IMAGE_COPY_TIMEOUT);
  });
  const pngPromise = Promise.resolve(imageUrl).then((url) => buildClipboardImage(url, controller.signal));
  try {
    // The clipboard write starts within the user gesture while the image is prepared
    const writePromise = navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);
    await Promise.race([Promise.all([pngPromise, writePromise]), deadline]);
    return true;
  } catch {
    // A clipboard implementation can reject the promise item before consuming its data
    void pngPromise.catch(() => {});
    return false;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function buildClipboardImage(imageUrl: string | undefined, signal: AbortSignal): Promise<Blob> {
  if (!imageUrl || signal.aborted) return Promise.reject(new Error('EMPTY_CLIPBOARD_CONTENT'));
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cancel = () => finish();
    function finish(blob?: Blob) {
      signal.removeEventListener('abort', cancel);
      image.onload = () => {};
      image.onerror = () => {};
      image.removeAttribute('src');
      if (blob) resolve(blob);
      else reject(new Error('CLIPBOARD_IMAGE_FAILED'));
    }
    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!width || !height || width * height > MAX_IMAGE_COPY_PIXELS) {
        finish();
        return;
      }
      try {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) {
          finish();
          return;
        }
        canvas.width = width;
        canvas.height = height;
        context.drawImage(image, 0, 0, width, height);
        canvas.toBlob((blob) => finish(blob || undefined), 'image/png');
      } catch {
        finish();
      }
    };
    image.onerror = () => finish();
    signal.addEventListener('abort', cancel, { once: true });
    image.crossOrigin = 'anonymous';
    image.src = imageUrl;
  });
}

export async function copyTextToClipboardFromPromise(
  getContentPromise: Promise<string | ClipboardTextContent | undefined>,
  onSuccess?: NoneToVoidFunction,
  onFailure?: NoneToVoidFunction,
  textFormat?: ClipboardTextFormat,
) {
  const contentPromise = getContentPromise.then((content) => {
    if (!content) throw new Error('EMPTY_CLIPBOARD_CONTENT');
    return typeof content === 'string'
      ? { plainText: content, html: content, markdown: content }
      : content;
  });
  try {
    if (!CLIPBOARD_ITEM_SUPPORTED || !navigator.clipboard.write) throw new Error('CLIPBOARD_ITEM_UNSUPPORTED');

    if (textFormat) {
      const plainTextPromise = contentPromise.then((content) => content[textFormat]);
      await navigator.clipboard.write([buildPlainTextClipboardItem(plainTextPromise)]);
    } else {
      const canWriteMarkdown = !ClipboardItem.supports || ClipboardItem.supports('text/markdown');
      await navigator.clipboard.write([buildTextClipboardItem(contentPromise, canWriteMarkdown)]);
    }
  } catch {
    try {
      const content = await contentPromise;
      if (!textFormat && CLIPBOARD_ITEM_SUPPORTED) {
        try {
          await navigator.clipboard.write([buildTextClipboardItem(content)]);
          onSuccess?.();
          return;
        } catch {
          // Fall through to the synchronous plain-text fallback
        }
      }
      if (!copyTextToClipboard(textFormat ? content[textFormat] : content.plainText)) {
        throw new Error('CLIPBOARD_WRITE_FAILED');
      }
    } catch {
      onFailure?.();
      return;
    }
  }

  onSuccess?.();
}

function buildPlainTextClipboardItem(content: string | Promise<string>) {
  return new ClipboardItem({
    'text/plain': buildPlainTextClipboardBlob(content),
  });
}

function buildTextClipboardItem(
  content: ClipboardTextContent | Promise<ClipboardTextContent>,
  withMarkdown = false,
) {
  const data: Record<string, Blob | Promise<Blob>> = {
    'text/plain': buildClipboardBlob(content, 'plainText', 'text/plain'),
    'text/html': buildClipboardBlob(content, 'html', 'text/html'),
  };
  if (withMarkdown) {
    data['text/markdown'] = buildClipboardBlob(content, 'markdown', 'text/markdown');
  }

  return new ClipboardItem(data);
}

function buildClipboardBlob(
  content: ClipboardTextContent | Promise<ClipboardTextContent>,
  key: keyof ClipboardTextContent,
  type: string,
): Blob | Promise<Blob> {
  if (content instanceof Promise) return content.then((value) => buildClipboardBlob(value, key, type));
  const value = content[key];
  if (!content.plainText) throw new Error('EMPTY_CLIPBOARD_CONTENT');
  return new Blob([value], { type });
}

function buildPlainTextClipboardBlob(content: string | Promise<string>): Blob | Promise<Blob> {
  if (content instanceof Promise) return content.then(buildPlainTextClipboardBlob);
  if (!content) throw new Error('EMPTY_CLIPBOARD_CONTENT');
  return new Blob([content], { type: 'text/plain' });
}
