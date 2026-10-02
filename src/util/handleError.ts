window.addEventListener('error', handleErrorEvent);
window.addEventListener('unhandledrejection', handleErrorEvent);

export function handleError(err: Error) {
  // eslint-disable-next-line no-console
  console.error(err);
}

function handleErrorEvent(e: ErrorEvent | PromiseRejectionEvent) {
  if (e instanceof ErrorEvent) {
    // https://stackoverflow.com/questions/49384120/resizeobserver-loop-limit-exceeded
    if (e.message === 'ResizeObserver loop limit exceeded') {
      return;
    }

    // Flood wait errors
    if (e.message.includes('A wait of')) {
      return;
    }
  }

  e.preventDefault();
  handleError(e instanceof ErrorEvent ? (e.error || e.message) : e.reason);
}
