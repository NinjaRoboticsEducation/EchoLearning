import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Loader2,
  Mic,
  Power,
  Sparkles,
  Video,
} from 'lucide-react';
import { extractYouTubeId } from './utils/youtube';
import {
  DictionaryLookupResult,
  DiffToken,
  LanguageCode,
  SavedVocabularyItem,
  ShadowingAssessmentReport,
  ShadowingMode,
  TranscriptSegment,
  VideoMaterial,
  WordToken,
} from './types';
import {
  deletePracticeReport,
  exportAllStudyDataJson,
  exportVocabularyToCsv,
  getCachedDictionaryLookup,
  loadCustomVideos,
  loadPracticeHistory,
  loadSavedVocabulary,
  removeVocabularyItem,
  saveCustomVideo,
  savePracticeReport,
  saveVocabularyItem,
  setCachedDictionaryLookup,
} from './services/storage';
import { YouTubePlayer, YouTubePlayerHandle } from './components/YouTubePlayer';
import { TranscriptReader } from './components/TranscriptReader';
import { DictionaryPopover } from './components/DictionaryPopover';
import { ShadowingStudio } from './components/ShadowingStudio';
import { PerformanceReport } from './components/PerformanceReport';
import {
  SessionHistoryView,
  VocabularyVaultView,
} from './components/VocabularyAndHistoryViews';

