import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Headphones,
  Loader2,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Volume2,
  X,
} from 'lucide-react';
import {
  DiffToken,
  LanguageCode,
  ShadowingAssessmentReport,
  ShadowingMode,
  TranscribePreviewResult,
  TranscriptSegment,
} from '../types';
import {
  blobToBase64,
  computePcmTelemetry,
  concatFloat32Arrays,
  downsampleTo16kMono,
  encodeWav16kMono,
  float32ToPcm16Wav,
} from '../utils/audio';
import { formatTimestamp, YouTubePlayerHandle } from './YouTubePlayer';

export type RecordingSessionState =
  | 'idle'
  | 'permission'
  | 'listening'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'ready'
  | 'analyzing'
  | 'reviewed';

export interface TakeSnapshot {
  targetText: string;
  segmentIds: string[];
  targetDurationSec: number;
  mode: ShadowingMode;
  language: LanguageCode;
  startSec: number;
  endSec: number;
}

export interface S05PreviewState {
  sessionState: RecordingSessionState;
  preview: TranscribePreviewResult | null;
  recordedAudioUrl: string | null;
  takeSnapshot: TakeSnapshot | null;
  finalizeError: string | null;
  liveRecognizedText?: string;
  isStreamingChunk?: boolean;
  recordingSec?: number;
}

interface ShadowingStudioProps {
  videoId: string;
  videoTitle: string;
  channel: string;
  language: LanguageCode;
  mode: ShadowingMode;
  showFurigana?: boolean;
  allSegments: TranscriptSegment[];
  targetSegments: TranscriptSegment[];
  activeSegment: TranscriptSegment;
  isEvaluating: boolean;
  playerHandleRef: React.MutableRefObject<YouTubePlayerHandle | null>;
  onModeChange: (mode: ShadowingMode) => void;
  onSetAutoPauseAtSec: (sec: number | null) => void;
  onClearLoopSegment: () => void;
  onReportGenerated: (report: ShadowingAssessmentReport) => void;
  onPreviewStateChange?: (state: S05PreviewState) => void;
  onBusyStateChange?: (busy: boolean) => void;
  onEvaluationError?: (error: string | null) => void;
  autoPauseTriggerCount: number;
  videoEndedCount?: number;
  latestReport?: ShadowingAssessmentReport | null;
  onAdvanceToNextSegment?: () => TranscriptSegment | null;
  onAdvanceToSegmentIndex?: (index: number) => TranscriptSegment | null;
  triggerAnalyzeRef?: React.MutableRefObject<(() => void) | null>;
  triggerRecordAgainRef?: React.MutableRefObject<(() => void) | null>;
}

const MAX_RECORDING_SEC = 3600;
const MIN_STREAM_CHUNK_SAMPLES = 16000 * 5;
const MAX_STREAM_WINDOW_SAMPLES = 16000 * 14;
const MAX_FINALIZE_TAIL_SAMPLES = 16000 * 12;
const MIN_TAIL_SAMPLES = Math.floor(16000 * 0.35);

function normalizeReportFromAnalyzeApi(
  data: Record<string, any>,
  snapshot: TakeSnapshot,
  videoId: string,
  videoTitle: string,
  channel: string,
  durationSec: number,
  audioDataUrl?: string
): ShadowingAssessmentReport {
  const rawDiff: any[] = Array.isArray(data.wordDiff)
    ? data.wordDiff
    : Array.isArray(data.wordAnalysis)
    ? data.wordAnalysis
    : [];

  const wordDiff: DiffToken[] = rawDiff.map((t) => ({
    word: String(t.word ?? t.surface ?? ''),
    expectedWord: t.expectedWord ?? t.expected ?? undefined,
    reading: t.reading ?? undefined,
    status: t.status || 'correct',
    explanation: t.explanation ?? undefined,
  }));

  const omittedCount = wordDiff.filter((t) => t.status === 'omitted').length;
  const substitutedCount = wordDiff.filter((t) => t.status === 'substituted').length;
  const uncertainSttCount = wordDiff.filter((t) => t.status === 'stt_uncertain').length;

  const contentAccuracy = Number(
    data.dimensions?.contentAccuracy ?? data.accuracyScore ?? 0
  );
  const pronunciation = Number(
    data.dimensions?.pronunciation ?? data.pronunciationScore ?? 0
  );
  const fluency = Number(
    data.dimensions?.fluency ?? data.fluencyScore ?? 0
  );
  const prosody = Number(
    data.dimensions?.prosody ?? data.prosodyScore ?? data.intonationScore ?? 0
  );

  const recordingId: string | undefined = data.recordingId || undefined;
  const speechRateWpm = Number(
    data.speechRateWpm ?? data.metrics?.speechRateValue ?? data.speechRateValue ?? 0
  );

  return {
    id: data.id || `rep-${Date.now()}`,
    videoId,
    videoTitle,
    channel,
    language: snapshot.language,
    segmentIds: snapshot.segmentIds,
    mode: snapshot.mode,
    createdAt: data.createdAt || new Date().toISOString(),
    targetText: snapshot.targetText,
    recognizedTranscript:
      data.recognizedTranscript ?? data.recognizedText ?? '',
    overallScore: Number(data.overallScore ?? 0),
    dimensions: {
      contentAccuracy,
      pronunciation,
      fluency,
      prosody,
    },
    metrics: {
      speechRateValue: speechRateWpm,
      speechRateUnit: snapshot.language === 'ja' ? 'Moras/min' : 'WPM',
      targetRateValue: Number(data.metrics?.targetRateValue ?? data.targetRateValue ?? 135),
      durationSec: Number(data.metrics?.durationSec ?? durationSec),
      targetDurationSec: Number(
        data.metrics?.targetDurationSec ?? snapshot.targetDurationSec
      ),
      omittedCount: Number(data.metrics?.omittedCount ?? omittedCount),
      substitutedCount: Number(data.metrics?.substitutedCount ?? substitutedCount),
      uncertainSttCount: Number(data.metrics?.uncertainSttCount ?? uncertainSttCount),
    },
    scoreExplanation:
      data.scoreExplanation ||
      data.feedback ||
      'Evaluated across lexical accuracy, acoustic pronunciation, fluency, and prosodic rhythm.',
    wordDiff,
    pronunciationFeedback: Array.isArray(data.pronunciationFeedback)
      ? data.pronunciationFeedback
      : Array.isArray(data.intonationTips)
      ? data.intonationTips.map((tip: any) =>
          typeof tip === 'string'
            ? {
                targetWord: 'Intonation',
                readingOrIpa: '',
                category: 'Prosody & Rhythm',
                observedIssue: tip,
                actionableTip: tip,
                severity: 'medium' as const,
              }
            : tip
        )
      : [],
    improvementSuggestions: Array.isArray(data.improvementSuggestions)
      ? data.improvementSuggestions
      : Array.isArray(data.actionableImprovements)
      ? data.actionableImprovements
      : [],
    recommendedRetryText: data.recommendedRetryText,
    audioDataUrl,
    audioUrl: recordingId ? `/api/audio/${encodeURIComponent(recordingId)}` : undefined,
    recordingId,
    pronunciationScore: pronunciation,
    prosodyScore: prosody,
    accuracyScore: contentAccuracy,
    fluencyScore: fluency,
    pitchContour: Array.isArray(data.pitchContour) ? data.pitchContour : undefined,
    referencePitchContour: Array.isArray(data.referencePitchContour)
      ? data.referencePitchContour
      : undefined,
    energyDb: typeof data.energyDb === 'number' ? data.energyDb : undefined,
    speechRateWpm,
    analysisMethod: data.analysisMethod || 'local_acoustic_adk',
  };
}

