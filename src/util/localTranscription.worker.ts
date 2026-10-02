const SAMPLE_RATE = 16000;
const MAX_SAMPLES = SAMPLE_RATE * 1800;
const WAV_HEADER_BYTES = 44;

type EncodeRequest = {
  channels: Float32Array[];
  sampleRate: number;
};

self.onmessage = (event: MessageEvent<EncodeRequest>) => {
  try {
    const { channels, sampleRate } = event.data;
    const length = channels[0]?.length;
    if (sampleRate !== SAMPLE_RATE || !length || channels.length > 2
      || channels.some((channel) => channel.length !== length)) {
      throw new Error('TRANSCRIPTION_DECODE_FAILED');
    }
    if (length > MAX_SAMPLES) throw new Error('TRANSCRIPTION_AUDIO_TOO_LONG');

    const buffer = new ArrayBuffer(WAV_HEADER_BYTES + length * 2);
    const view = new DataView(buffer);
    const writeLabel = (offset: number, label: string) => {
      for (let index = 0; index < label.length; index++) view.setUint8(offset + index, label.charCodeAt(index));
    };
    writeLabel(0, 'RIFF');
    view.setUint32(4, buffer.byteLength - 8, true);
    writeLabel(8, 'WAVE');
    writeLabel(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeLabel(36, 'data');
    view.setUint32(40, length * 2, true);

    let peak = 0;
    for (let index = 0; index < length; index++) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] / channels.length;
      if (!Number.isFinite(sample)) throw new Error('TRANSCRIPTION_DECODE_FAILED');
      const clipped = Math.max(-1, Math.min(1, sample));
      const encoded = Math.round(clipped * (clipped < 0 ? 32768 : 32767));
      peak = Math.max(peak, Math.abs(encoded));
      view.setInt16(WAV_HEADER_BYTES + index * 2, encoded, true);
    }
    if (peak <= 16) throw new Error('TRANSCRIPTION_NO_SPEECH');
    self.postMessage({ audio: buffer }, { transfer: [buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'TRANSCRIPTION_DECODE_FAILED' });
  }
};