type ActiveTab = 'studio' | 'vocabulary' | 'history';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('studio');

  // Video & Transcript State — Starts empty with no default content or Quick Switch list
  const [customVideos, setCustomVideos] = useState<VideoMaterial[]>(() =>
    loadCustomVideos()
  );
  const [currentVideo, setCurrentVideo] = useState<VideoMaterial | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [preferredFetchLang, setPreferredFetchLang] =
    useState<LanguageCode>('ja');
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [transcriptProgressMsg, setTranscriptProgressMsg] = useState<
    string | null
  >(null);
  const [transcriptProgressPct, setTranscriptProgressPct] = useState<number>(0);
  const [urlError, setUrlError] = useState<string | null>(null);

  // Playback & Sync State
  const playerHandleRef = useRef<YouTubePlayerHandle | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<string[]>([]);
  const [loopSegment, setLoopSegment] = useState<{
    id: string;
    startTime: number;
    endTime: number;
  } | null>(null);
  const [autoPauseAtSec, setAutoPauseAtSec] = useState<number | null>(null);
  const [autoPauseTriggerCount, setAutoPauseTriggerCount] = useState(0);

  // Transcript Reader Preferences
  const [showFurigana, setShowFurigana] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);

  // Floating Dictionary Lookup State
  const [selectedWord, setSelectedWord] = useState<string | null>(null);
  const [selectedWordSentence, setSelectedWordSentence] = useState<string>('');
  const [selectedWordTimestamp, setSelectedWordTimestamp] = useState<number>(0);
  const [dictAnchorRect, setDictAnchorRect] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [dictionaryResult, setDictionaryResult] =
    useState<DictionaryLookupResult | null>(null);
  const [isLoadingDict, setIsLoadingDict] = useState(false);
  const [dictError, setDictError] = useState<string | null>(null);

  // Shadowing & Assessment State
  const [shadowingMode, setShadowingMode] =
    useState<ShadowingMode>('listen_repeat');
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [latestReport, setLatestReport] =
    useState<ShadowingAssessmentReport | null>(null);
  const [activeDiffMap, setActiveDiffMap] = useState<
    Record<string, DiffToken[]>
  >({});
  const [activeDiffSegmentIds, setActiveDiffSegmentIds] = useState<string[]>(
    []
  );

  // Persistent User Data
  const [savedVocabulary, setSavedVocabulary] = useState<SavedVocabularyItem[]>(
    () => loadSavedVocabulary()
  );
  const [practiceHistory, setPracticeHistory] = useState<
    ShadowingAssessmentReport[]
  >(() => loadPracticeHistory());

  // System Shutdown State
  const [showShutdownConfirm, setShowShutdownConfirm] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [isShutDownComplete, setIsShutDownComplete] = useState(false);

  const reportSectionRef = useRef<HTMLDivElement | null>(null);

  const handleShutdown = async () => {
    setIsShuttingDown(true);
    try {
      await fetch('/api/system/shutdown', { method: 'POST' });
    } catch (e) {
      console.log('Shutdown request dispatched:', e);
    }
    setIsShuttingDown(false);
    setShowShutdownConfirm(false);
    setIsShutDownComplete(true);
  };

  // Synchronize activeSegmentIndex with currentTime
  useEffect(() => {
    if (!currentVideo) return;
    const segs = currentVideo.segments;
    if (!segs || segs.length === 0) return;

    const foundIdx = segs.findIndex(
      (s, idx) =>
        currentTime >= s.startTime - 0.15 &&
        (currentTime < s.endTime || idx === segs.length - 1)
    );

    if (foundIdx !== -1 && foundIdx !== activeSegmentIndex) {
      setActiveSegmentIndex(foundIdx);
    }
  }, [currentTime, currentVideo]);

  const handleLoadVideoMaterial = (video: VideoMaterial) => {
    setCurrentVideo(video);
    setCurrentTime(0);
    setActiveSegmentIndex(0);
    setLoopSegment(null);
    setAutoPauseAtSec(null);
    setSelectedSegmentIds(
      shadowingMode === 'simultaneous'
        ? video.segments.map((s) => s.id)
        : video.segments.length > 0
        ? [video.segments[0].id]
        : []
    );
    setSelectedWord(null);
    setDictionaryResult(null);
    setLatestReport(null);
    setActiveDiffMap({});
    setActiveDiffSegmentIds([]);
    setUrlError(null);
    setActiveTab('studio');
  };

  const handleModeChange = (nextMode: ShadowingMode) => {
    setShadowingMode(nextMode);
    setAutoPauseAtSec(null);
    if (nextMode === 'simultaneous') {
      setLoopSegment(null);
      if (currentVideo && currentVideo.segments.length > 0) {
        setSelectedSegmentIds(currentVideo.segments.map((s) => s.id));
      }
    } else if (currentVideo && currentVideo.segments.length > 0) {
      const currentSeg =
        currentVideo.segments[activeSegmentIndex] || currentVideo.segments[0];
      setSelectedSegmentIds([currentSeg.id]);
    }
  };

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setUrlError(null);

    const extractedId = extractYouTubeId(urlInput);
    if (!extractedId) {
      setUrlError(
        'Please enter a valid YouTube video URL (e.g., https://www.youtube.com/watch?v=...) or 11-character video ID.'
      );
      return;
    }

    setIsLoadingTranscript(true);
    setTranscriptProgressMsg('Fetching YouTube video metadata & audio timeline...');
    setTranscriptProgressPct(8);

    try {
      const response = await fetch('/api/transcript/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urlOrId: extractedId,
          preferredLanguage: preferredFetchLang,
          stream: true,
        }),
      });

      if (!response.ok) {
        let errText = 'Could not generate video transcript.';
        try {
          const errJson = await response.json();
          if (errJson?.error) errText = errJson.error;
        } catch {
          // Ignore
        }
        throw new Error(errText);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/x-ndjson') && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamMeta = {
          videoId: extractedId,
          title: `YouTube Video (${extractedId})`,
          channel: 'YouTube Creator',
          durationSec: 180,
          language: preferredFetchLang,
        };
        let hasInitializedPreview = false;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const rawLine of lines) {
            const trimmed = rawLine.trim();
            if (!trimmed) continue;
            let event: any;
            try {
              event = JSON.parse(trimmed);
            } catch {
              continue;
            }

            if (event.type === 'meta') {
              streamMeta = {
                videoId: event.videoId || extractedId,
                title: event.title || streamMeta.title,
                channel: event.channel || streamMeta.channel,
                durationSec: event.durationSec || 180,
                language: event.language || preferredFetchLang,
              };
            } else if (event.type === 'progress') {
              setTranscriptProgressMsg(event.message || 'Transcribing video...');
              const pct =
                event.totalChunks > 0
                  ? Math.round(
                      12 + (event.completedChunks / event.totalChunks) * 80
                    )
                  : 20;
              setTranscriptProgressPct(pct);
            } else if (event.type === 'partial_segments') {
              const pct =
                event.totalChunks > 0
                  ? Math.round(
                      15 + (event.completedChunks / event.totalChunks) * 82
                    )
                  : 50;
              setTranscriptProgressPct(pct);
              setTranscriptProgressMsg(event.message || 'Generating segments...');

              const partialSegments: TranscriptSegment[] = event.segments || [];
              if (partialSegments.length > 0) {
                const progressiveVideo: VideoMaterial = {
                  videoId: streamMeta.videoId,
                  title: streamMeta.title,
                  channel: streamMeta.channel,
                  language: event.language || streamMeta.language,
                  level: event.level || 'Intermediate',
                  durationSec: streamMeta.durationSec,
                  captionSource: 'ai_generated',
                  captionNote:
                    event.message ||
                    `Transcribing complete video (${partialSegments.length} segments ready so far)...`,
                  segments: partialSegments,
                };

                if (!hasInitializedPreview) {
                  hasInitializedPreview = true;
                  handleLoadVideoMaterial(progressiveVideo);
                } else {
                  setCurrentVideo(progressiveVideo);
                  if (shadowingMode === 'simultaneous') {
                    setSelectedSegmentIds(partialSegments.map((s) => s.id));
                  }
                }
              }
            } else if (event.type === 'complete' && event.video) {
              setTranscriptProgressPct(100);
              const updatedCustom = saveCustomVideo(event.video);
              setCustomVideos(updatedCustom);
              if (!hasInitializedPreview) {
                handleLoadVideoMaterial(event.video);
              } else {
                setCurrentVideo(event.video);
                if (shadowingMode === 'simultaneous') {
                  setSelectedSegmentIds(
                    event.video.segments.map((s: TranscriptSegment) => s.id)
                  );
                }
              }
              setUrlInput('');
            } else if (event.type === 'error') {
              throw new Error(
                event.error || 'Failed to generate complete transcript.'
              );
            }
          }
        }
      } else {
        const data = await response.json();
        if (!data.video) {
          throw new Error(data.error || 'Could not generate video transcript.');
        }
        const updatedCustom = saveCustomVideo(data.video);
        setCustomVideos(updatedCustom);
        handleLoadVideoMaterial(data.video);
        setUrlInput('');
      }
    } catch (err: any) {
      setUrlError(
        err?.message || 'Failed to generate transcript from YouTube video.'
      );
    } finally {
      setIsLoadingTranscript(false);
      setTranscriptProgressMsg(null);
      setTranscriptProgressPct(0);
    }
  };

  // Inline Transcript Editing Handlers
  const handleUpdateSegment = (updatedSegment: TranscriptSegment) => {
    if (!currentVideo) return;
    const newSegments = currentVideo.segments.map((seg) =>
      seg.id === updatedSegment.id ? updatedSegment : seg
    );
    const updatedVideo: VideoMaterial = {
      ...currentVideo,
      segments: newSegments,
      captionNote:
        'Transcript edited inline — Furigana and timestamps are synchronized.',
    };
    setCurrentVideo(updatedVideo);
    const updatedCustom = saveCustomVideo(updatedVideo);
    setCustomVideos(updatedCustom);
  };

  const handleAddSegmentAfter = (index: number) => {
    if (!currentVideo) return;
    const refSeg = currentVideo.segments[index];
    const startTime = refSeg ? refSeg.endTime : 0;
    const endTime = startTime + 5;
    const newSeg: TranscriptSegment = {
      id: `seg-${currentVideo.videoId}-${Date.now()}`,
      index: index + 1,
      startTime,
      endTime,
      text:
        currentVideo.language === 'ja'
          ? '新しい文をここに入力してください。'
          : 'Enter your new transcript line here.',
      tokens: [],
    };
    const nextSegments = [
      ...currentVideo.segments.slice(0, index + 1),
      newSeg,
      ...currentVideo.segments.slice(index + 1),
    ].map((s, idx) => ({ ...s, index: idx }));

    const updatedVideo: VideoMaterial = {
      ...currentVideo,
      segments: nextSegments,
    };
    setCurrentVideo(updatedVideo);
    setCustomVideos(saveCustomVideo(updatedVideo));
  };

  const handleDeleteSegment = (segmentId: string) => {
    if (!currentVideo || currentVideo.segments.length <= 1) return;
    const nextSegments = currentVideo.segments
      .filter((s) => s.id !== segmentId)
      .map((s, idx) => ({ ...s, index: idx }));
    const updatedVideo: VideoMaterial = {
      ...currentVideo,
      segments: nextSegments,
    };
    setCurrentVideo(updatedVideo);
    setSelectedSegmentIds((prev) => {
      const remaining = prev.filter((id) => id !== segmentId);
      return remaining.length > 0 ? remaining : [nextSegments[0].id];
    });
    setCustomVideos(saveCustomVideo(updatedVideo));
  };

  const handleSelectSegmentToSeek = (segment: TranscriptSegment) => {
    setActiveSegmentIndex(segment.index);
    setCurrentTime(segment.startTime);
    setAutoPauseAtSec(null);
    if (shadowingMode === 'listen_repeat' && selectedSegmentIds.length <= 1) {
      setSelectedSegmentIds([segment.id]);
    }
    playerHandleRef.current?.seekTo(segment.startTime, true);
    playerHandleRef.current?.play();
  };

  const handlePrevSegment = () => {
    if (!currentVideo) return;
    const nextIdx = Math.max(0, activeSegmentIndex - 1);
    const seg = currentVideo.segments[nextIdx];
    if (seg) handleSelectSegmentToSeek(seg);
  };

  const handleNextSegment = () => {
    if (!currentVideo) return;
    const nextIdx = Math.min(
      currentVideo.segments.length - 1,
      activeSegmentIndex + 1
    );
    const seg = currentVideo.segments[nextIdx];
    if (seg) handleSelectSegmentToSeek(seg);
  };

  const handleToggleLoopSegment = (segment?: TranscriptSegment) => {
    if (!currentVideo) return;
    const target = segment || currentVideo.segments[activeSegmentIndex];
    if (!target) return;
    if (loopSegment && loopSegment.id === target.id) {
      setLoopSegment(null);
    } else {
      setLoopSegment({
        id: target.id,
        startTime: target.startTime,
        endTime: target.endTime,
      });
      playerHandleRef.current?.seekTo(target.startTime, true);
      playerHandleRef.current?.play();
    }
  };

  const handleToggleSegmentSelection = (segmentId: string) => {
    setSelectedSegmentIds((prev) => {
      if (prev.includes(segmentId)) {
        return prev.length > 1 ? prev.filter((id) => id !== segmentId) : prev;
      }
      return [...prev, segmentId];
    });
  };

  const handleSelectAllSegments = () => {
    if (!currentVideo) return;
    if (selectedSegmentIds.length === currentVideo.segments.length) {
      const currentSeg =
        currentVideo.segments[activeSegmentIndex] || currentVideo.segments[0];
      setSelectedSegmentIds(currentSeg ? [currentSeg.id] : []);
    } else {
      setSelectedSegmentIds(currentVideo.segments.map((s) => s.id));
    }
  };

  const handleStartShadowingSegment = (segment: TranscriptSegment) => {
    setActiveSegmentIndex(segment.index);
    setSelectedSegmentIds([segment.id]);
    setShadowingMode('listen_repeat');
    setAutoPauseAtSec(segment.endTime);
    playerHandleRef.current?.seekTo(segment.startTime, true);
    playerHandleRef.current?.play();
  };

  const handleWordClick = async (
    word: string,
    sentence: string,
    segment: TranscriptSegment,
    anchorRect: { x: number; y: number },
    _token?: WordToken
  ) => {
    if (!currentVideo) return;
    const cleanWord =
      word.replace(/[.,!?;:"'()「」『』、。！？—-]+/g, '').trim() ||
      word.trim();
    if (!cleanWord) return;

    setSelectedWord(cleanWord);
    setSelectedWordSentence(sentence);
    setSelectedWordTimestamp(segment.startTime);
    setDictAnchorRect(anchorRect);
    setDictError(null);

    const cacheKey = `${currentVideo.language}:${cleanWord}:${sentence.slice(
      0,
      32
    )}`;
    const cached = getCachedDictionaryLookup(cacheKey);
    if (cached) {
      setDictionaryResult(cached);
      return;
    }

    setDictionaryResult(null);
    setIsLoadingDict(true);

    try {
      const response = await fetch('/api/dictionary/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          word: cleanWord,
          sentence,
          language: currentVideo.language,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Could not look up word.');
      }
      setDictionaryResult(data);
      setCachedDictionaryLookup(cacheKey, data);
    } catch (err: any) {
      setDictError(err?.message || 'Dictionary lookup failed.');
    } finally {
      setIsLoadingDict(false);
    }
  };

  const handleSaveVocabularyWord = (entry: DictionaryLookupResult) => {
    if (!currentVideo) return;
    const newItem: SavedVocabularyItem = {
      id: `vocab-${Date.now()}`,
      word: entry.word,
      lemma: entry.lemma || entry.word,
      language: currentVideo.language,
      reading: entry.reading,
      romaji: entry.romaji,
      ipa: entry.ipa,
      pitchAccent: entry.pitchAccent,
      partOfSpeech: entry.partOfSpeech,
      contextualMeaning: entry.contextualMeaning,
      dictionaryDefinitions: entry.dictionaryDefinitions || [],
      sourceSentence: selectedWordSentence,
      videoId: currentVideo.videoId,
      videoTitle: currentVideo.title,
      timestampSec: selectedWordTimestamp,
      createdAt: new Date().toISOString(),
    };
    const updated = saveVocabularyItem(newItem);
    setSavedVocabulary(updated);
  };

  const handleEvaluateShadowing = async (payload: {
    audioBase64?: string;
    mimeType?: string;
    audioDataUrl?: string;
    webSpeechTranscript: string;
    durationSec: number;
    targetDurationSec: number;
    targetText: string;
    segmentIds: string[];
  }) => {
    if (!currentVideo) return;
    setIsEvaluating(true);
    setEvaluationError(null);

    try {
      const response = await fetch('/api/shadowing/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: payload.audioBase64,
          mimeType: payload.mimeType,
          targetText: payload.targetText,
          language: currentVideo.language,
          mode: shadowingMode,
          webSpeechTranscript: payload.webSpeechTranscript,
          durationSec: payload.durationSec,
          targetDurationSec: payload.targetDurationSec,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Evaluation request failed.');
      }

      const wordDiff: DiffToken[] = data.wordDiff || [];
      const omittedCount = wordDiff.filter((t) => t.status === 'omitted').length;
      const substitutedCount = wordDiff.filter(
        (t) => t.status === 'substituted'
      ).length;
      const uncertainSttCount = wordDiff.filter(
        (t) => t.status === 'stt_uncertain'
      ).length;

      const report: ShadowingAssessmentReport = {
        id: `rep-${Date.now()}`,
        videoId: currentVideo.videoId,
        videoTitle: currentVideo.title,
        language: currentVideo.language,
        segmentIds: payload.segmentIds,
        mode: shadowingMode,
        createdAt: new Date().toISOString(),
        targetText: payload.targetText,
        recognizedTranscript:
          data.recognizedTranscript || payload.webSpeechTranscript || '',
        webSpeechTranscript: payload.webSpeechTranscript,
        overallScore: Number(data.overallScore) || 0,
        dimensions: {
          contentAccuracy: Number(data.dimensions?.contentAccuracy) || 0,
          pronunciation: Number(data.dimensions?.pronunciation) || 0,
          fluency: Number(data.dimensions?.fluency) || 0,
          prosody: Number(data.dimensions?.prosody) || 0,
        },
        metrics: {
          speechRateValue: Number(data.speechRateValue) || 120,
          speechRateUnit:
            currentVideo.language === 'ja' ? 'Moras/min' : 'WPM',
          targetRateValue: Number(data.targetRateValue) || 135,
          durationSec: payload.durationSec,
          targetDurationSec: payload.targetDurationSec,
          omittedCount,
          substitutedCount,
          uncertainSttCount,
        },
        scoreExplanation:
          data.scoreExplanation ||
          'Evaluated across lexical accuracy, phonetic clarity, speech pacing, and prosodic rhythm.',
        wordDiff,
        pronunciationFeedback: data.pronunciationFeedback || [],
        improvementSuggestions: data.improvementSuggestions || [],
        recommendedRetryText: data.recommendedRetryText,
        audioDataUrl: payload.audioDataUrl,
      };

      setLatestReport(report);
      setActiveDiffMap({ latest: wordDiff });
      setActiveDiffSegmentIds(payload.segmentIds);

      const updatedHistory = savePracticeReport(report);
      setPracticeHistory(updatedHistory);

      setTimeout(() => {
        reportSectionRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }, 120);
    } catch (err: any) {
      setEvaluationError(
        err?.message || 'Failed to evaluate shadowing session.'
      );
    } finally {
      setIsEvaluating(false);
    }
  };

  const activeSegment = currentVideo
    ? currentVideo.segments[activeSegmentIndex] || currentVideo.segments[0]
    : null;

  const targetPracticeSegments = currentVideo
    ? currentVideo.segments.filter((s) => selectedSegmentIds.includes(s.id))
    : [];

  const isCurrentWordSaved = Boolean(
    currentVideo &&
      dictionaryResult &&
      savedVocabulary.some(
        (v) =>
          v.word.toLowerCase() === dictionaryResult.word.toLowerCase() &&
          v.language === currentVideo.language
      )
  );

  if (isShutDownComplete) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900 text-white p-6">
        <div className="max-w-md w-full bg-slate-800 border border-slate-700 rounded-2xl p-8 text-center shadow-2xl">
          <div className="w-16 h-16 bg-emerald-500/10 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-5 border border-emerald-500/20">
            <Power className="w-8 h-8" />
          </div>
          <h1 className="text-xl font-bold mb-2 font-display">Echo Has Shut Down</h1>
          <p className="text-sm text-slate-300 mb-6 leading-relaxed">
            All local AI servers (Qwen3.5 LLM, Whisper STT, Google ADK Backend) have been safely stopped and system RAM (~9.5 GB) has been released.
          </p>
          <div className="p-3 bg-slate-900/60 rounded-xl text-xs text-slate-400 mb-6 border border-slate-700/50">
            To start Echo again, run <code className="text-emerald-400 font-mono">./scripts/start.sh</code> in your terminal.
          </div>
          <p className="text-xs text-slate-400">You can now safely close this browser tab.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]">
      {/* Strict 3-Zone Top Navigation Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 bg-white border-b border-slate-200 sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#studio"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('studio');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 font-display"
        >
          Echo Language Learning
        </a>

        {/* Zone 2: Clean single-line text navigation links */}
        <nav className="flex items-center gap-6 text-sm font-medium text-slate-600 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('studio')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer pb-0.5 border-b-2 ${
              activeTab === 'studio'
                ? 'text-slate-900 border-sky-600 font-semibold'
                : 'border-transparent'
            }`}
          >
            Practice Studio
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('vocabulary')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer pb-0.5 border-b-2 ${
              activeTab === 'vocabulary'
                ? 'text-slate-900 border-sky-600 font-semibold'
                : 'border-transparent'
            }`}
          >
            Vocabulary Vault ({savedVocabulary.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer pb-0.5 border-b-2 ${
              activeTab === 'history'
                ? 'text-slate-900 border-sky-600 font-semibold'
                : 'border-transparent'
            }`}
          >
            Session History ({practiceHistory.length})
          </button>
        </nav>

        {/* Zone 3: Actions */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() =>
              exportAllStudyDataJson(savedVocabulary, practiceHistory)
            }
            className="px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Export Study Data
          </button>
          <button
            type="button"
            onClick={() => setShowShutdownConfirm(true)}
            title="Shut Down Local AI Servers and Release RAM"
            className="px-3 py-1.5 text-xs font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1.5"
          >
            <Power className="w-3.5 h-3.5 text-rose-600" />
            Shut Down
          </button>
        </div>
      </header>

      {/* Shutdown Confirmation Modal */}
      {showShutdownConfirm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl border border-slate-200 text-center animate-in fade-in zoom-in-95 duration-150">
            <div className="w-12 h-12 bg-rose-50 text-rose-600 rounded-full flex items-center justify-center mx-auto mb-4 border border-rose-100">
              <Power className="w-6 h-6" />
            </div>
            <h3 className="text-base font-bold text-slate-900 mb-2">Shut Down Echo?</h3>
            <p className="text-xs text-slate-600 mb-6 leading-relaxed">
              This will safely stop all local AI servers (Qwen3.5 LLM, Whisper STT, Google ADK Backend) and release ~9.5 GB of system RAM.
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={isShuttingDown}
                onClick={() => setShowShutdownConfirm(false)}
                className="flex-1 px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isShuttingDown}
                onClick={handleShutdown}
                className="flex-1 px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-2"
              >
                {isShuttingDown ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Stopping...
                  </>
                ) : (
                  'Shut Down'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Non-blocking Floating Dictionary Window */}
      <DictionaryPopover
        lookupResult={dictionaryResult}
        isLoading={isLoadingDict}
        error={dictError}
        selectedWord={selectedWord}
        anchorRect={dictAnchorRect}
        isSaved={isCurrentWordSaved}
        onClose={() => {
          setSelectedWord(null);
          setDictionaryResult(null);
        }}
        onSaveWord={handleSaveVocabularyWord}
      />

      {/* Main Content Container (1440px Desktop Baseline) */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6">
        {activeTab === 'studio' && (
          <div className="space-y-6">
            {/* Top Workspace Bar: Automatic YouTube URL Transcript Generation */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <form
                onSubmit={handleUrlSubmit}
                className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5"
              >
                <div className="relative flex-1">
                  <Video className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="Paste any English or Japanese YouTube URL (e.g., https://www.youtube.com/watch?v=...) to auto-generate its full transcript"
                    className="w-full pl-10 pr-3 py-2.5 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:bg-white focus:border-sky-600"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setPreferredFetchLang('en')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        preferredFetchLang === 'en'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      English (EN)
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreferredFetchLang('ja')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        preferredFetchLang === 'ja'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      日本語 (JA)
                    </button>
                  </div>

                  <button
                    type="submit"
                    disabled={isLoadingTranscript}
                    className="flex items-center gap-1.5 px-4 py-2.5 bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    {isLoadingTranscript ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Generating Complete Transcript...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Auto-Generate Transcript</span>
                      </>
                    )}
                  </button>
                </div>
              </form>

              {/* Live Streaming Progress Bar During Full-Video Transcript Generation */}
              {isLoadingTranscript && transcriptProgressMsg && (
                <div className="pt-1 space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-slate-600">
                    <span className="flex items-center gap-2 font-medium text-sky-900">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-600 shrink-0" />
                      <span>{transcriptProgressMsg}</span>
                    </span>
                    <span className="font-mono-tabular font-semibold text-sky-700">
                      {transcriptProgressPct}%
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-sky-600 transition-all duration-300"
                      style={{ width: `${Math.max(5, transcriptProgressPct)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {urlError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl flex items-center gap-2 text-xs text-red-800">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
                <span>{urlError}</span>
              </div>
            )}

            {!currentVideo ? (
              /* Clean Empty State before user enters a YouTube URL */
              <div className="bg-white border border-slate-200 rounded-xl p-12 text-center max-w-2xl mx-auto my-8 space-y-4">
                <div className="w-12 h-12 rounded-xl bg-sky-50 border border-sky-100 text-sky-600 flex items-center justify-center mx-auto">
                  <Video className="w-6 h-6" />
                </div>
                <div className="space-y-1.5">
                  <h1 className="text-xl font-bold text-slate-900">
                    Enter a YouTube Video URL to Start Shadowing
                  </h1>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    Paste any English or Japanese YouTube video link above and
                    click{' '}
                    <strong className="text-slate-900">
                      Auto-Generate Transcript
                    </strong>
                    . Echo Language Learning will automatically generate the
                    complete synchronized transcript from start to finish,
                    annotate Japanese Kanji with Furigana, and prepare the AI
                    shadowing studio.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 text-left text-xs text-slate-600">
                  <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-lg space-y-1">
                    <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                      <BookOpen className="w-3.5 h-3.5 text-sky-600" />
                      <span>1. Full Sync &amp; Inline Edit</span>
                    </div>
                    <p>
                      Read synchronized transcripts with Japanese Furigana and
                      edit any line directly in the reader.
                    </p>
                  </div>
                  <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-lg space-y-1">
                    <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-sky-600" />
                      <span>2. Floating Dictionary</span>
                    </div>
                    <p>
                      Click any unfamiliar word to open a floating contextual
                      dictionary without interrupting playback.
                    </p>
                  </div>
                  <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-lg space-y-1">
                    <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                      <Mic className="w-3.5 h-3.5 text-sky-600" />
                      <span>3. AI Speech Coaching</span>
                    </div>
                    <p>
                      Practice in Listen-Then-Repeat or Simultaneous mode and
                      receive 4-pillar pronunciation feedback.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* Video Metadata & Transcript Accuracy Notice (Unboxed Zero-Pill Metadata) */}
                <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900 text-sm">
                      {currentVideo.title}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{currentVideo.channel}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {currentVideo.language === 'ja'
                        ? 'Japanese (日本語)'
                        : 'English (EN)'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{currentVideo.level}</span>
                  </div>
                  <div className="text-slate-500">
                    <span>{currentVideo.captionNote}</span>
                  </div>
                </div>

                {/* Two-Zone Sandbox Layout: Left (60% / 7 cols) Stage + Right (40% / 5 cols) Transcript Reader */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                  {/* LEFT ZONE: Video Player Stage + AI Shadowing Practice Studio */}
                  <div className="lg:col-span-7 space-y-5">
                    <YouTubePlayer
                      videoId={currentVideo.videoId}
                      currentTime={currentTime}
                      isPlaying={isPlaying}
                      playbackRate={playbackRate}
                      loopSegment={loopSegment}
                      autoPauseAtSec={autoPauseAtSec}
                      onTimeUpdate={setCurrentTime}
                      onPlayStateChange={setIsPlaying}
                      onPlaybackRateChange={setPlaybackRate}
                      onToggleLoopSegment={() => handleToggleLoopSegment()}
                      onPrevSegment={handlePrevSegment}
                      onNextSegment={handleNextSegment}
                      onAutoPauseReached={() => {
                        setAutoPauseAtSec(null);
                        setAutoPauseTriggerCount((c) => c + 1);
                      }}
                      playerRefOut={playerHandleRef}
                    />

                    {activeSegment && (
                      <ShadowingStudio
                        language={currentVideo.language}
                        mode={shadowingMode}
                        allSegments={currentVideo.segments}
                        targetSegments={targetPracticeSegments}
                        activeSegment={activeSegment}
                        isEvaluating={isEvaluating}
                        playerHandleRef={playerHandleRef}
                        onModeChange={handleModeChange}
                        onSetAutoPauseAtSec={setAutoPauseAtSec}
                        onClearLoopSegment={() => setLoopSegment(null)}
                        onSubmitEvaluation={handleEvaluateShadowing}
                        autoPauseTriggerCount={autoPauseTriggerCount}
                      />
                    )}

                    {evaluationError && (
                      <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700">
                        {evaluationError}
                      </div>
                    )}
                  </div>

                  {/* RIGHT ZONE: Synchronized Interactive Transcript Reader with Direct Inline Editing */}
                  <div className="lg:col-span-5">
                    <TranscriptReader
                      language={currentVideo.language}
                      segments={currentVideo.segments}
                      activeSegmentIndex={activeSegmentIndex}
                      selectedSegmentIds={selectedSegmentIds}
                      loopSegmentId={loopSegment?.id || null}
                      showFurigana={showFurigana}
                      autoScroll={autoScroll}
                      activeDiffMap={activeDiffMap}
                      activeDiffSegmentIds={activeDiffSegmentIds}
                      onSelectSegmentToSeek={handleSelectSegmentToSeek}
                      onToggleSegmentSelection={handleToggleSegmentSelection}
                      onSelectAllSegments={handleSelectAllSegments}
                      onToggleLoopSegment={handleToggleLoopSegment}
                      onStartShadowingSegment={handleStartShadowingSegment}
                      onWordClick={handleWordClick}
                      onToggleFurigana={() => setShowFurigana((v) => !v)}
                      onToggleAutoScroll={() => setAutoScroll((v) => !v)}
                      onUpdateSegment={handleUpdateSegment}
                      onAddSegmentAfter={handleAddSegmentAfter}
                      onDeleteSegment={handleDeleteSegment}
                    />
                  </div>
                </div>

                {/* Full-Width Diagnostic Performance Report Section */}
                {latestReport && (
                  <div ref={reportSectionRef} className="pt-2">
                    <PerformanceReport
                      report={latestReport}
                      onReplayOriginalSegment={() => {
                        const firstSeg =
                          currentVideo.segments.find((s) =>
                            latestReport.segmentIds.includes(s.id)
                          ) || activeSegment;
                        if (firstSeg) {
                          handleSelectSegmentToSeek(firstSeg);
                        }
                      }}
                      onRetryPractice={() => {
                        const firstSeg =
                          currentVideo.segments.find((s) =>
                            latestReport.segmentIds.includes(s.id)
                          ) || activeSegment;
                        if (firstSeg) {
                          handleStartShadowingSegment(firstSeg);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }
                      }}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Vocabulary Vault Tab */}
        {activeTab === 'vocabulary' && (
          <VocabularyVaultView
            items={savedVocabulary}
            onRemoveItem={(id) => setSavedVocabulary(removeVocabularyItem(id))}
            onExportCsv={() => exportVocabularyToCsv(savedVocabulary)}
            onJumpToVideoSegment={(videoId, timestampSec) => {
              const targetVid = customVideos.find((v) => v.videoId === videoId);
              if (targetVid) {
                handleLoadVideoMaterial(targetVid);
                setTimeout(() => {
                  playerHandleRef.current?.seekTo(timestampSec, true);
                  playerHandleRef.current?.play();
                }, 300);
              }
            }}
          />
        )}

        {/* Session History Tab */}
        {activeTab === 'history' && (
          <SessionHistoryView
            reports={practiceHistory}
            onDeleteReport={(id) =>
              setPracticeHistory(deletePracticeReport(id))
            }
            onSelectReportForReview={(rep) => {
              const targetVid = customVideos.find(
                (v) => v.videoId === rep.videoId
              );
              if (targetVid) {
                setCurrentVideo(targetVid);
              }
              setLatestReport(rep);
              setActiveDiffMap({ latest: rep.wordDiff });
              setActiveDiffSegmentIds(rep.segmentIds);
              setActiveTab('studio');
              setTimeout(() => {
                reportSectionRef.current?.scrollIntoView({
                  behavior: 'smooth',
                  block: 'start',
                });
              }, 150);
            }}
          />
        )}
      </main>

      {/* Quiet Footer */}
      <footer className="mt-12 border-t border-slate-200 bg-white px-6 py-4 text-xs text-slate-500">
        <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-4">
          <span>
            Echo Language Learning — English &amp; Japanese YouTube Shadowing
            Studio
          </span>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => exportVocabularyToCsv(savedVocabulary)}
              className="hover:text-slate-900 underline cursor-pointer"
            >
              Export Vocabulary CSV
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() =>
                exportAllStudyDataJson(savedVocabulary, practiceHistory)
              }
              className="hover:text-slate-900 underline cursor-pointer"
            >
              Backup JSON
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