export const ShadowingStudio: React.FC<ShadowingStudioProps> = ({
  videoId,
  videoTitle,
  channel,
  language,
  mode,
  showFurigana = true,
  allSegments,
  targetSegments,
  activeSegment,
  isEvaluating,
  playerHandleRef,
  onModeChange,
  onSetAutoPauseAtSec,
  onClearLoopSegment,
  onReportGenerated,
  onPreviewStateChange,
  onBusyStateChange,
  onEvaluationError,
  autoPauseTriggerCount,
  videoEndedCount = 0,
  latestReport,
  onAdvanceToNextSegment,
  onAdvanceToSegmentIndex,
  triggerAnalyzeRef,
  triggerRecordAgainRef,
}) => {
  const [sessionState, setSessionState] = useState<RecordingSessionState>('idle');
  const sessionStateRef = useRef<RecordingSessionState>('idle');
  const updateSessionState = (next: RecordingSessionState) => {
    sessionStateRef.current = next;
    setSessionState(next);
  };
  const [micError, setMicError] = useState<string | null>(null);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [recordingSec, setRecordingSec] = useState(0);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [recordedWavBlob, setRecordedWavBlob] = useState<Blob | null>(null);
  const [previewResult, setPreviewResult] = useState<TranscribePreviewResult | null>(null);
  const [takeSnapshot, setTakeSnapshot] = useState<TakeSnapshot | null>(null);
  const [liveRecognizedText, setLiveRecognizedText] = useState<string>('');
  const [isStreamingChunk, setIsStreamingChunk] = useState<boolean>(false);

  const simultaneousStartVideoSecRef = useRef<number>(0);
  const [capturedSimultaneousSegments, setCapturedSimultaneousSegments] =
    useState<TranscriptSegment[] | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const startTimeMsRef = useRef<number>(0);
  const recordingSecRef = useRef<number>(0);
  const captureGeneration = useRef(0);
  const activeUrlRef = useRef<string | null>(null);
  const pendingSnapshotRef = useRef<TakeSnapshot | null>(null);

  const pcmChunksRef = useRef<Float32Array[]>([]);
  const unflushedChunksRef = useRef<Float32Array[]>([]);
  const unflushedSamplesCountRef = useRef<number>(0);
  const streamedTextPartsRef = useRef<string[]>([]);
  const streamedMetricsRef = useRef<{
    voicedFrames: number;
    pauseCount: number;
    pitchContour: number[];
    activeRmsValues: number[];
    whisperError: string | null;
    chunkCount: number;
  }>({
    voicedFrames: 0,
    pauseCount: 0,
    pitchContour: [],
    activeRmsValues: [],
    whisperError: null,
    chunkCount: 0,
  });
  const streamQueuePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const activeStreamCountRef = useRef<number>(0);
  const speechRecognitionRef = useRef<any>(null);
  const webSpeechLiveRef = useRef<string>('');
  const whisperCoveredWebSpeechLenRef = useRef<number>(0);

  const effectiveSegments =
    mode === 'listen_repeat'
      ? [activeSegment]
      : capturedSimultaneousSegments && capturedSimultaneousSegments.length > 0
      ? capturedSimultaneousSegments
      : targetSegments.length > 1
      ? targetSegments
      : allSegments.length > 0
      ? allSegments.slice(Math.max(0, activeSegment.index))
      : [activeSegment];

  const targetText = effectiveSegments
    .map((s) => s.text)
    .join(language === 'ja' ? '' : ' ');
  const startSec = effectiveSegments[0]?.startTime || 0;
  const endSec =
    effectiveSegments[effectiveSegments.length - 1]?.endTime || startSec + 6;
  const targetDurationSec = Math.max(2, endSec - startSec);

  const isBusy = [
    'permission',
    'listening',
    'recording',
    'paused',
    'finalizing',
    'analyzing',
  ].includes(sessionState);

  useEffect(() => {
    onBusyStateChange?.(isBusy);
  }, [isBusy, onBusyStateChange]);

  useEffect(() => {
    onPreviewStateChange?.({
      sessionState,
      preview: previewResult,
      recordedAudioUrl,
      takeSnapshot,
      finalizeError,
      liveRecognizedText,
      isStreamingChunk,
      recordingSec,
    });
  }, [
    sessionState,
    previewResult,
    recordedAudioUrl,
    takeSnapshot,
    finalizeError,
    liveRecognizedText,
    isStreamingChunk,
    recordingSec,
    onPreviewStateChange,
  ]);

  const computeCombinedLiveText = (lang: LanguageCode): string => {
    const sep = lang === 'ja' ? '' : ' ';
    const whisperText = streamedTextPartsRef.current.join(sep).trim();
    const webText = webSpeechLiveRef.current.trim();
    if (!whisperText) return webText;
    const coveredLen = whisperCoveredWebSpeechLenRef.current;
    if (!webText || webText.length <= coveredLen) return whisperText;
    let tailStart = coveredLen;
    if (
      lang !== 'ja' &&
      tailStart > 0 &&
      tailStart < webText.length &&
      webText[tailStart - 1] !== ' '
    ) {
      const nextSpace = webText.indexOf(' ', tailStart);
      if (nextSpace === -1) return whisperText;
      tailStart = nextSpace + 1;
    }
    const webTail = webText.slice(tailStart).trim();
    return webTail ? `${whisperText}${sep}${webTail}`.trim() : whisperText;
  };

  const revokeActiveAudioUrl = () => {
    if (activeUrlRef.current) {
      URL.revokeObjectURL(activeUrlRef.current);
      activeUrlRef.current = null;
    }
  };

  const resetStreamingState = () => {
    pcmChunksRef.current = [];
    unflushedChunksRef.current = [];
    unflushedSamplesCountRef.current = 0;
    streamedTextPartsRef.current = [];
    streamedMetricsRef.current = {
      voicedFrames: 0,
      pauseCount: 0,
      pitchContour: [],
      activeRmsValues: [],
      whisperError: null,
      chunkCount: 0,
    };
    streamQueuePromiseRef.current = Promise.resolve();
    activeStreamCountRef.current = 0;
    webSpeechLiveRef.current = '';
    whisperCoveredWebSpeechLenRef.current = 0;
    setLiveRecognizedText('');
    setIsStreamingChunk(false);
  };

  const stopAllCaptureResources = () => {
    if (timerIntervalRef.current) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.onresult = null;
        speechRecognitionRef.current.onerror = null;
        speechRecognitionRef.current.onend = null;
        speechRecognitionRef.current.stop();
      } catch {
        // Ignore
      }
      speechRecognitionRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.onaudioprocess = null;
      try {
        scriptProcessorRef.current.disconnect();
      } catch {
        // Ignore
      }
      scriptProcessorRef.current = null;
    }
    if (silentGainRef.current) {
      try {
        silentGainRef.current.disconnect();
      } catch {
        // Ignore
      }
      silentGainRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  };

  useEffect(() => {
    return () => {
      captureGeneration.current += 1;
      stopAllCaptureResources();
      revokeActiveAudioUrl();
    };
  }, []);

  // Draw live waveform AFTER recording state mounts <canvas> (R03)
  useEffect(() => {
    if (sessionState !== 'recording') return;
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const renderFrame = () => {
      animFrameRef.current = requestAnimationFrame(renderFrame);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const barCount = 36;
      const step = Math.max(1, Math.floor(bufferLength / barCount));
      const barWidth = Math.max(2, Math.floor(canvas.width / barCount) - 2);

      for (let i = 0; i < barCount; i++) {
        const val = dataArray[i * step] || 0;
        const normalized = Math.max(0.1, val / 255);
        const barHeight = normalized * (canvas.height - 6);
        const x = i * (barWidth + 2);
        const y = (canvas.height - barHeight) / 2;

        ctx.fillStyle = val > 180 ? '#c5bbff' : '#8b7cf6';
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, 2);
        ctx.fill();
      }
    };

    renderFrame();
    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [sessionState]);

  // Auto-start recording when Listen-Then-Repeat finishes playing native clip
  useEffect(() => {
    if (sessionState === 'listening' && autoPauseTriggerCount > 0) {
      onSetAutoPauseAtSec(null);
      startMicrophoneCapture(pendingSnapshotRef.current || undefined);
    }
  }, [autoPauseTriggerCount]);

  // Auto-stop recording if video ends during Simultaneous capture (R03)
  useEffect(() => {
    if (
      videoEndedCount > 0 &&
      mode === 'simultaneous' &&
      (sessionState === 'recording' || sessionState === 'paused')
    ) {
      handleFinishRecording();
    }
  }, [videoEndedCount]);

  // Auto-stop recording at 3600s (60-minute) ceiling
  useEffect(() => {
    if (sessionState === 'recording' && recordingSec >= MAX_RECORDING_SEC) {
      handleFinishRecording();
    }
  }, [recordingSec, sessionState]);

  const createSnapshot = (segs: TranscriptSegment[], currentMode: ShadowingMode): TakeSnapshot => {
    const sStart = segs[0]?.startTime || 0;
    const sEnd = segs[segs.length - 1]?.endTime || sStart + 6;
    return {
      targetText: segs.map((s) => s.text).join(language === 'ja' ? '' : ' '),
      segmentIds: segs.map((s) => s.id),
      targetDurationSec: Math.max(2, sEnd - sStart),
      mode: currentMode,
      language,
      startSec: sStart,
      endSec: sEnd,
    };
  };

  const waitWithTimeout = (promise: Promise<void>, ms: number): Promise<void> =>
    Promise.race([
      promise,
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      }),
    ]);

  const enqueueStreamChunk = (
    slice: Float32Array,
    snapshot: TakeSnapshot,
    generation: number
  ) => {
    const telemetry = computePcmTelemetry(slice, 16000);
    if (telemetry.isSilent) return;

    const chunkWavBlob = float32ToPcm16Wav(slice, 16000);
    const dispatchedWebLen = webSpeechLiveRef.current.length;
    activeStreamCountRef.current += 1;
    setIsStreamingChunk(true);

    streamQueuePromiseRef.current = streamQueuePromiseRef.current
      .then(async () => {
        if (generation !== captureGeneration.current) return;
        try {
          const form = new FormData();
          form.append('audio', chunkWavBlob, 'chunk.wav');
          form.append('language', snapshot.language);
          form.append('target_text', snapshot.targetText);

          const res = await fetch('/api/shadowing/transcribe', {
            method: 'POST',
            body: form,
          });
          const data = await res.json().catch(() => ({}));
          if (generation !== captureGeneration.current) return;

          if (!res.ok) {
            const errDetail =
              typeof data?.detail === 'string'
                ? data.detail
                : data?.error || `Local Whisper chunk failed (HTTP ${res.status}).`;
            streamedMetricsRef.current.whisperError = errDetail;
            return;
          }

          streamedMetricsRef.current.chunkCount += 1;
          streamedMetricsRef.current.pauseCount += Number(data.pauseCount ?? 0);
          if (typeof data.voicedFrames === 'number') {
            streamedMetricsRef.current.voicedFrames += data.voicedFrames;
          }
          if (typeof data.rmsDb === 'number' && !data.isSilent) {
            streamedMetricsRef.current.activeRmsValues.push(data.rmsDb);
          }
          if (Array.isArray(data.pitchContour) && data.pitchContour.length > 0) {
            const combined = streamedMetricsRef.current.pitchContour.concat(
              data.pitchContour.filter((v: unknown) => typeof v === 'number')
            );
            if (combined.length > 120) {
              const step = combined.length / 120;
              const downsampled: number[] = [];
              for (let i = 0; i < 120; i += 1) {
                downsampled.push(combined[Math.min(combined.length - 1, Math.floor(i * step))]);
              }
              streamedMetricsRef.current.pitchContour = downsampled;
            } else {
              streamedMetricsRef.current.pitchContour = combined;
            }
          }
          if (data.whisperError) {
            streamedMetricsRef.current.whisperError = String(data.whisperError);
          }

          const recognized =
            typeof data.recognizedText === 'string' ? data.recognizedText.trim() : '';
          if (recognized) {
            streamedTextPartsRef.current.push(recognized);
            whisperCoveredWebSpeechLenRef.current = Math.max(
              whisperCoveredWebSpeechLenRef.current,
              dispatchedWebLen
            );
            setLiveRecognizedText(computeCombinedLiveText(snapshot.language));
          }
        } catch (err: any) {
          if (generation === captureGeneration.current) {
            streamedMetricsRef.current.whisperError =
              err?.message || 'Background Whisper chunk request failed.';
          }
        }
      })
      .finally(() => {
        activeStreamCountRef.current = Math.max(0, activeStreamCountRef.current - 1);
        if (generation === captureGeneration.current && activeStreamCountRef.current === 0) {
          setIsStreamingChunk(false);
        }
      });
  };

  const startRecordingTimer = (snapshot: TakeSnapshot, generation: number) => {
    if (timerIntervalRef.current) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    timerIntervalRef.current = window.setInterval(() => {
      if (generation !== captureGeneration.current) return;
      const elapsed = (Date.now() - startTimeMsRef.current) / 1000;
      recordingSecRef.current = elapsed;
      setRecordingSec(elapsed);

      if (
        sessionStateRef.current === 'recording' &&
        activeStreamCountRef.current === 0 &&
        unflushedSamplesCountRef.current >= MIN_STREAM_CHUNK_SAMPLES &&
        unflushedChunksRef.current.length > 0
      ) {
        const toFlush = unflushedChunksRef.current;
        unflushedChunksRef.current = [];
        unflushedSamplesCountRef.current = 0;
        const slice = concatFloat32Arrays(toFlush, MAX_STREAM_WINDOW_SAMPLES);
        enqueueStreamChunk(slice, pendingSnapshotRef.current || snapshot, generation);
      }
    }, 150);
  };

  const finalizeRecordedAudio = async (
    rawBlob: Blob,
    snapshot: TakeSnapshot,
    generation: number,
    durationFallback: number
  ) => {
    updateSessionState('finalizing');
    setFinalizeError(null);

    try {
      if (pcmChunksRef.current.length > 0) {
        const capturedPcmChunks = pcmChunksRef.current;
        const hasLiveText =
          streamedTextPartsRef.current.length > 0 ||
          webSpeechLiveRef.current.trim().length > 0;

        if (activeStreamCountRef.current > 0) {
          await waitWithTimeout(streamQueuePromiseRef.current, hasLiveText ? 4000 : 6000);
          if (generation !== captureGeneration.current) return;
        }

        const tailSamples = unflushedSamplesCountRef.current;
        const tailChunks = unflushedChunksRef.current;
        unflushedChunksRef.current = [];
        unflushedSamplesCountRef.current = 0;

        if (
          activeStreamCountRef.current === 0 &&
          tailSamples >= MIN_TAIL_SAMPLES &&
          tailChunks.length > 0 &&
          tailSamples <= MAX_FINALIZE_TAIL_SAMPLES
        ) {
          const tailSlice = concatFloat32Arrays(tailChunks);
          enqueueStreamChunk(tailSlice, snapshot, generation);
          await waitWithTimeout(streamQueuePromiseRef.current, 6000);
          if (generation !== captureGeneration.current) return;
        }

        let fullPcm = concatFloat32Arrays(capturedPcmChunks);
        if (
          rawBlob.size > 0 &&
          fullPcm.length / 16000 < Math.max(1.5, recordingSecRef.current * 0.75)
        ) {
          try {
            const recovered = await encodeWav16kMono(rawBlob);
            if (generation !== captureGeneration.current) return;
            if (recovered.durationSec > fullPcm.length / 16000) {
              const buf = await recovered.wavBlob.arrayBuffer();
              if (generation !== captureGeneration.current) return;
              if (buf.byteLength > 44) {
                const view = new DataView(buf, 44);
                const sampleCount = Math.floor((buf.byteLength - 44) / 2);
                const recoveredPcm = new Float32Array(sampleCount);
                for (let i = 0; i < sampleCount; i += 1) {
                  recoveredPcm[i] = view.getInt16(i * 2, true) / 32768;
                }
                fullPcm = recoveredPcm;
              }
            }
          } catch {
            // Keep captured PCM if MediaRecorder decoding fails
          }
        }

        const fullTelemetry = computePcmTelemetry(fullPcm, 16000);
        const fullWavBlob = float32ToPcm16Wav(fullPcm, 16000);

        revokeActiveAudioUrl();
        const playbackUrl = URL.createObjectURL(fullWavBlob);
        activeUrlRef.current = playbackUrl;
        setRecordedAudioUrl(playbackUrl);
        setRecordedWavBlob(fullWavBlob);

        const whisperText = streamedTextPartsRef.current
          .join(snapshot.language === 'ja' ? '' : ' ')
          .trim();
        const recognizedText = whisperText || webSpeechLiveRef.current.trim();
        const activeRms = streamedMetricsRef.current.activeRmsValues;
        const reportedRmsDb = !fullTelemetry.isSilent
          ? fullTelemetry.rmsDb
          : activeRms.length > 0
          ? Number((activeRms.reduce((a, b) => a + b, 0) / activeRms.length).toFixed(1))
          : fullTelemetry.rmsDb;
        const isSilent =
          fullTelemetry.isSilent && activeRms.length === 0 && recognizedText.length === 0;

        const preview: TranscribePreviewResult = {
          recognizedText,
          isSilent,
          durationSec: fullTelemetry.durationSec > 0 ? fullTelemetry.durationSec : durationFallback,
          rmsDb: reportedRmsDb,
          pauseCount: streamedMetricsRef.current.pauseCount,
          silenceRatio: fullTelemetry.silenceRatio,
          pitchContour:
            streamedMetricsRef.current.pitchContour.length > 0
              ? streamedMetricsRef.current.pitchContour
              : undefined,
          whisperError: streamedMetricsRef.current.whisperError || undefined,
          chunkCount: streamedMetricsRef.current.chunkCount,
        };

        setPreviewResult(preview);
        setTakeSnapshot(snapshot);
        updateSessionState('ready');
        return;
      }

      const { wavBlob, durationSec, rmsDb } = await encodeWav16kMono(rawBlob);
      if (generation !== captureGeneration.current) return;

      revokeActiveAudioUrl();
      const wavUrl = URL.createObjectURL(wavBlob);
      activeUrlRef.current = wavUrl;
      setRecordedAudioUrl(wavUrl);
      setRecordedWavBlob(wavBlob);

      const form = new FormData();
      form.append('audio', wavBlob, 'take.wav');
      form.append('language', snapshot.language);
      form.append('target_text', snapshot.targetText);

      const res = await fetch('/api/shadowing/transcribe', {
        method: 'POST',
        body: form,
      });

      if (generation !== captureGeneration.current) return;

      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof data?.detail === 'string'
            ? data.detail
            : data?.error || 'Local Whisper speech preview failed.'
        );
      }

      const preview: TranscribePreviewResult = {
        recognizedText: String(data.recognizedText ?? ''),
        isSilent: Boolean(data.isSilent),
        durationSec: Number(data.durationSec ?? durationSec ?? durationFallback),
        rmsDb: Number(data.rmsDb ?? rmsDb ?? -60),
        pauseCount: Number(data.pauseCount ?? 0),
        silenceRatio: Number(data.silenceRatio ?? 0),
        pitchContour: Array.isArray(data.pitchContour) ? data.pitchContour : undefined,
        whisperError: data.whisperError ? String(data.whisperError) : undefined,
      };

      setPreviewResult(preview);
      setTakeSnapshot(snapshot);
      updateSessionState('ready');
    } catch (err: any) {
      if (generation !== captureGeneration.current) return;
      setFinalizeError(
        err?.message || 'Could not finalize or transcribe recorded audio.'
      );
      updateSessionState('ready');
    }
  };

  const startMicrophoneCapture = async (explicitSnapshot?: TakeSnapshot): Promise<boolean> => {
    setMicError(null);
    setFinalizeError(null);
    setPreviewResult(null);
    onEvaluationError?.(null);
    setRecordingSec(0);
    recordingSecRef.current = 0;
    resetStreamingState();

    const snapshot = explicitSnapshot || createSnapshot(effectiveSegments, mode);
    pendingSnapshotRef.current = snapshot;
    setTakeSnapshot(snapshot);

    const generation = ++captureGeneration.current;
    updateSessionState('permission');
    audioChunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (generation !== captureGeneration.current) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      streamRef.current = stream;

      const AudioCtx =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;
      await audioCtx.resume().catch(() => {});
      if (generation !== captureGeneration.current) {
        stream.getTracks().forEach((track) => track.stop());
        audioCtx.close().catch(() => {});
        return false;
      }
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      if (
        typeof audioCtx.createScriptProcessor === 'function' &&
        typeof audioCtx.createGain === 'function'
      ) {
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        const silentGain = audioCtx.createGain();
        silentGain.gain.value = 0;

        processor.onaudioprocess = (event) => {
          if (generation !== captureGeneration.current || sessionStateRef.current !== 'recording') {
            return;
          }
          const rawChannel = event.inputBuffer.getChannelData(0);
          const downsampled = downsampleTo16kMono(rawChannel, audioCtx.sampleRate);
          if (downsampled.length === 0) return;

          pcmChunksRef.current.push(downsampled);
          unflushedChunksRef.current.push(downsampled);
          unflushedSamplesCountRef.current += downsampled.length;
        };

        source.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(audioCtx.destination);
        scriptProcessorRef.current = processor;
        silentGainRef.current = silentGain;
      }

      if (typeof window !== 'undefined') {
        const SpeechRec =
          (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (SpeechRec) {
          try {
            const rec = new SpeechRec();
            rec.continuous = true;
            rec.interimResults = true;
            rec.lang = snapshot.language === 'ja' ? 'ja-JP' : 'en-US';
            rec.onresult = (event: any) => {
              if (generation !== captureGeneration.current) return;
              let finalPart = '';
              let interimPart = '';
              for (let i = 0; i < event.results.length; i += 1) {
                const res = event.results[i];
                const text = String(res?.[0]?.transcript || '');
                if (res?.isFinal) {
                  finalPart += text;
                } else {
                  interimPart += text;
                }
              }
              const sep = snapshot.language === 'ja' ? '' : ' ';
              webSpeechLiveRef.current = [finalPart.trim(), interimPart.trim()]
                .filter(Boolean)
                .join(sep)
                .trim();
              setLiveRecognizedText(computeCombinedLiveText(snapshot.language));
            };
            rec.onerror = () => {
              // Non-fatal; local Whisper streaming remains primary
            };
            rec.start();
            speechRecognitionRef.current = rec;
          } catch {
            // Browser SpeechRecognition unavailable or blocked
          }
        }
      }

      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : '';

      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        if (generation !== captureGeneration.current) return;
        const rawBlob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        const finalSnapshot = pendingSnapshotRef.current || snapshot;
        void finalizeRecordedAudio(
          rawBlob,
          finalSnapshot,
          generation,
          recordingSecRef.current
        );
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      updateSessionState('recording');
      startTimeMsRef.current = Date.now();
      startRecordingTimer(snapshot, generation);

      return true;
    } catch (err: any) {
      if (generation !== captureGeneration.current) return false;
      stopAllCaptureResources();
      updateSessionState('idle');
      onSetAutoPauseAtSec(null);
      setMicError(
        err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
          ? 'Microphone access was denied. Please allow microphone permissions in your browser address bar, or run a Demo Take below.'
          : 'No microphone was detected or audio capture failed. Connect a microphone or run a Demo Take below.'
      );
      return false;
    }
  };

  const handleCancelActiveTake = () => {
    captureGeneration.current += 1;
    onSetAutoPauseAtSec(null);
    playerHandleRef.current?.pause();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.onstop = null;
        mediaRecorderRef.current.stop();
      } catch {
        // Ignore
      }
    }
    stopAllCaptureResources();
    resetStreamingState();
    updateSessionState('idle');
  };

  const handleStartSession = async () => {
    setMicError(null);
    setFinalizeError(null);
    setPreviewResult(null);
    setRecordedWavBlob(null);
    revokeActiveAudioUrl();
    setRecordedAudioUrl(null);
    setCapturedSimultaneousSegments(null);

    if (mode === 'listen_repeat') {
      let targetSeg = activeSegment;
      const isCurrentEvaluated = Boolean(
        latestReport &&
          !latestReport.isDemo &&
          latestReport.mode === 'listen_repeat' &&
          latestReport.segmentIds.includes(activeSegment.id)
      );

      if (isCurrentEvaluated && onAdvanceToNextSegment) {
        const next = onAdvanceToNextSegment();
        if (next) {
          targetSeg = next;
        }
      }

      const snap = createSnapshot([targetSeg], 'listen_repeat');
      pendingSnapshotRef.current = snap;
      setTakeSnapshot(snap);

      if (playerHandleRef.current) {
        onSetAutoPauseAtSec(targetSeg.endTime);
        playerHandleRef.current.seekTo(targetSeg.startTime, true);
        playerHandleRef.current.play();
        updateSessionState('listening');
      } else {
        await startMicrophoneCapture(snap);
      }
    } else {
      onSetAutoPauseAtSec(null);
      onClearLoopSegment();

      let startAt = activeSegment?.startTime || 0;
      const isSimultaneousEvaluated = Boolean(
        latestReport &&
          !latestReport.isDemo &&
          latestReport.mode === 'simultaneous' &&
          latestReport.segmentIds &&
          latestReport.segmentIds.length > 0
      );

      if (isSimultaneousEvaluated && latestReport) {
        const lastEvaluatedId =
          latestReport.segmentIds[latestReport.segmentIds.length - 1];
        const lastIdx = allSegments.findIndex((s) => s.id === lastEvaluatedId);
        if (lastIdx !== -1 && lastIdx + 1 < allSegments.length) {
          const nextSeg = onAdvanceToSegmentIndex
            ? onAdvanceToSegmentIndex(lastIdx + 1)
            : allSegments[lastIdx + 1];
          if (nextSeg) {
            startAt = nextSeg.startTime;
          }
        }
      } else if (targetSegments.length > 0 && targetSegments.length < allSegments.length) {
        startAt = targetSegments[0].startTime;
      } else if (playerHandleRef.current) {
        const curTime = playerHandleRef.current.getCurrentTime();
        if (curTime > 0.5 && Math.abs(curTime - (activeSegment?.startTime || 0)) < 3.0) {
          startAt = curTime;
        }
      }

      simultaneousStartVideoSecRef.current = startAt;
      const initialSegs =
        targetSegments.length > 1
          ? targetSegments
          : allSegments.filter((s) => s.endTime > startAt);
      const snap = createSnapshot(
        initialSegs.length > 0 ? initialSegs : [activeSegment],
        'simultaneous'
      );

      const micStarted = await startMicrophoneCapture(snap);
      if (!micStarted) return;

      if (playerHandleRef.current) {
        const currentVidTime = playerHandleRef.current.getCurrentTime();
        if (Math.abs(currentVidTime - startAt) > 0.5) {
          playerHandleRef.current.seekTo(startAt, true);
        }
        playerHandleRef.current.play();
      }
    }
  };

  const handleRecordImmediately = async () => {
    onSetAutoPauseAtSec(null);
    playerHandleRef.current?.pause();
    const snap = createSnapshot(effectiveSegments, mode);
    await startMicrophoneCapture(snap);
  };

  const handlePauseOrResumeRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (sessionState === 'recording' && recorder.state === 'recording') {
      recorder.pause();
      playerHandleRef.current?.pause();
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      updateSessionState('paused');
    } else if (sessionState === 'paused' && recorder.state === 'paused') {
      recorder.resume();
      if (mode === 'simultaneous') {
        onSetAutoPauseAtSec(null);
        playerHandleRef.current?.play();
      }
      startTimeMsRef.current = Date.now() - recordingSecRef.current * 1000;
      updateSessionState('recording');
      const resumeSnapshot =
        pendingSnapshotRef.current || takeSnapshot || createSnapshot(effectiveSegments, mode);
      startRecordingTimer(resumeSnapshot, captureGeneration.current);
    }
  };

  const handleFinishRecording = () => {
    if (sessionState !== 'recording' && sessionState !== 'paused') {
      if (sessionState === 'permission' || sessionState === 'listening') {
        handleCancelActiveTake();
      }
      return;
    }

    onSetAutoPauseAtSec(null);
    const stopVideoSec =
      playerHandleRef.current?.getCurrentTime?.() ||
      simultaneousStartVideoSecRef.current + recordingSecRef.current;
    playerHandleRef.current?.pause();

    if (mode === 'simultaneous' && allSegments.length > 0) {
      const startWin = simultaneousStartVideoSecRef.current;
      const endWin = Math.max(startWin + 2, stopVideoSec);
      const covered = allSegments.filter(
        (s) => s.endTime > startWin + 0.3 && s.startTime < endWin + 0.5
      );
      if (covered.length > 0) {
        setCapturedSimultaneousSegments(covered);
        const updatedSnap = createSnapshot(covered, 'simultaneous');
        pendingSnapshotRef.current = updatedSnap;
        setTakeSnapshot(updatedSnap);
      }
    }

    updateSessionState('finalizing');
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      updateSessionState('idle');
    }
    stopAllCaptureResources();
  };

  const handleAnalyzeShadowing = async () => {
    if (!recordedWavBlob || !takeSnapshot || sessionState === 'analyzing') return;
    updateSessionState('analyzing');
    onEvaluationError?.(null);

    try {
      const form = new FormData();
      form.append('audio', recordedWavBlob, 'take.wav');
      form.append('target_text', takeSnapshot.targetText);
      form.append('language', takeSnapshot.language);
      form.append('mode', takeSnapshot.mode);
      form.append('video_id', videoId);
      form.append('segment_ids', JSON.stringify(takeSnapshot.segmentIds));
      form.append(
        'duration_sec',
        String(previewResult?.durationSec ?? Math.max(1, recordingSecRef.current))
      );
      form.append('target_duration_sec', String(takeSnapshot.targetDurationSec));
      form.append('start_sec', String(takeSnapshot.startSec));
      form.append('end_sec', String(takeSnapshot.endSec));
      form.append('audio_start_sec', String(takeSnapshot.startSec));
      form.append('audio_end_sec', String(takeSnapshot.endSec));
      if (previewResult?.recognizedText) {
        form.append('recognized_text', previewResult.recognizedText);
      }

      const res = await fetch('/api/shadowing/analyze', {
        method: 'POST',
        body: form,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof data?.detail === 'string'
            ? data.detail
            : data?.error || 'Shadowing analysis failed.'
        );
      }

      const { dataUrl } = await blobToBase64(recordedWavBlob).catch(() => ({
        dataUrl: recordedAudioUrl || '',
      }));

      const report = normalizeReportFromAnalyzeApi(
        data,
        takeSnapshot,
        videoId,
        videoTitle,
        channel,
        previewResult?.durationSec ?? recordingSecRef.current,
        dataUrl || recordedAudioUrl || undefined
      );

      updateSessionState('reviewed');
      onReportGenerated(report);
    } catch (err: any) {
      updateSessionState('ready');
      onEvaluationError?.(
        err?.message || 'Failed to analyze shadowing performance.'
      );
    }
  };

  const handleRecordAgain = () => {
    setFinalizeError(null);
    setPreviewResult(null);
    setRecordedWavBlob(null);
    revokeActiveAudioUrl();
    setRecordedAudioUrl(null);
    resetStreamingState();
    updateSessionState('idle');
  };

  useEffect(() => {
    if (triggerAnalyzeRef) {
      triggerAnalyzeRef.current = () => {
        void handleAnalyzeShadowing();
      };
    }
    if (triggerRecordAgainRef) {
      triggerRecordAgainRef.current = handleRecordAgain;
    }
  });

  // R08: Demo take clearly flagged with isDemo: true so it never pollutes SQLite history averages
  const handleSimulateDemoTake = async () => {
    const sampleSegs =
      mode === 'simultaneous'
        ? effectiveSegments.slice(0, Math.min(3, effectiveSegments.length))
        : effectiveSegments;
    const snap = createSnapshot(sampleSegs, mode);
    const words = snap.targetText.split(' ');
    const simulatedSpeech =
      language === 'ja'
        ? snap.targetText.slice(0, Math.max(4, snap.targetText.length - 3))
        : words.length > 4
        ? words.filter((_, i) => i !== 2).join(' ')
        : snap.targetText;

    updateSessionState('analyzing');
    onEvaluationError?.(null);

    try {
      const res = await fetch('/api/shadowing/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetText: snap.targetText,
          language: snap.language,
          mode: snap.mode,
          webSpeechTranscript: simulatedSpeech,
          durationSec: Number((snap.targetDurationSec * 1.05).toFixed(1)),
          targetDurationSec: snap.targetDurationSec,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof data?.detail === 'string' ? data.detail : data?.error || 'Demo take failed.'
        );
      }
      const report = normalizeReportFromAnalyzeApi(
        data,
        snap,
        videoId,
        videoTitle,
        channel,
        Number((snap.targetDurationSec * 1.05).toFixed(1))
      );
      report.isDemo = true;
      updateSessionState('reviewed');
      onReportGenerated(report);
    } catch (err: any) {
      updateSessionState('idle');
      onEvaluationError?.(err?.message || 'Demo assessment failed.');
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4 min-w-0">
      {/* Header & Mode Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <Mic className="w-4 h-4 text-sky-600 shrink-0" />
            <span>AI Shadowing Practice</span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {mode === 'listen_repeat'
              ? 'Listen to the segment, auto-pause, then record your repetition.'
              : 'Video plays continuously without pausing. Wear headphones so your mic captures only your voice.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#151925] border border-[#525a6d] rounded-lg">
          <button
            type="button"
            aria-pressed={mode === 'listen_repeat'}
            disabled={isBusy || isEvaluating}
            onClick={() => {
              onSetAutoPauseAtSec(null);
              setCapturedSimultaneousSegments(null);
              onModeChange('listen_repeat');
              handleRecordAgain();
            }}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              mode === 'listen_repeat'
                ? 'bg-[#c3bbff] text-[#151925] shadow-xs'
                : 'text-[#b8c1d4] hover:text-[#eef1fa]'
            }`}
          >
            Listen and repeat
          </button>
          <button
            type="button"
            aria-pressed={mode === 'simultaneous'}
            disabled={isBusy || isEvaluating}
            onClick={() => {
              onSetAutoPauseAtSec(null);
              onClearLoopSegment();
              setCapturedSimultaneousSegments(null);
              onModeChange('simultaneous');
              handleRecordAgain();
            }}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              mode === 'simultaneous'
                ? 'bg-[#c3bbff] text-[#151925] shadow-xs'
                : 'text-[#b8c1d4] hover:text-[#eef1fa]'
            }`}
          >
            Simultaneous
          </button>
        </div>
      </div>

      {/* Headphone Advisory for Simultaneous Mode */}
      {mode === 'simultaneous' && (
        <div className="px-3 py-2 bg-slate-50 border border-slate-200/80 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
          <div className="flex items-center gap-2 min-w-0">
            <Headphones className="w-4 h-4 text-sky-600 shrink-0" />
            <span>
              <strong>Continuous Simultaneous Mode:</strong> Wear headphones so your mic captures only your voice.
            </span>
          </div>
          <span className="font-mono-tabular text-slate-500 shrink-0">
            {formatTimestamp(startSec)} – {formatTimestamp(endSec)}
          </span>
        </div>
      )}

      {/* Target Script Preview Box (with Japanese Furigana <ruby> support — U03) */}
      <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-lg">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 mb-1.5">
          <span>
            {mode === 'listen_repeat'
              ? 'Active Sentence Target'
              : `Continuous Scope (${effectiveSegments.length} Segments)`}
          </span>
          <span className="font-mono-tabular">
            {targetDurationSec.toFixed(1)}s
          </span>
        </div>
        <div className="text-sm sm:text-base font-medium text-slate-900 leading-relaxed max-h-28 overflow-y-auto break-words">
          {language === 'ja' && showFurigana && activeSegment.tokens && activeSegment.tokens.length > 0 ? (
            <span className="inline-flex flex-wrap items-baseline gap-x-0.5">
              {(mode === 'simultaneous' ? activeSegment.tokens : effectiveSegments.flatMap((s) => s.tokens || [{ surface: s.text }])).map((tok, i) => {
                const useRuby =
                  tok.reading &&
                  tok.reading !== tok.surface &&
                  /[\u4e00-\u9faf]/.test(tok.surface);
                return useRuby ? (
                  <ruby key={i} className="mr-0.5">
                    {tok.surface}
                    <rt>{tok.reading}</rt>
                  </ruby>
                ) : (
                  <span key={i}>{tok.surface}</span>
                );
              })}
            </span>
          ) : (
            <span>{mode === 'simultaneous' ? activeSegment.text : targetText}</span>
          )}
        </div>
      </div>

      {/* Active Capture / Permission / Listening / Finalizing Status */}
      {(sessionState === 'permission' ||
        sessionState === 'listening' ||
        sessionState === 'recording' ||
        sessionState === 'paused' ||
        sessionState === 'finalizing') && (
        <div className="p-3.5 bg-sky-50/70 border border-sky-200 rounded-lg space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-sky-950">
              {sessionState === 'permission' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
                  <span>Requesting microphone access...</span>
                </>
              ) : sessionState === 'listening' ? (
                <>
                  <Volume2 className="w-4 h-4 text-sky-600" />
                  <span>Listening to Native Speaker (mic starts at pause)</span>
                </>
              ) : sessionState === 'paused' ? (
                <>
                  <Pause className="w-4 h-4 text-amber-600" />
                  <span>Recording Paused</span>
                </>
              ) : sessionState === 'finalizing' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
                  <span>Encoding 16 kHz WAV &amp; running local Whisper transcription...</span>
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4 text-red-500 animate-pulse" />
                  <span>
                    {mode === 'simultaneous'
                      ? 'Simultaneously Recording (100% local)'
                      : 'Recording Your Voice (100% local)'}
                  </span>
                </>
              )}
            </div>
            <span className="text-xs font-mono-tabular font-semibold text-slate-700">
              {recordingSec.toFixed(1)}s / {targetDurationSec.toFixed(1)}s
            </span>
          </div>

          {sessionState === 'listening' && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <span className="text-xs text-slate-600">
                Pauses at {formatTimestamp(activeSegment.endTime)}
              </span>
              <button
                type="button"
                onClick={handleRecordImmediately}
                className="px-3 py-1 text-xs font-medium bg-sky-600 text-white rounded-md hover:bg-sky-700 cursor-pointer whitespace-nowrap shrink-0"
              >
                Skip Listen &amp; Record Now
              </button>
            </div>
          )}

          {(sessionState === 'recording' || sessionState === 'paused') && (
            <>
              <canvas
                ref={canvasRef}
                width={520}
                height={42}
                className="w-full h-10 bg-slate-950/60 border border-sky-100 rounded-md"
              />
              {(mode === 'simultaneous' || liveRecognizedText || isStreamingChunk) && (
                <div className="p-2.5 bg-slate-50 border border-slate-200/80 rounded-md space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-sky-900">
                      Live Whisper Recognition
                    </span>
                    {isStreamingChunk && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-100 text-sky-900 text-[11px] font-medium">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>Transcribing chunk...</span>
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-700 leading-relaxed max-h-20 overflow-y-auto break-words">
                    {liveRecognizedText || 'Listening for speech...'}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Microphone Error Banner */}
      {micError && (
        <div role="alert" className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2.5 text-xs text-amber-900">
          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <p>{micError}</p>
            <button
              type="button"
              onClick={handleSimulateDemoTake}
              className="px-3 py-1.5 bg-amber-800 hover:bg-amber-900 text-white font-medium rounded-md transition-colors cursor-pointer"
            >
              Start Demo Take
            </button>
          </div>
        </div>
      )}

      {/* Primary Action Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {sessionState === 'idle' || sessionState === 'ready' || sessionState === 'reviewed' ? (
            <>
              {(() => {
                const isListenRepeatEvaluated = Boolean(
                  mode === 'listen_repeat' &&
                    latestReport &&
                    !latestReport.isDemo &&
                    latestReport.mode === 'listen_repeat' &&
                    latestReport.segmentIds.includes(activeSegment.id)
                );
                const hasNextSentence = activeSegment.index + 1 < allSegments.length;

                return (
                  <button
                    type="button"
                    onClick={handleStartSession}
                    disabled={isEvaluating}
                    className="flex items-center gap-2 px-4 py-2.5 bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    {mode === 'listen_repeat' && isListenRepeatEvaluated && hasNextSentence ? (
                      <>
                        <ArrowRight className="w-4 h-4" />
                        <span>Next Sentence</span>
                      </>
                    ) : (
                      <>
                        <Mic className="w-4 h-4" />
                        <span>
                          {sessionState === 'ready' || sessionState === 'reviewed'
                            ? 'Record Again'
                            : 'Record Yourself'}
                        </span>
                      </>
                    )}
                  </button>
                );
              })()}

              {mode === 'listen_repeat' && sessionState === 'idle' && (
                <button
                  type="button"
                  onClick={handleRecordImmediately}
                  disabled={isEvaluating}
                  className="flex items-center gap-1.5 px-3.5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Mic className="w-3.5 h-3.5 text-slate-600" />
                  <span>Record Immediately</span>
                </button>
              )}
            </>
          ) : sessionState === 'permission' || sessionState === 'listening' ? (
            <button
              type="button"
              onClick={handleCancelActiveTake}
              className="flex items-center gap-2 px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              <span>Cancel</span>
            </button>
          ) : sessionState === 'recording' || sessionState === 'paused' ? (
            <>
              <button
                type="button"
                onClick={handleFinishRecording}
                className="flex items-center gap-2 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>Finish Recording</span>
              </button>

              <button
                type="button"
                onClick={handlePauseOrResumeRecording}
                className="flex items-center gap-1.5 px-3 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {sessionState === 'paused' ? (
                  <>
                    <Play className="w-3.5 h-3.5" />
                    <span>Resume Recording</span>
                  </>
                ) : (
                  <>
                    <Pause className="w-3.5 h-3.5" />
                    <span>Pause Recording</span>
                  </>
                )}
              </button>
            </>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {sessionState === 'idle' && (
            <button
              type="button"
              onClick={handleSimulateDemoTake}
              disabled={isEvaluating}
              title="Run a demo take without speaking into a microphone (excluded from real progress)"
              className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              Start demo take
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// S05 Full-Width Local Whisper Preview Card (Rendered below .echo-studio)
// ---------------------------------------------------------------------------

interface RecognizedSpeechPreviewProps {
  state: S05PreviewState;
  onPlayRecordedAudio?: () => void;
  onRecordAgain: () => void;
  onAnalyzeResult: () => void;
}

export const RecognizedSpeechPreview: React.FC<RecognizedSpeechPreviewProps> = ({
  state,
  onRecordAgain,
  onAnalyzeResult,
}) => {
  const { sessionState, preview, recordedAudioUrl, finalizeError } = state;
  const audioRef = useRef<HTMLAudioElement | null>(null);

  if (
    sessionState !== 'recording' &&
    sessionState !== 'paused' &&
    sessionState !== 'finalizing' &&
    sessionState !== 'ready' &&
    sessionState !== 'analyzing'
  ) {
    return null;
  }

  const isLiveSession = sessionState === 'recording' || sessionState === 'paused';
  const hasSpeech = Boolean(
    preview && !preview.isSilent && preview.recognizedText.trim().length > 0
  );

  return (
    <section
      aria-label="AI Recognized Speech Preview"
      className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-slate-900">
          AI Recognized Speech:
        </h2>

        {isLiveSession ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-medium bg-sky-50 text-sky-800 border border-sky-200">
              {state.isStreamingChunk ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-600" />
              ) : (
                <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
              )}
              <span>
                Live Streaming · {(state.recordingSec ?? 0).toFixed(1)}s
              </span>
            </span>
          </div>
        ) : (
          preview && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-medium ${
                  hasSpeech
                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    : 'bg-amber-50 text-amber-800 border border-amber-200'
                }`}
              >
                {hasSpeech ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5" />
                )}
                <span>
                  Audio Ready · {preview.durationSec.toFixed(1)}s · {preview.rmsDb.toFixed(1)} dBFS
                </span>
              </span>
            </div>
          )
        )}
      </div>

      {isLiveSession && (
        <p className="text-sm sm:text-base text-slate-800 leading-relaxed bg-slate-50 border border-slate-200/80 rounded-lg p-4">
          {state.liveRecognizedText?.trim() ||
            'Listening and transcribing your speech in real time...'}
        </p>
      )}

      {sessionState === 'finalizing' && (
        <div className="flex items-center gap-2 text-sm text-slate-600 py-3">
          <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
          <span>Transcribing your recording locally with Whisper Large-v3-Turbo...</span>
        </div>
      )}

      {finalizeError && (
        <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
          {finalizeError}
        </div>
      )}

      {preview && !isLiveSession && sessionState !== 'finalizing' && (
        <>
          {!hasSpeech ? (
            <div
              role="status"
              className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2.5 text-xs sm:text-sm text-amber-950"
            >
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <span>
                {preview.whisperError || (!preview.isSilent && preview.rmsDb > -45) || !preview.isSilent
                  ? preview.whisperError ||
                    'Audio was recorded clearly, but local Whisper transcription returned empty text — you can still click Analyze Shadowing Result or Record Again.'
                  : 'No clear speech detected in recording — please check your microphone or record again.'}
              </span>
            </div>
          ) : (
            <p className="text-sm sm:text-base text-slate-800 leading-relaxed bg-slate-50 border border-slate-200/80 rounded-lg p-4">
              {preview.recognizedText}
            </p>
          )}
        </>
      )}

      {!isLiveSession && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onAnalyzeResult}
              disabled={
                sessionState !== 'ready' || Boolean(finalizeError)
              }
              className="flex items-center gap-2 px-4 py-2.5 bg-sky-600 hover:bg-sky-700 text-white text-xs sm:text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {sessionState === 'analyzing' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Analyzing Shadowing Result...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Analyze Shadowing Result</span>
                </>
              )}
            </button>

            {recordedAudioUrl && (
              <button
                type="button"
                onClick={() => {
                  if (audioRef.current) {
                    audioRef.current.currentTime = 0;
                    audioRef.current.play().catch(() => {});
                  }
                }}
                className="flex items-center gap-1.5 px-3.5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Play Recorded Audio</span>
              </button>
            )}

            <button
              type="button"
              onClick={onRecordAgain}
              disabled={sessionState === 'analyzing'}
              className="flex items-center gap-1.5 px-3.5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Record Again</span>
            </button>
          </div>

          {recordedAudioUrl && (
            <audio
              ref={audioRef}
              controls
              src={recordedAudioUrl}
              className="h-8 max-w-[260px]"
            />
          )}
        </div>
      )}
    </section>
  );
};
