import { pause } from './schedulers';

type PendingDownload = {
  url: string;
  filename: string;
  isCanceled?: () => boolean;
  onComplete: (didStart: boolean) => void;
};

// Chrome prevents more than 10 downloads per second
const LIMIT_PER_BATCH = 10;
const BATCH_INTERVAL = 1000;

const pendingDownloads: PendingDownload[] = [];
let isProcessing = false;

export default function download(url: string, filename: string, isCanceled?: () => boolean): Promise<boolean> {
  return new Promise((onComplete) => {
    pendingDownloads.push({ url, filename, isCanceled, onComplete });
    if (!isProcessing) {
      isProcessing = true;
      void processQueue();
    }
  });
}

async function processQueue() {
  try {
    while (pendingDownloads.length) {
      await pause(BATCH_INTERVAL);
      const batch = pendingDownloads.splice(0, LIMIT_PER_BATCH);
      batch.forEach(downloadOne);
    }
  } finally {
    isProcessing = false;
  }
}

function downloadOne({ url, filename, isCanceled, onComplete }: PendingDownload) {
  if (isCanceled?.()) {
    onComplete(false);
    return;
  }
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.download = filename;
  try {
    link.click();
    onComplete(true);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err); // Suppress redundant "Blob loading failed" error popup on IOS
    onComplete(false);
  }
}
