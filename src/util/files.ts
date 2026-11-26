import { CONTENT_TYPES_WITH_PREVIEW } from '../config';

const VIDEO_METADATA_TIMEOUT = 10_000;
const VIDEO_POSTER_TIMEOUT = 2_000;
const MAX_VIDEO_POSTER_SIZE = 320;
const VIDEO_POSTER_QUALITY = 0.85;

// Polyfill for Safari: `File` is not available in web worker
if (typeof File === 'undefined') {
  self.File = class extends Blob {
    name: string;

    constructor(fileBits: BlobPart[], fileName: string, options?: FilePropertyBag) {
      if (options) {
        const { type, ...rest } = options;
        super(fileBits, { type });
        Object.assign(this, rest);
      } else {
        super(fileBits);
      }

      this.name = fileName;
    }
  } as typeof File;
}

export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e: ProgressEvent<FileReader>) => {
      const { result } = e.target || {};
      if (typeof result === 'string') {
        resolve(result);
      }

      reject(new Error('Failed to read blob'));
    };

    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function blobToFile(blob: Blob, fileName: string) {
  return new File([blob], fileName, {
    lastModified: Date.now(),
    type: blob.type,
  });
}

export function preloadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export function preloadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const timeout = setTimeout(() => handleError(new Error('VIDEO_METADATA_TIMEOUT')), VIDEO_METADATA_TIMEOUT);
    function cleanup() {
      clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', handleLoaded);
      video.removeEventListener('error', handleError);
    }
    function handleLoaded() {
      cleanup();
      resolve(video);
    }
    function handleError(err: unknown) {
      cleanup();
      releaseVideo(video);
      reject(err);
    }
    video.preload = 'metadata';
    video.volume = 0;
    video.addEventListener('loadedmetadata', handleLoaded, { once: true });
    video.addEventListener('error', handleError, { once: true });
    video.src = url;
  });
}

export async function createPosterForVideo(source: string | HTMLVideoElement): Promise<string | undefined> {
  let video: HTMLVideoElement | undefined;
  try {
    video = typeof source === 'string' ? await preloadVideo(source) : source;
    const loadedVideo = video;
    return await new Promise<string | undefined>((resolve) => {
      let isSettled = false;
      let isCapturing = false;
      const timeout = setTimeout(() => finish(), VIDEO_POSTER_TIMEOUT);
      function finish(blob?: Blob) {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timeout);
        loadedVideo.removeEventListener('seeked', capture);
        loadedVideo.removeEventListener('loadeddata', capture);
        loadedVideo.removeEventListener('error', handleError);
        resolve(blob ? URL.createObjectURL(blob) : undefined);
      }
      function handleError() {
        finish();
      }
      function capture() {
        if (isSettled || isCapturing) return;
        isCapturing = true;
        try {
          const { videoWidth: width, videoHeight: height } = loadedVideo;
          if (!width || !height) {
            finish();
            return;
          }
          const scale = Math.min(1, MAX_VIDEO_POSTER_SIZE / Math.max(width, height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(loadedVideo, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => finish(blob || undefined), 'image/jpeg', VIDEO_POSTER_QUALITY);
        } catch {
          finish();
        }
      }
      loadedVideo.addEventListener('error', handleError, { once: true });
      const posterTime = Number.isFinite(loadedVideo.duration) ? Math.min(loadedVideo.duration / 2, 1) : 0;
      if (posterTime > 0) {
        loadedVideo.addEventListener('seeked', capture, { once: true });
        try {
          loadedVideo.currentTime = posterTime;
        } catch {
          finish();
        }
      } else if (loadedVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        capture();
      } else {
        loadedVideo.addEventListener('loadeddata', capture, { once: true });
      }
    });
  } catch (e) {
    return undefined;
  } finally {
    if (video) releaseVideo(video);
  }
}

function releaseVideo(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute('src');
  video.load();
}

export async function fetchBlob(blobUrl: string) {
  const response = await fetch(blobUrl);
  return response.blob();
}

export async function fetchFile(blobUrl: string, fileName: string) {
  const blob = await fetchBlob(blobUrl);
  return blobToFile(blob, fileName);
}

export function imgToCanvas(img: HTMLImageElement) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;

  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  return canvas;
}

export function hasPreview(file: File) {
  return CONTENT_TYPES_WITH_PREVIEW.has(file.type);
}

export function validateFiles(files: File[] | FileList | null): File[] | undefined {
  if (!files?.length) {
    return undefined;
  }
  return Array.from(files).map(fixMovMime).filter((file) => file.size);
}

// .mov MIME type not reported sometimes https://developer.mozilla.org/en-US/docs/Web/API/File/type#sect1
function fixMovMime(file: File) {
  const ext = file.name.split('.').pop()!;
  if (!file.type && ext.toLowerCase() === 'mov') {
    return new File([file], file.name, { type: 'video/quicktime' });
  }
  return file;
}
