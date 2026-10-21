import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Headphones,
  Loader2,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Volume2,
} from 'lucide-react';
import {
  LanguageCode,
  ShadowingAssessmentReport,
  ShadowingMode,
  TranscriptSegment,
} from '../types';
import { formatTimestamp, YouTubePlayerHandle } from './YouTubePlayer';

interface ShadowingStudioProps {
  language: LanguageCode;
  mode: ShadowingMode;
  allSegments: TranscriptSegment[];
  targetSegments: TranscriptSegment[];
  activeSegment: TranscriptSegment;
  isEvaluating: boolean;
  playerHandleRef: React.MutableRefObject<YouTubePlayerHandle | null>;
  onModeChange: (mode: ShadowingMode) => void;
  onSetAutoPauseAtSec: (sec: number | null) => void;
  onClearLoopSegment: () => void;
  onSubmitEvaluation: (payload: {
    audioBase64?: string;
    mimeType?: string;
    audioDataUrl?: string;
    webSpeechTranscript: string;
    durationSec: number;
    targetDurationSec: number;
    targetText: string;
    segmentIds: string[];
  }) => void;
  autoPauseTriggerCount: number;
  latestReport?: ShadowingAssessmentReport | null;
  onAdvanceToNextSegment?: () => TranscriptSegment | null;
}

