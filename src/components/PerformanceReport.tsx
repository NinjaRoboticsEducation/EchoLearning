import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Award,
  CheckCircle2,
  HelpCircle,
  Info,
  Loader2,
  Play,
  RotateCcw,
  Volume2,
  XCircle,
} from 'lucide-react';
import { ShadowingAssessmentReport } from '../types';

interface PerformanceReportProps {
  report: ShadowingAssessmentReport;
  onReplayOriginalSegment?: () => void;
  onRetryPractice?: () => void;
}

export const PerformanceReport: React.FC<PerformanceReportProps> = ({
  report,
  onReplayOriginalSegment,
  onRetryPractice,
}) => {
  const [playingWord, setPlayingWord] = useState<string | null>(null);
  const [showMethodology, setShowMethodology] = useState(false);

  const handlePlayWordTts = async (word: string) => {
    if (playingWord) return;
    setPlayingWord(word);
    try {
      const res = await fetch('/api/tts/pronounce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: word, language: report.language }),
      });
      const data = await res.json();
      if (res.ok && data.audioBase64) {
        const audio = new Audio(`data:${data.mimeType || 'audio/wav'};base64,${data.audioBase64}`);
        audio.onended = () => setPlayingWord(null);
        audio.onerror = () => setPlayingWord(null);
        await audio.play();
      } else {
        setPlayingWord(null);
      }
    } catch {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          const u = new SpeechSynthesisUtterance(word);
          u.lang = report.language === 'ja' ? 'ja-JP' : 'en-US';
          u.onend = () => setPlayingWord(null);
          u.onerror = () => setPlayingWord(null);
          window.speechSynthesis.speak(u);
          return;
        } catch {
          // Ignore
        }
      }
      setPlayingWord(null);
    }
  };

  const assessmentStatus = report.assessmentStatus;
  const isClipped = Boolean(report.isClipped ?? report.metrics?.isClipped);
  const f0StdSt = report.f0StdSt ?? report.metrics?.f0StdSt;
  const durationLatencySec =
    report.durationLatencySec ?? report.metrics?.durationLatencySec;
  const articulationRateValue =
    report.articulationRateValue ?? report.metrics?.articulationRateValue;
  const unplannedPauseCount =
    report.unplannedPauseCount ?? report.metrics?.unplannedPauseCount;
  const repairCount =
    report.repairCount ??
    report.metrics?.repairCount ??
    report.wordDiff.filter((t) => t.status === 'self_repair').length;

  const getScoreTierLabel = (score: number, status?: string) => {
    if (status === 'hallucination_filtered') {
      return {
        text: '⚠ Background Noise / Hallucination Filtered',
        color: 'text-amber-600',
        note: 'Whisper picked up background noise or a subtitle artifact instead of your target lines. Move closer to your mic and try again.',
      };
    }
    if (status === 'too_short') {
      return {
        text: '⚠ Recording Too Short',
        color: 'text-amber-600',
        note: 'The recorded clip was shorter than the minimum target duration. Keep speaking through the full phrase before finishing.',
      };
    }
    if (status === 'no_speech') {
      return {
        text: '✕ No Speech Detected',
        color: 'text-red-500',
        note: 'No clear voice signal was captured. Check your microphone input/permissions and speak at normal conversational volume.',
      };
    }
    if (status === 'decode_error' || status === 'low_audio_quality') {
      return {
        text: '⚠ Low Audio Quality',
        color: 'text-amber-600',
        note: 'The audio stream could not be decoded cleanly. Check your microphone connection and try another take.',
      };
    }
    if (score >= 88) {
      return {
        text: '✓ High Mastery · Strong Task Match',
        color: 'text-emerald-600',
        note: 'Strong reproduction and rhythm on this practice clip (task-specific checkpoint, not a generalized proficiency level).',
      };
    }
    if (score >= 72) {
      return {
        text: '● Solid Developing Fluency',
        color: 'text-sky-600',
        note: undefined,
      };
    }
    if (score > 0) {
      return {
        text: '▲ Needs Targeted Practice',
        color: 'text-amber-600',
        note: undefined,
      };
    }
    return {
      text: '✕ No Speech Detected',
      color: 'text-red-500',
      note: 'No clear speech was detected in this recording. Check your microphone and try again.',
    };
  };

  const tier = getScoreTierLabel(report.overallScore, assessmentStatus);
  const isDiagnosticHardGate = Boolean(
    assessmentStatus &&
      ['hallucination_filtered', 'too_short', 'no_speech', 'decode_error', 'low_audio_quality'].includes(
        assessmentStatus
      )
  ) || report.overallScore <= 0;
  const replayAudioSrc =
    report.audioDataUrl ||
    report.audioUrl ||
    (report.recordingId ? `/api/audio/${encodeURIComponent(report.recordingId)}` : undefined);

  const pillars = [
    {
      label: 'Content Accuracy',
      score: report.accuracyScore ?? report.dimensions.contentAccuracy,
      basis: 'Weighted Transcript Match',
      desc: 'Measures exact spoken words/morphemes against the script (unstressed function words weighted 0.5×; self-repairs unpenalized).',
    },
    {
      label: 'Pronunciation',
      score: report.pronunciationScore ?? report.dimensions.pronunciation,
      basis: 'ASR- & Phonetic-Based Clarity',
      desc:
        report.language === 'ja'
          ? 'Evaluates kana articulation, long vowels (長音), double consonants (っ), and Whisper acoustic confidence.'
          : 'Evaluates Whisper acoustic word confidence and Functional-Load / onset-weighted phoneme alignment.',
    },
    {
      label: 'Fluency & Pacing',
      score: report.fluencyScore ?? report.dimensions.fluency,
      basis: 'Articulation Rate + Continuity',
      desc: `Your pace: ${Math.round(report.speechRateWpm ?? report.metrics.speechRateValue)} ${report.metrics.speechRateUnit} (Target: ${Math.round(report.metrics.targetRateValue)} ${report.metrics.speechRateUnit}).`,
    },
    {
      label: 'Prosody & Rhythm',
      score: report.prosodyScore ?? report.dimensions.prosody,
      basis: 'Semitone (ST) F0 & Rhythm Analysis',
      desc:
        report.language === 'ja'
          ? 'Evaluates mora-timed cadence and speaker-normalized Semitone (ST) pitch movement.'
          : 'Evaluates speaker-normalized Semitone (ST) intonation spread, energy dynamics, and phrasing.',
    },
  ];

  // Normalize pitchContour bars (max 48 bars for clean rendering)
  const contourValues = (report.pitchContour || []).filter(
    (v) => typeof v === 'number' && Number.isFinite(v) && v > 0
  );
  const sampledContour =
    contourValues.length > 48
      ? Array.from({ length: 48 }, (_, i) =>
          contourValues[Math.floor((i / 48) * contourValues.length)]
        )
      : contourValues;
  const maxPitch = sampledContour.length > 0 ? Math.max(...sampledContour, 1) : 1;
  const minPitch = sampledContour.length > 0 ? Math.min(...sampledContour) : 0;
  const pitchRange = Math.max(10, maxPitch - minPitch);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
      {/* Section A: Overall Performance Score & Next Steps */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-200">
        <div className="space-y-1.5 min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <Award className="w-4 h-4 text-sky-600 shrink-0" />
            <span>AI Shadowing Evaluation</span>
            <span aria-hidden="true">·</span>
            <span>
              {report.mode === 'listen_repeat'
                ? 'Listen-Then-Repeat'
                : 'Simultaneous Mode'}
            </span>
            {report.isDemo && (
              <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-semibold">
                Demo Take (Not Saved to Real Progress)
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-bold font-mono-tabular text-slate-900">
              {Math.round(report.overallScore)}
              <span className="text-lg font-normal text-slate-400">/100</span>
            </span>
            <span className={`text-sm font-semibold ${tier.color}`} title={tier.note}>
              {tier.text}
            </span>
          </div>
          {tier.note && !isDiagnosticHardGate && (
            <p className="text-[11px] text-emerald-800 font-medium">{tier.note}</p>
          )}
          <p className="text-xs text-slate-600 max-w-2xl leading-relaxed">
            {report.scoreExplanation}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onReplayOriginalSegment}
            disabled={!onReplayOriginalSegment}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5 text-sky-600" />
            <span>Replay Native Audio</span>
          </button>

          <button
            type="button"
            onClick={onRetryPractice}
            disabled={!onRetryPractice}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-sky-600 hover:bg-sky-700 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Practice Again</span>
          </button>
        </div>
      </div>

      {/* Step 0 Diagnostics & Microphone Gain Warnings */}
      {isDiagnosticHardGate && tier.note && (
        <div
          role="status"
          className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2.5 text-xs text-amber-950"
        >
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <div className="font-semibold">{tier.text}</div>
            <p className="text-amber-900">{tier.note}</p>
          </div>
        </div>
      )}

      {isClipped && (
        <div
          role="status"
          className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2.5 text-xs text-amber-950"
        >
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <strong>Microphone Clipping Detected:</strong> Your input signal peaked too high. Lower your microphone gain or step back 15–25 cm for cleaner acoustic scoring.
          </div>
        </div>
      )}

      {/* 4 Evaluation Dimensions Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {pillars.map((p) => (
          <div
            key={p.label}
            className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-lg flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-800">{p.label}</span>
                <span className="text-base font-bold font-mono-tabular text-slate-900">
                  {Math.round(p.score)}%
                </span>
              </div>
              <div className="text-[11px] text-sky-800 font-medium mt-0.5">{p.basis}</div>
              <p className="text-xs text-slate-600 mt-1.5 leading-snug">{p.desc}</p>
            </div>
            <div className="mt-3 w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${
                  p.score >= 85
                    ? 'bg-emerald-600'
                    : p.score >= 70
                    ? 'bg-sky-600'
                    : 'bg-amber-600'
                }`}
                style={{ width: `${Math.min(100, Math.max(4, p.score))}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Acoustic Telemetry & Pitch/Intonation Contour (Phase R5) */}
      {(sampledContour.length > 0 || typeof report.energyDb === 'number') && (
        <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-lg space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-1.5 font-semibold text-slate-800">
              <Activity className="w-4 h-4 text-sky-600" />
              <span>Acoustic Pitch (F0) &amp; Energy Telemetry</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 font-mono-tabular text-slate-600">
              <span>
                Speech Rate: <strong>{Math.round(report.speechRateWpm ?? report.metrics.speechRateValue)}</strong> {report.metrics.speechRateUnit}
              </span>
              {typeof articulationRateValue === 'number' && Number.isFinite(articulationRateValue) && (
                <span>
                  Articulation: <strong>{Math.round(articulationRateValue)}</strong> {report.language === 'ja' ? 'moras/min' : 'syl/min'}
                </span>
              )}
              {typeof report.energyDb === 'number' && (
                <span>
                  RMS Energy: <strong>{report.energyDb.toFixed(1)}</strong> dBFS
                </span>
              )}
              {typeof f0StdSt === 'number' && Number.isFinite(f0StdSt) && (
                <span>
                  Pitch Spread: <strong>{f0StdSt.toFixed(2)} ST</strong>
                </span>
              )}
              {sampledContour.length > 0 && (
                <span>
                  F0 Range: <strong>{Math.round(minPitch)}–{Math.round(maxPitch)} Hz</strong>
                </span>
              )}
              {typeof unplannedPauseCount === 'number' && Number.isFinite(unplannedPauseCount) && (
                <span>
                  Unplanned Pauses: <strong>{unplannedPauseCount}</strong>
                </span>
              )}
            </div>
          </div>

          {typeof durationLatencySec === 'number' && durationLatencySec > 0.5 && (
            <div className="px-2.5 py-1.5 bg-amber-50/80 border border-amber-200/80 rounded-md text-xs text-amber-900">
              <strong>Trailing Duration Latency:</strong> Recording ran{' '}
              <span className="font-mono-tabular font-semibold">+{durationLatencySec.toFixed(1)}s</span>{' '}
              past the target clip span (factored into Fluency &amp; Pacing).
            </div>
          )}

          {sampledContour.length > 0 && (
            <div
              className="flex items-end gap-1 h-14 pt-2 px-1 bg-slate-950/50 rounded-md"
              aria-label="Pitch intonation contour bars"
            >
              {sampledContour.map((hz, i) => {
                const pct = Math.max(15, Math.min(100, Math.round(((hz - minPitch) / pitchRange) * 80 + 20)));
                return (
                  <div
                    key={i}
                    title={`${Math.round(hz)} Hz`}
                    className="flex-1 bg-sky-600 rounded-t-sm min-w-[2px]"
                    style={{ height: `${pct}%` }}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Methodology Toggle */}
      <div className="bg-slate-50 border border-slate-200/80 rounded-lg px-3.5 py-2.5 text-xs text-slate-600">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-medium text-slate-800">
            <Info className="w-3.5 h-3.5 text-sky-600 shrink-0" />
            <span>
              {report.mode === 'simultaneous'
                ? 'Weighted composite (Simultaneous): 25% Content Accuracy · 20% Pronunciation · 30% Fluency · 25% Prosody'
                : 'Weighted composite (Listen-Then-Repeat): 30% Content Accuracy · 30% Pronunciation · 20% Fluency · 20% Prosody'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowMethodology(!showMethodology)}
            className="text-sky-700 hover:text-sky-900 underline font-medium whitespace-nowrap shrink-0 cursor-pointer"
          >
            {showMethodology ? 'Hide Assessment Notes' : 'Assessment Methodology'}
          </button>
        </div>
        {showMethodology && (
          <p className="mt-2 text-slate-600 leading-relaxed border-t border-slate-200 pt-2">
            All four dimension scores are computed deterministically from local 16 kHz PCM acoustic telemetry (60–450 Hz Semitone F0 contour, RMS energy, syllable-normalized unplanned pauses, pure articulation rate), Whisper word-level alignment/confidence with Functional Load weighting, and MeCab mora segmentation before local ADK coaching feedback is generated.
          </p>
        )}
      </div>

      {/* Section B: Transcript Comparison & Error Attribution */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-slate-900">
            Transcript Comparison &amp; Error Attribution
          </h3>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              <span>Matched</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <XCircle className="w-3.5 h-3.5 text-red-600" />
              <span>Omitted ({report.metrics.omittedCount})</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
              <span>Substituted ({report.metrics.substitutedCount})</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <HelpCircle className="w-3.5 h-3.5 text-slate-500" />
              <span>STT Note ({report.metrics.uncertainSttCount})</span>
            </span>
            {repairCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <RotateCcw className="w-3.5 h-3.5 text-indigo-600" />
                <span>Self-repair ({repairCount})</span>
              </span>
            )}
          </div>
        </div>

        <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
          <div className="space-y-1 text-xs">
            <div className="text-slate-500">
              <span className="font-semibold text-slate-700">Target: </span>
              <span>{report.targetText}</span>
            </div>
            <div className="text-slate-700">
              <span className="font-semibold text-slate-900">Recognized: </span>
              <span>"{report.recognizedTranscript || 'No speech transcript captured'}"</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm leading-relaxed">
            {report.wordDiff.map((tok, idx) => {
              if (tok.status === 'correct') {
                return (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-md font-medium"
                  >
                    <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" />
                    <span>{tok.word}</span>
                  </span>
                );
              }
              if (tok.status === 'omitted') {
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handlePlayWordTts(tok.word)}
                    title={tok.explanation || 'Omitted word — click to hear reference pronunciation'}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-50 border border-red-200 text-red-900 rounded-md font-medium cursor-pointer hover:bg-red-100"
                  >
                    <XCircle className="w-3 h-3 text-red-600 shrink-0" />
                    <span className="line-through">{tok.word}</span>
                    <span className="text-[11px] text-red-700">(Omitted)</span>
                  </button>
                );
              }
              if (tok.status === 'substituted') {
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handlePlayWordTts(tok.expectedWord || tok.word)}
                    title={tok.explanation || 'Click to hear reference pronunciation'}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 border border-amber-200 text-amber-950 rounded-md font-medium cursor-pointer hover:bg-amber-100"
                  >
                    <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
                    <span>
                      {tok.word}
                      {tok.expectedWord && tok.expectedWord !== tok.word
                        ? ` → ${tok.expectedWord}`
                        : ''}
                    </span>
                  </button>
                );
              }
              if (tok.status === 'stt_uncertain') {
                return (
                  <span
                    key={idx}
                    title={tok.explanation || 'Possible STT artifact'}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-dashed border-slate-300 text-slate-700 rounded-md"
                  >
                    <HelpCircle className="w-3 h-3 text-slate-500 shrink-0" />
                    <span>{tok.word}</span>
                  </span>
                );
              }
              if (tok.status === 'self_repair') {
                return (
                  <span
                    key={idx}
                    title={
                      tok.explanation ||
                      'Immediate self-repair (counted in Repair Fluency, not penalized as a content error)'
                    }
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-50 border border-indigo-200 text-indigo-900 rounded-md text-xs font-medium"
                  >
                    <RotateCcw className="w-3 h-3 text-indigo-600 shrink-0" />
                    <span>{tok.word} (Self-repair)</span>
                  </span>
                );
              }
              return (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-200 text-slate-800 rounded-md text-xs"
                >
                  +{tok.word} (Added)
                </span>
              );
            })}
          </div>

          {replayAudioSrc ? (
            <div className="pt-2 border-t border-slate-200/70 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800">Replay Your Recording:</span>
              <audio controls src={replayAudioSrc} className="h-8 max-w-[260px]" />
            </div>
          ) : (
            <div className="pt-2 border-t border-slate-200/70 text-xs text-slate-500">
              Recording audio unavailable for this session.
            </div>
          )}
        </div>
      </div>

      {/* Section C: Actionable Pronunciation & Phoneme/Mora Coaching */}
      {report.pronunciationFeedback?.length > 0 && (
        <div className="space-y-2.5">
          <h3 className="text-xs font-semibold text-slate-900">
            Specific Pronunciation &amp; Articulation Coaching
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {report.pronunciationFeedback.map((item, idx) => (
              <div
                key={idx}
                className="p-3.5 bg-white border border-slate-200 rounded-lg flex flex-col justify-between gap-2"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-bold text-slate-900">
                        {item.targetWord}
                      </span>
                      {item.readingOrIpa && (
                        <span className="text-xs font-mono-tabular text-sky-700">
                          {item.readingOrIpa}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handlePlayWordTts(item.targetWord)}
                        disabled={playingWord === item.targetWord}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
                      >
                        {playingWord === item.targetWord ? (
                          <Loader2 className="w-3 h-3 animate-spin text-sky-600" />
                        ) : (
                          <Volume2 className="w-3 h-3 text-sky-600" />
                        )}
                        <span>Hear Model</span>
                      </button>
                      {onReplayOriginalSegment && (
                        <button
                          type="button"
                          onClick={onReplayOriginalSegment}
                          title="Hear this phrase in the original video clip for connected-speech coarticulation"
                          className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-sky-50 hover:bg-sky-100 text-sky-900 border border-sky-200 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <Play className="w-3 h-3 text-sky-600" />
                          <span>Hear in Video Clip</span>
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {item.category} · Priority: {(item.severity || 'medium').toUpperCase()}
                  </div>
                  <p className="text-xs text-slate-700 mt-1.5">
                    <strong className="text-slate-900">Observed: </strong>
                    {item.observedIssue}
                  </p>
                </div>
                <div className="p-2 bg-sky-50/70 border border-sky-100 rounded text-xs text-sky-950">
                  <strong>How to Adjust: </strong>
                  {item.actionableTip}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 1-1-1 Phrase-Build Guided Retry Drill */}
      {report.overallScore > 0 &&
        (report.pronunciationFeedback?.length > 0 || report.recommendedRetryText) && (
          <div className="p-3.5 bg-sky-50/70 border border-sky-200/80 rounded-lg space-y-1.5 text-xs text-sky-950">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">
                1-1-1 Phrase-Build Retry Drill (Recommended)
              </span>
              {onReplayOriginalSegment && (
                <button
                  type="button"
                  onClick={onReplayOriginalSegment}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-white hover:bg-sky-100 text-sky-900 border border-sky-200 rounded font-medium cursor-pointer"
                >
                  <Play className="w-3 h-3 text-sky-600" />
                  <span>Hear in Video Clip</span>
                </button>
              )}
            </div>
            <p className="text-sky-900 leading-relaxed">
              <strong>(1)</strong> Say the target word <strong>1×</strong> after <em>Hear Model</em> →{' '}
              <strong>(2)</strong> Say the 2–3 word chunk <strong>1×</strong>
              {report.recommendedRetryText ? (
                <>
                  {' '}
                  (<span className="font-semibold">"{report.recommendedRetryText}"</span>)
                </>
              ) : null}{' '}
              → <strong>(3)</strong> Re-shadow the full sentence <strong>1×</strong> smoothly.
            </p>
          </div>
        )}

      {/* Section D: Personalized Improvement Suggestions */}
      {report.improvementSuggestions?.length > 0 && (
        <div className="pt-3 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-xs font-semibold text-slate-900">
              Personalized Next Steps for Shadowing Fluency
            </h3>
            <ul className="list-disc list-inside text-xs text-slate-700 space-y-1">
              {report.improvementSuggestions.map((sug, i) => (
                <li key={i}>{sug}</li>
              ))}
            </ul>
          </div>

          <button
            type="button"
            onClick={onRetryPractice}
            disabled={!onRetryPractice}
            className="flex items-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer self-start sm:self-center"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Apply Feedback &amp; Shadow Again</span>
          </button>
        </div>
      )}
    </div>
  );
};
