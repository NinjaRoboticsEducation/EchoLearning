/**
 * Browser audio utilities for 16 kHz mono 16-bit PCM WAV encoding and telemetry.
 */

export interface EncodedWavResult {
  wavBlob: Blob;
  durationSec: number;
  rmsDb: number;
}

export interface PcmTelemetry {
  durationSec: number;
  rmsDb: number;
  isSilent: boolean;
  silenceRatio: number;
}

/**
 * Downsamples a mono Float32Array from inputSampleRate to 16 kHz mono using
 * boxcar averaging (or linear interpolation when upsampling).
 */
export function downsampleTo16kMono(input: Float32Array, inputSampleRate: number): Float32Array {
  const targetRate = 16000;
  if (input.length === 0) {
    return new Float32Array(0);
  }
  if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0 || inputSampleRate === targetRate) {
    return new Float32Array(input);
  }

  const ratio = inputSampleRate / targetRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);

  if (ratio > 1) {
    for (let i = 0; i < outputLength; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      if (end > start) {
        let sum = 0;
        for (let j = start; j < end; j += 1) {
          sum += input[j];
        }
        output[i] = sum / (end - start);
      } else {
        const pos = Math.min(input.length - 1, i * ratio);
        const lo = Math.floor(pos);
        const hi = Math.min(input.length - 1, lo + 1);
        const frac = pos - lo;
        output[i] = input[lo] * (1 - frac) + input[hi] * frac;
      }
    }
    return output;
  }

  // Linear interpolation if inputSampleRate < 16000
  for (let i = 0; i < outputLength; i += 1) {
    const pos = Math.min(input.length - 1, i * ratio);
    const lo = Math.floor(pos);
    const hi = Math.min(input.length - 1, lo + 1);
    const frac = pos - lo;
    output[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return output;
}

/**
 * Concatenates Float32Array chunks into a single Float32Array, optionally
 * retaining only the most recent maxSamples samples.
 */
export function concatFloat32Arrays(chunks: Float32Array[], maxSamples?: number): Float32Array {
  let totalLength = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    totalLength += chunks[i].length;
  }
  if (totalLength === 0) {
    return new Float32Array(0);
  }

  if (maxSamples !== undefined && maxSamples >= 0 && totalLength > maxSamples) {
    if (maxSamples === 0) {
      return new Float32Array(0);
    }
    const result = new Float32Array(maxSamples);
    let skip = totalLength - maxSamples;
    let offset = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      const slice = skip > 0 ? chunk.subarray(skip) : chunk;
      skip = 0;
      result.set(slice, offset);
      offset += slice.length;
    }
    return result;
  }

  const result = new Float32Array(totalLength);
  let offset = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    result.set(chunks[i], offset);
    offset += chunks[i].length;
  }
  return result;
}

/**
 * Removes autoregressive repetition loops (e.g. '最大で最大で最大で...') from transcript text.
 */
export function cleanRepetitionLoops(text: string): string {
  if (!text) {
    return '';
  }
  let s = text.trim();
  // Remove spaces inserted between CJK characters across Whisper internal segments
  s = s.replace(/(?<=[\u3040-\u30ff\u4e00-\u9faf])\s+(?=[\u3040-\u30ff\u4e00-\u9faf])/g, '');
  // Collapse any 1..25 char phrase repeated >= 3 times consecutively (with optional punctuation/spaces)
  for (let i = 0; i < 5; i += 1) {
    s = s.replace(/(.{1,25}?)(?:[、,・\s]*\1){2,}/g, '$1');
  }
  return s.trim();
}

/**
 * Splits buffered 16 kHz PCM chunks at a natural low-energy pause boundary without
 * discarding any early samples. Keeps remaining audio in `remainingChunks`.
 */
