const CANCEL_POLL_INTERVAL = 100;

export default function waitForMediaTransfer<T>(
  request: Promise<T>,
  isCanceled: () => boolean,
  timeoutMs?: number,
  onAbandon?: VoidFunction,
  onLateResult?: (result: T) => void,
  timeoutCode = 'DOWNLOAD_TIMEOUT',
): Promise<T> {
  return new Promise((resolve, reject) => {
    let hasSettled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (hasSettled) return;
      hasSettled = true;
      clearInterval(interval);
      if (timeout) clearTimeout(timeout);
      if (error) {
        onAbandon?.();
        reject(error);
      }
    };
    const interval = setInterval(() => {
      if (isCanceled()) finish(new Error('USER_CANCELED'));
    }, CANCEL_POLL_INTERVAL);
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => finish(new Error(timeoutCode)), timeoutMs);
    }
    request.then((result) => {
      if (hasSettled) {
        onLateResult?.(result);
        return;
      }
      if (isCanceled()) {
        finish(new Error('USER_CANCELED'));
        onLateResult?.(result);
        return;
      }
      finish();
      resolve(result);
    }, (error: unknown) => {
      if (hasSettled) return;
      finish();
      reject(error);
    });
  });
}