export const ShadowingStudio: React.FC<ShadowingStudioProps> = ({
  language,
  mode,
  allSegments,
  targetSegments,
  activeSegment,
  isEvaluating,
  playerHandleRef,
  onModeChange,
  onSetAutoPauseAtSec,
  onClearLoopSegment,
  onSubmitEvaluation,
  autoPauseTriggerCount,
  latestReport,
  onAdvanceToNextSegment,
}) => {
  const [sessionState, setSessionState] = useState<
    | 'idle'
    | 'listening_to_model'
    | 'recording'
    | 'paused_recording'
    | 'recorded_ready'
  >('idle');
  const [micError, setMicError] = useState<string | null>(null);
  const [recordingSec, setRecordingSec] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [recordedBase64, setRecordedBase64] = useState<string | undefined>(
    undefined
  );
  const [recordedMimeType, setRecordedMimeType] =
    useState<string>('audio/webm');
  const [speechApiSupported, setSpeechApiSupported] = useState(true);

  // Track the exact video time window covered during Simultaneous Mode
  const simultaneousStartVideoSecRef = useRef<number>(0);
  const [capturedSimultaneousSegments, setCapturedSimultaneousSegments] =
    useState<TranscriptSegment[] | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const startTimeMsRef = useRef<number>(0);
  const isRecordingActiveRef = useRef<boolean>(false);

  // In Listen-Then-Repeat mode, focus on activeSegment;
  // In Simultaneous Mode, cover continuous segments from the current active segment (or user selection) through the end of the video!
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

  useEffect(() => {
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    setSpeechApiSupported(Boolean(SpeechRecognitionCtor));
  }, []);

  // When YouTube player hits autoPauseAtSec during 'listening_to_model', automatically begin recording
  useEffect(() => {
    if (sessionState === 'listening_to_model' && autoPauseTriggerCount > 0) {
      onSetAutoPauseAtSec(null);
      startMicrophoneCapture();
    }
  }, [autoPauseTriggerCount]);

  // Cleanup audio & speech resources on unmount
  useEffect(() => {
    return () => {
      stopAllCaptureResources();
    };
  }, []);

  const stopAllCaptureResources = () => {
    isRecordingActiveRef.current = false;
    if (timerIntervalRef.current) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onend = null;
        recognitionRef.current.stop();
      } catch {
        // Ignore
      }
      recognitionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  };

  const drawWaveform = () => {
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
      const step = Math.floor(bufferLength / barCount);
      const barWidth = Math.floor(canvas.width / barCount) - 2;

      for (let i = 0; i < barCount; i++) {
        const val = dataArray[i * step] || 0;
        const normalized = Math.max(0.1, val / 255);
        const barHeight = normalized * (canvas.height - 6);
        const x = i * (barWidth + 2);
        const y = (canvas.height - barHeight) / 2;

        ctx.fillStyle = val > 180 ? '#0284C7' : '#38BDF8';
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, 2);
        ctx.fill();
      }
    };

    renderFrame();
  };

  const startWebSpeechRecognition = () => {
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;

    try {
      const recognition = new SpeechRecognitionCtor();
      recognition.lang = language === 'ja' ? 'ja-JP' : 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;

      let finalTranscript = '';

      recognition.onresult = (event: any) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcriptPiece = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript +=
              transcriptPiece + (language === 'ja' ? '' : ' ');
          } else {
            interim += transcriptPiece;
          }
        }
        setLiveTranscript((finalTranscript + interim).trim());
      };

      recognition.onerror = () => {
        // Ignore transient browser STT errors; MediaRecorder still captures full audio
      };

      // Keep continuous speech recognition alive during long Simultaneous Shadowing sessions
      recognition.onend = () => {
        if (isRecordingActiveRef.current && recognitionRef.current) {
          try {
            recognitionRef.current.start();
          } catch {
            // Ignore restart race condition
          }
        }
      };

      recognition.start();
      recognitionRef.current = recognition;
    } catch {
      // Ignore
    }
  };

  const startMicrophoneCapture = async (): Promise<boolean> => {
    setMicError(null);
    setLiveTranscript('');
    setRecordingSec(0);
    audioChunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // Setup Web Audio API AnalyserNode for live waveform
      const AudioCtx =
        window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Determine supported MediaRecorder mimeType
      const preferredMime = MediaRecorder.isTypeSupported(
        'audio/webm;codecs=opus'
      )
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : '';

      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream);

      setRecordedMimeType(recorder.mimeType || 'audio/webm');

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        const url = URL.createObjectURL(blob);
        setRecordedAudioUrl(url);

        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.includes(',')
            ? dataUrl.split(',')[1]
            : undefined;
          setRecordedBase64(base64);
          setSessionState('recorded_ready');
        };
        reader.readAsDataURL(blob);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      isRecordingActiveRef.current = true;
      setSessionState('recording');
      startTimeMsRef.current = Date.now();

      timerIntervalRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startTimeMsRef.current) / 1000;
        setRecordingSec(elapsed);
      }, 150);

      drawWaveform();
      startWebSpeechRecognition();
      return true;
    } catch (err: any) {
      setSessionState('idle');
      onSetAutoPauseAtSec(null);
      setMicError(
        err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
          ? 'Microphone access was denied. Please allow microphone permissions in your browser address bar, or use the "Simulate Practice Take" button below to test AI assessment.'
          : 'No microphone was detected or audio capture failed. You can connect a microphone or use "Simulate Practice Take" below to test the diagnostic report.'
      );
      return false;
    }
  };

  const handleStartSession = async () => {
    setMicError(null);
    setRecordedAudioUrl(null);
    setRecordedBase64(undefined);
    setCapturedSimultaneousSegments(null);

    if (mode === 'listen_repeat') {
      let targetSeg = activeSegment;
      const isCurrentEvaluated = Boolean(
        latestReport &&
          latestReport.mode === 'listen_repeat' &&
          latestReport.segmentIds.includes(activeSegment.id)
      );

      // If previous take on current sentence was evaluated, advance to the next sentence!
      if (isCurrentEvaluated && onAdvanceToNextSegment) {
        const next = onAdvanceToNextSegment();
        if (next) {
          targetSeg = next;
        }
      }

      // Step 1: Seek YouTube player to target segment start, set single-shot autoPauseAtSec to segment end, and play native audio first
      if (playerHandleRef.current) {
        onSetAutoPauseAtSec(targetSeg.endTime);
        playerHandleRef.current.seekTo(targetSeg.startTime, true);
        playerHandleRef.current.play();
        setSessionState('listening_to_model');
      } else {
        await startMicrophoneCapture();
      }
    } else {
      // Simultaneous Mode:
      // 1. NEVER set autoPauseAtSec or loopSegment — allow uninterrupted continuous playback from start to finish!
      onSetAutoPauseAtSec(null);
      onClearLoopSegment();

      // 2. Start microphone capture FIRST so browser permission prompt never interrupts video playback
      const micStarted = await startMicrophoneCapture();
      if (!micStarted) return;

      // 3. Determine starting position and play continuously to the end of the video
      const initialStartSec =
        targetSegments.length > 1
          ? targetSegments[0].startTime
          : activeSegment?.startTime || 0;
      simultaneousStartVideoSecRef.current = initialStartSec;

      if (playerHandleRef.current) {
        const currentVidTime = playerHandleRef.current.getCurrentTime();
        if (Math.abs(currentVidTime - initialStartSec) > 1.5) {
          playerHandleRef.current.seekTo(initialStartSec, true);
        }
        playerHandleRef.current.play();
      }
    }
  };

  const handleRecordImmediately = async () => {
    onSetAutoPauseAtSec(null);
    playerHandleRef.current?.pause();
    await startMicrophoneCapture();
  };

  const handlePauseOrResumeRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (sessionState === 'recording' && recorder.state === 'recording') {
      isRecordingActiveRef.current = false;
      recorder.pause();
      playerHandleRef.current?.pause();
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      setSessionState('paused_recording');
    } else if (
      sessionState === 'paused_recording' &&
      recorder.state === 'paused'
    ) {
      isRecordingActiveRef.current = true;
      recorder.resume();
      if (mode === 'simultaneous') {
        onSetAutoPauseAtSec(null);
        playerHandleRef.current?.play();
      }
      startTimeMsRef.current = Date.now() - recordingSec * 1000;
      timerIntervalRef.current = window.setInterval(() => {
        setRecordingSec((Date.now() - startTimeMsRef.current) / 1000);
      }, 150);
      setSessionState('recording');
    }
  };

  const handleStopRecording = () => {
    onSetAutoPauseAtSec(null);
    const stopVideoSec =
      playerHandleRef.current?.getCurrentTime?.() ||
      simultaneousStartVideoSecRef.current + recordingSec;
    playerHandleRef.current?.pause();

    // In Simultaneous Mode, capture the exact segments that played during the continuous session
    if (mode === 'simultaneous' && allSegments.length > 0) {
      const startWin = simultaneousStartVideoSecRef.current;
      const endWin = Math.max(startWin + 2, stopVideoSec);
      const covered = allSegments.filter(
        (s) => s.endTime > startWin + 0.3 && s.startTime < endWin + 0.5
      );
      if (covered.length > 0) {
        setCapturedSimultaneousSegments(covered);
      }
    }

    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== 'inactive'
    ) {
      mediaRecorderRef.current.stop();
    }
    stopAllCaptureResources();
  };

  const handleTriggerEvaluation = () => {
    onSubmitEvaluation({
      audioBase64: recordedBase64,
      mimeType: recordedMimeType,
      audioDataUrl: recordedAudioUrl || undefined,
      webSpeechTranscript: liveTranscript,
      durationSec: Math.max(1.5, recordingSec),
      targetDurationSec,
      targetText,
      segmentIds: effectiveSegments.map((s) => s.id),
    });
  };

  // Allows testing the full AI evaluation pipeline even if the user has no mic or wants to simulate a near-native take
  const handleSimulatePracticeTake = () => {
    const sampleSegs =
      mode === 'simultaneous'
        ? effectiveSegments.slice(0, Math.min(4, effectiveSegments.length))
        : effectiveSegments;
    const sampleTargetText = sampleSegs
      .map((s) => s.text)
      .join(language === 'ja' ? '' : ' ');
    const sampleDur = Math.max(
      3,
      (sampleSegs[sampleSegs.length - 1]?.endTime || 6) -
        (sampleSegs[0]?.startTime || 0)
    );

    const words = sampleTargetText.split(' ');
    const simulatedSpeech =
      language === 'ja'
        ? sampleTargetText.slice(0, Math.max(4, sampleTargetText.length - 3))
        : words.length > 4
        ? words.filter((_, i) => i !== 2).join(' ')
        : sampleTargetText;

    setLiveTranscript(simulatedSpeech);
    setRecordingSec(sampleDur * 1.08);
    setSessionState('recorded_ready');
    onSubmitEvaluation({
      audioBase64: undefined,
      mimeType: 'audio/webm',
      webSpeechTranscript: simulatedSpeech,
      durationSec: Number((sampleDur * 1.08).toFixed(1)),
      targetDurationSec: sampleDur,
      targetText: sampleTargetText,
      segmentIds: sampleSegs.map((s) => s.id),
    });
  };

  const handleReplayOriginalVideo = () => {
    if (!playerHandleRef.current) return;
    if (mode === 'listen_repeat') {
      onSetAutoPauseAtSec(endSec);
    } else {
      onSetAutoPauseAtSec(null);
    }
    playerHandleRef.current.seekTo(startSec, true);
    playerHandleRef.current.play();
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
      {/* Header & Mode Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <Mic className="w-4 h-4 text-sky-600" />
            <span>AI Shadowing Practice Studio</span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {mode === 'listen_repeat'
              ? 'Listen-Then-Repeat: Plays the current sentence, auto-pauses video, then records your repetition.'
              : 'Simultaneous Shadowing: Plays the video continuously from start to finish while you shadow in real time.'}
          </p>
        </div>

        {/* Interactive Mode Segmented Control */}
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
          <button
            type="button"
            onClick={() => {
              onSetAutoPauseAtSec(null);
              setCapturedSimultaneousSegments(null);
              onModeChange('listen_repeat');
              setSessionState('idle');
            }}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              mode === 'listen_repeat'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Listen-Then-Repeat
          </button>
          <button
            type="button"
            onClick={() => {
              // Ensure no single-sentence auto-pause or loop blocks continuous playback
              onSetAutoPauseAtSec(null);
              onClearLoopSegment();
              setCapturedSimultaneousSegments(null);
              onModeChange('simultaneous');
              setSessionState('idle');
            }}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              mode === 'simultaneous'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Simultaneous Mode
          </button>
        </div>
      </div>

      {/* Headphone Advisory for Simultaneous Mode */}
      {mode === 'simultaneous' && (
        <div className="px-3 py-2 bg-slate-50 border border-slate-200/80 rounded-lg flex items-center justify-between gap-2 text-xs text-slate-600">
          <div className="flex items-center gap-2">
            <Headphones className="w-4 h-4 text-sky-600 shrink-0" />
            <span>
              <strong>Continuous Simultaneous Mode:</strong> The video will play
              continuously without pausing. Wear headphones so your mic captures
              only your voice.
            </span>
          </div>
          <span className="font-mono-tabular text-slate-500 shrink-0">
            {formatTimestamp(startSec)} – {formatTimestamp(endSec)}
          </span>
        </div>
      )}

      {/* Target Script Preview Box */}
      <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-lg">
        <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
          <span>
            {mode === 'listen_repeat'
              ? 'Active Sentence Target'
              : `Continuous Shadowing Scope (${effectiveSegments.length} Segments · ${formatTimestamp(
                  startSec
                )} – ${formatTimestamp(endSec)})`}
          </span>
          <span className="font-mono-tabular">
            Duration: {targetDurationSec.toFixed(1)}s
          </span>
        </div>
        <p className="text-sm font-medium text-slate-900 leading-relaxed max-h-28 overflow-y-auto">
          {mode === 'simultaneous' ? activeSegment.text : targetText}
        </p>
        {mode === 'simultaneous' && effectiveSegments.length > 1 && (
          <p className="text-[11px] text-slate-500 mt-1">
            Showing current active line above — follow the synchronized
            Interactive Transcript Reader on the right as the video plays
            continuously.
          </p>
        )}
      </div>

      {/* Live Recording Status & Waveform Bar */}
      {(sessionState === 'listening_to_model' ||
        sessionState === 'recording' ||
        sessionState === 'paused_recording') && (
        <div className="p-3.5 bg-sky-50/70 border border-sky-200 rounded-lg space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold text-sky-950">
              {sessionState === 'listening_to_model' ? (
                <>
                  <Volume2 className="w-4 h-4 text-sky-600" />
                  <span>
                    Step 1/2: Listening to Native Speaker... (Mic starts
                    automatically at pause)
                  </span>
                </>
              ) : sessionState === 'paused_recording' ? (
                <>
                  <Pause className="w-4 h-4 text-amber-600" />
                  <span>Recording &amp; Video Paused</span>
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4 text-red-600" />
                  <span>
                    {mode === 'simultaneous'
                      ? 'Simultaneous Recording Active — Video Playing Continuously'
                      : 'Recording Your Voice Now — Speak Clearly Along with the Script'}
                  </span>
                </>
              )}
            </div>
            <span className="text-xs font-mono-tabular font-semibold text-slate-700">
              {recordingSec.toFixed(1)}s / {targetDurationSec.toFixed(1)}s
            </span>
          </div>

          {sessionState === 'listening_to_model' ? (
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-slate-600">
                Video will pause at {formatTimestamp(activeSegment.endTime)} and
                start recording.
              </span>
              <button
                type="button"
                onClick={handleRecordImmediately}
                className="px-3 py-1 text-xs font-medium bg-sky-600 text-white rounded-md hover:bg-sky-700 cursor-pointer whitespace-nowrap shrink-0"
              >
                Skip Listen &amp; Record Now
              </button>
            </div>
          ) : (
            <>
              <canvas
                ref={canvasRef}
                width={520}
                height={42}
                className="w-full h-10 bg-white border border-sky-100 rounded-md"
              />
              <div className="text-xs text-slate-600 flex items-start justify-between gap-2">
                <div>
                  <span className="font-medium text-slate-700">
                    Live Speech Recognition:{' '}
                  </span>
                  <span className="italic text-slate-800">
                    {liveTranscript ||
                      (speechApiSupported
                        ? 'Listening for spoken words...'
                        : 'Browser live preview unavailable — full audio is being recorded for server-side Gemini transcription.')}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Microphone Error / Recovery Banner */}
      {micError && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2.5 text-xs text-amber-900">
          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <p>{micError}</p>
            <button
              type="button"
              onClick={handleSimulatePracticeTake}
              className="px-3 py-1.5 bg-amber-800 hover:bg-amber-900 text-white font-medium rounded-md transition-colors cursor-pointer"
            >
              Run Demo Assessment with Sample Spoken Take
            </button>
          </div>
        </div>
      )}

      {/* Primary Action Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {sessionState === 'idle' || sessionState === 'recorded_ready' ? (
            <>
              {(() => {
                const isCurrentEvaluated = Boolean(
                  mode === 'listen_repeat' &&
                    latestReport &&
                    latestReport.mode === 'listen_repeat' &&
                    latestReport.segmentIds.includes(activeSegment.id)
                );
                const hasNext = activeSegment.index + 1 < allSegments.length;

                return (
                  <>
                    <button
                      type="button"
                      onClick={handleStartSession}
                      disabled={isEvaluating}
                      className="flex items-center gap-2 px-4 py-2.5 bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                    >
                      {isCurrentEvaluated && hasNext ? (
                        <>
                          <ArrowRight className="w-4 h-4" />
                          <span>Start Listen-Then-Repeat (Next Sentence)</span>
                        </>
                      ) : (
                        <>
                          <Mic className="w-4 h-4" />
                          <span>
                            {mode === 'listen_repeat'
                              ? 'Start Listen-Then-Repeat'
                              : 'Start Simultaneous Shadowing'}
                          </span>
                        </>
                      )}
                    </button>

                    {isCurrentEvaluated && mode === 'listen_repeat' && (
                      <button
                        type="button"
                        onClick={() => {
                          setMicError(null);
                          setRecordedAudioUrl(null);
                          setRecordedBase64(undefined);
                          if (playerHandleRef.current) {
                            onSetAutoPauseAtSec(activeSegment.endTime);
                            playerHandleRef.current.seekTo(activeSegment.startTime, true);
                            playerHandleRef.current.play();
                            setSessionState('listening_to_model');
                          }
                        }}
                        disabled={isEvaluating}
                        className="flex items-center gap-1.5 px-3 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Retry Current Sentence</span>
                      </button>
                    )}
                  </>
                );
              })()}

              {mode === 'listen_repeat' && (
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
          ) : (
            <>
              <button
                type="button"
                onClick={handleStopRecording}
                className="flex items-center gap-2 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>Finish &amp; Stop Recording</span>
              </button>

              {sessionState !== 'listening_to_model' && (
                <button
                  type="button"
                  onClick={handlePauseOrResumeRecording}
                  className="flex items-center gap-1.5 px-3 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {sessionState === 'paused_recording' ? (
                    <>
                      <Play className="w-3.5 h-3.5" />
                      <span>Resume Mic &amp; Video</span>
                    </>
                  ) : (
                    <>
                      <Pause className="w-3.5 h-3.5" />
                      <span>Pause Mic &amp; Video</span>
                    </>
                  )}
                </button>
              )}
            </>
          )}
        </div>

        {/* Secondary Utility: Simulate Practice Take or Evaluate Recording */}
        <div className="flex items-center gap-2">
          {sessionState === 'recorded_ready' && (
            <button
              type="button"
              onClick={handleTriggerEvaluation}
              disabled={isEvaluating}
              className="flex items-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {isEvaluating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
                  <span>Analyzing Audio &amp; Prosody...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 text-sky-400" />
                  <span>Analyze Pronunciation &amp; Fluency</span>
                </>
              )}
            </button>
          )}

          {sessionState === 'idle' && (
            <button
              type="button"
              onClick={handleSimulatePracticeTake}
              disabled={isEvaluating}
              title="Run an instant AI assessment demo without speaking into a microphone"
              className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {isEvaluating ? 'Evaluating...' : 'Simulate Practice Take'}
            </button>
          )}
        </div>
      </div>

      {/* Post-Recording A/B Audio Comparison Deck */}
      {recordedAudioUrl && (
        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleReplayOriginalVideo}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5 text-sky-600" />
              <span>1. Replay Native Speaker</span>
            </button>
            <span className="text-xs text-slate-400">vs.</span>
            <span className="text-xs font-medium text-slate-700">
              2. Your Recorded Voice:
            </span>
          </div>
          <audio
            controls
            src={recordedAudioUrl}
            className="h-8 max-w-[260px]"
          />
        </div>
      )}
    </div>
  );
};
