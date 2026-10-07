import { invoke } from '@tauri-apps/api/core';

import type { ApiOnProgress, ApiVideo, ApiVoice } from '../api/types';
import type { RegularLangKey } from '../types/language';
import { ApiMediaFormat } from '../api/types';

import { getMediaHash } from '../global/helpers';
import { callApi, cancelApiProgress } from '../api/gramjs';
import { IS_TAURI } from './browser/globalEnvironment';
import { getFromMemory } from './mediaLoader';

const SAMPLE_RATE = 16000;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_DURATION_SECONDS = 1800;
const MAX_DECODED_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 120000;
const DECODE_TIMEOUT = 45000;
const ENCODE_TIMEOUT = 30000;
const RECOGNITION_TIMEOUT = 910000;

type TranscriptionResult = { text: string; language?: string };

const ERROR_KEYS: Record<string, RegularLangKey> = {
  TRANSCRIPTION_UNAVAILABLE: 'RelayTranscribeUnavailable',
  TRANSCRIPTION_BUSY: 'RelayTranscribeBusy',
  TRANSCRIPTION_AUDIO_TOO_LARGE: 'RelayTranscribeTooLarge',
  TRANSCRIPTION_AUDIO_TOO_LONG: 'RelayTranscribeTooLong',
  TRANSCRIPTION_NO_SPEECH: 'RelayTranscribeNoSpeech',
  TRANSCRIPTION_DECODE_FAILED: 'RelayTranscribeDecodeFailed',
  TRANSCRIPTION_TIMEOUT: 'RelayTranscribeTimeout',
  TRANSCRIPTION_CANCELED: 'RelayTranscribeCanceled',
};

export function getTranscriptionErrorKey(error: unknown): RegularLangKey {
  const code = error instanceof Error ? error.message : String(error);
  return ERROR_KEYS[code] || 'RelayTranscribeFailed';
}

export async function transcribeMessageLocally(media: ApiVoice | ApiVideo, signal: AbortSignal) {
  if (!IS_TAURI) throw new Error('TRANSCRIPTION_UNAVAILABLE');
  if (!Number.isFinite(media.size) || media.size <= 0 || media.size > MAX_AUDIO_BYTES) {
    throw new Error('TRANSCRIPTION_AUDIO_TOO_LARGE');
  }
  if (!Number.isFinite(media.duration) || media.duration < 0 || media.duration > MAX_DURATION_SECONDS) {
    throw new Error('TRANSCRIPTION_AUDIO_TOO_LONG');
  }
  throwIfCanceled(signal);
  const hash = getMediaHash(media, 'inline');
  if (!hash) throw new Error('TRANSCRIPTION_DECODE_FAILED');
  const cached = getFromMemory(hash);
  let blob: Blob;
  if (typeof cached === 'string' && cached.startsWith('blob:')) {
    const response = await waitForPhase(fetch(cached, { signal }), signal, DOWNLOAD_TIMEOUT);
    blob = await waitForPhase(response.blob(), signal, DOWNLOAD_TIMEOUT);
  } else {
    const onProgress: ApiOnProgress = () => {
      if (signal.aborted) onProgress.isCanceled = true;
    };
    const cancelDownload = () => {
      onProgress.isCanceled = true;
      cancelApiProgress(onProgress);
    };
    signal.addEventListener('abort', cancelDownload, { once: true });
    try {
      const downloaded = await waitForPhase(callApi('downloadMedia', {
        url: hash, mediaFormat: ApiMediaFormat.BlobUrl,
      }, onProgress), signal, DOWNLOAD_TIMEOUT);
      if (!(downloaded?.dataBlob instanceof Blob)) throw new Error('TRANSCRIPTION_DECODE_FAILED');
      blob = downloaded.dataBlob;
    } finally {
      signal.removeEventListener('abort', cancelDownload);
      cancelDownload();
    }
  }
  return transcribeAudioBlobLocally(blob, signal);
}

export async function transcribeAudioBlobLocally(blob: Blob, signal: AbortSignal): Promise<TranscriptionResult> {
  if (!IS_TAURI) throw new Error('TRANSCRIPTION_UNAVAILABLE');
  if (!blob.size || blob.size > MAX_AUDIO_BYTES) throw new Error('TRANSCRIPTION_AUDIO_TOO_LARGE');
  throwIfCanceled(signal);
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  let audio: ArrayBuffer;
  try {
    const source = await waitForPhase(blob.arrayBuffer(), signal, DECODE_TIMEOUT);
    const decoded = await waitForPhase(context.decodeAudioData(source), signal, DECODE_TIMEOUT);
    if (decoded.duration > MAX_DURATION_SECONDS) throw new Error('TRANSCRIPTION_AUDIO_TOO_LONG');
    if (decoded.sampleRate !== SAMPLE_RATE || decoded.numberOfChannels > 2
      || decoded.length * decoded.numberOfChannels * Float32Array.BYTES_PER_ELEMENT > MAX_DECODED_BYTES) {
      throw new Error('TRANSCRIPTION_AUDIO_TOO_LARGE');
    }
    throwIfCanceled(signal);
    const channels = Array.from({ length: decoded.numberOfChannels },
      (_, index) => decoded.getChannelData(index).slice());
    audio = await encodeAudio(channels, signal);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('TRANSCRIPTION_')) throw error;
    throw new Error('TRANSCRIPTION_DECODE_FAILED', { cause: error });
  } finally {
    void context.close().catch(() => undefined);
  }
  throwIfCanceled(signal);
  const requestId = crypto.randomUUID();
  let hasSentCancel = false;
  const cancelRecognition = () => {
    if (hasSentCancel) return;
    hasSentCancel = true;
    void invoke('cancel_voice_transcription', { requestId }).catch(() => undefined);
  };
  signal.addEventListener('abort', cancelRecognition, { once: true });
  try {
    return await waitForPhase(invoke<TranscriptionResult>('transcribe_voice', audio, {
      headers: { 'x-relay-transcription-id': requestId },
    }), signal, RECOGNITION_TIMEOUT);
  } catch (error) {
    cancelRecognition();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelRecognition);
  }
}

function encodeAudio(channels: Float32Array[], signal: AbortSignal): Promise<ArrayBuffer> {
  const worker = new Worker(new URL('./localTranscription.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Promise<ArrayBuffer>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ audio?: ArrayBuffer; error?: string }>) => {
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.audio) resolve(event.data.audio);
      else reject(new Error('TRANSCRIPTION_DECODE_FAILED'));
    };
    worker.onerror = () => reject(new Error('TRANSCRIPTION_DECODE_FAILED'));
    worker.postMessage({ channels, sampleRate: SAMPLE_RATE }, channels.map((channel) => channel.buffer));
  });
  return waitForPhase(pending, signal, ENCODE_TIMEOUT).finally(() => worker.terminate());
}

function throwIfCanceled(signal: AbortSignal) {
  if (signal.aborted) throw new Error('TRANSCRIPTION_CANCELED');
}

function waitForPhase<T>(pending: Promise<T>, signal: AbortSignal, timeout: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let isSettled = false;
    const finish = (error?: unknown, value?: T) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(value!);
    };
    const cancel = () => finish(new Error('TRANSCRIPTION_CANCELED'));
    const timer = window.setTimeout(() => finish(new Error('TRANSCRIPTION_TIMEOUT')), timeout);
    signal.addEventListener('abort', cancel, { once: true });
    pending.then((value) => finish(undefined, value), (error) => finish(error));
    if (signal.aborted) cancel();
  });
}
