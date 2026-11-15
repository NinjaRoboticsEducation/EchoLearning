/**
 * Browser audio utilities for 16 kHz mono 16-bit PCM WAV encoding and telemetry.
 */

export interface EncodedWavResult {
  wavBlob: Blob;
  durationSec: number;
  rmsDb: number;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Encodes a mono Float32Array at the given sample rate into a 16-bit PCM RIFF/WAVE Blob.
 */
export function float32ToPcm16Wav(samples: Float32Array, sampleRate = 16000): Blob {
  const byteLength = 44 + samples.length * 2;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Decodes a MediaRecorder audio Blob and resamples it to 16 kHz mono PCM16 WAV.
 */
export async function encodeWav16kMono(audioBlob: Blob): Promise<EncodedWavResult> {
  const AudioCtx =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    throw new Error('Web Audio API is unavailable in this browser.');
  }

  const arrayBuffer = await audioBlob.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    throw new Error('Recorded audio buffer is empty.');
  }

  const decodeCtx = new AudioCtx();
  try {
    const decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
    const targetRate = 16000;
    const frameCount = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offlineCtx = new OfflineAudioContext(1, frameCount, targetRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineCtx.destination);
    source.start(0);
    const rendered = await offlineCtx.startRendering();
    const channelData = rendered.getChannelData(0);

    let sumSquares = 0;
    for (let i = 0; i < channelData.length; i += 1) {
      sumSquares += channelData[i] * channelData[i];
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, channelData.length));
    const rmsDb = Number((20 * Math.log10(Math.max(1e-6, rms))).toFixed(1));

    return {
      wavBlob: float32ToPcm16Wav(channelData, targetRate),
      durationSec: Number(rendered.duration.toFixed(2)),
      rmsDb,
    };
  } finally {
    await decodeCtx.close().catch(() => {});
  }
}

/**
 * Reads a Blob as a base64 string without data-URL prefix, rejecting on read errors.
 */
export function blobToBase64(blob: Blob): Promise<{ base64: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = dataUrl.indexOf(',');
      if (!dataUrl || commaIdx === -1) {
        reject(new Error('Failed to encode recorded audio.'));
        return;
      }
      resolve({
        base64: dataUrl.slice(commaIdx + 1),
        dataUrl,
      });
    };
    reader.onerror = () => {
      reject(reader.error || new Error('Failed to read recorded audio blob.'));
    };
    reader.readAsDataURL(blob);
  });
}