export function splitPcmAtSilenceBoundary(
  chunks: Float32Array[],
  minSamples: number,
  maxSamples: number,
  sampleRate = 16000
): { flushSlice: Float32Array; remainingChunks: Float32Array[]; remainingSamples: number } {
  const all = concatFloat32Arrays(chunks);
  if (all.length === 0) {
    return {
      flushSlice: new Float32Array(0),
      remainingChunks: [],
      remainingSamples: 0,
    };
  }

  const winLen = 1600; // 100ms @ 16kHz
  const step = 800; // 50ms @ 16kHz
  const safeMin = Math.max(0, minSamples);
  const safeMax = Math.max(safeMin + winLen, maxSamples);

  const findQuietestWindow = (searchStart: number, searchEnd: number) => {
    let bestPos = -1;
    let bestRms = Number.POSITIVE_INFINITY;
    for (let pos = searchEnd - winLen; pos >= searchStart; pos -= step) {
      let sumSq = 0;
      for (let i = pos; i < pos + winLen; i += 1) {
        const v = all[i];
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / winLen);
      if (rms < bestRms) {
        bestRms = rms;
        bestPos = pos;
      }
    }
    return { bestPos, bestRms };
  };

  let splitIdx = all.length;
  if (all.length <= safeMax) {
    const searchStart = Math.max(safeMin, all.length - sampleRate * 3);
    if (all.length - searchStart >= winLen) {
      const { bestPos, bestRms } = findQuietestWindow(searchStart, all.length);
      if (bestPos !== -1 && bestRms < 0.025) {
        splitIdx = bestPos + winLen / 2;
      } else {
        splitIdx = all.length;
      }
    } else {
      splitIdx = all.length;
    }
  } else {
    const searchStart = Math.max(safeMin, safeMax - sampleRate * 4);
    if (safeMax - searchStart >= winLen) {
      const { bestPos } = findQuietestWindow(searchStart, safeMax);
      splitIdx = bestPos !== -1 ? bestPos + winLen / 2 : safeMax;
    } else {
      splitIdx = safeMax;
    }
  }

  const flushSlice = all.slice(0, splitIdx);
  const rem = splitIdx < all.length ? all.slice(splitIdx) : new Float32Array(0);
  return {
    flushSlice,
    remainingChunks: rem.length > 0 ? [rem] : [],
    remainingSamples: rem.length,
  };
}

/**
 * Computes 50ms windowed RMS telemetry on 16 kHz mono PCM samples.
 * When >= 4 active speech windows (windowRms >= 0.012) are present, uses
 * active-window RMS for rmsDb so long pauses in Simultaneous mode do not
 * dilute the speaker's dB level, and marks isSilent = false.
 */
export function computePcmTelemetry(samples: Float32Array, sampleRate = 16000): PcmTelemetry {
  if (samples.length === 0 || sampleRate <= 0) {
    return {
      durationSec: 0,
      rmsDb: -120,
      isSilent: true,
      silenceRatio: 1,
    };
  }

  const windowSize = Math.max(1, Math.floor(sampleRate * 0.05));
  const activeThreshold = 0.012;
  let windowCount = 0;
  let activeWindows = 0;
  let totalWindowRmsSq = 0;
  let activeWindowRmsSq = 0;

  for (let i = 0; i < samples.length; i += windowSize) {
    const end = Math.min(samples.length, i + windowSize);
    const len = end - i;
    let sumSq = 0;
    for (let j = i; j < end; j += 1) {
      sumSq += samples[j] * samples[j];
    }
    const windowRms = Math.sqrt(sumSq / len);
    const windowRmsSq = windowRms * windowRms;
    totalWindowRmsSq += windowRmsSq;
    windowCount += 1;

    if (windowRms >= activeThreshold) {
      activeWindows += 1;
      activeWindowRmsSq += windowRmsSq;
    }
  }

  const overallRms = Math.sqrt(totalWindowRmsSq / Math.max(1, windowCount));
  const silenceRatio = Number(((windowCount - activeWindows) / Math.max(1, windowCount)).toFixed(2));
  const durationSec = Number((samples.length / sampleRate).toFixed(2));

  if (activeWindows >= 4) {
    const activeRms = Math.sqrt(activeWindowRmsSq / activeWindows);
    const rmsDb = Number((20 * Math.log10(Math.max(1e-6, activeRms))).toFixed(1));
    return {
      durationSec,
      rmsDb,
      isSilent: false,
      silenceRatio,
    };
  }

  const rmsDb = Number((20 * Math.log10(Math.max(1e-6, overallRms))).toFixed(1));
  return {
    durationSec,
    rmsDb,
    isSilent: rmsDb < -48.0 || activeWindows < 2,
    silenceRatio,
  };
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
