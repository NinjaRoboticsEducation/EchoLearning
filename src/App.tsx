import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AudioLines,
  Loader2,
  Power,
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
  previewStudyBackup,
  restoreStudyBackup,
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

type ActiveTab = 'home' | 'studio' | 'vocabulary' | 'history' | 'settings';

const navigation = {
  studio: ['Practice Studio', '練習スタジオ', '練習室', '练习室'],
  vocabulary: ['Vocabulary', '単語帳', '詞彙', '词汇'],
  history: ['History', '履歴', '歷史紀錄', '历史记录'],
  settings: ['Settings', '設定', '設定', '设置'],
} as const;

const locales = ['en', 'ja', 'zh-Hant', 'zh-Hans'] as const;
const localeLabels = ['English', '日本語', '繁體中文', '简体中文'];

function tabFromHash(): ActiveTab {
  const hash = window.location.hash.slice(1);
  return hash === 'studio' || hash === 'vocabulary' || hash === 'history' || hash === 'settings'
    ? hash : 'home';
}

export default function App() {
  const [storageError, setStorageError] = useState<string | null>(null);
  const [backup, setBackup] = useState<Awaited<ReturnType<typeof previewStudyBackup>> | null>(null);
  const [backupStatus, setBackupStatus] = useState('');
  const [backupError, setBackupError] = useState('');
  const backupGeneration = useRef(0);

  const [activeTab, setTab] = useState<ActiveTab>(tabFromHash);
  const [locale, setLocale] = useState<string>(() => {
    try {
      return locales.find((value) => value === localStorage.getItem('echo_ui_locale')) ?? 'en';
    } catch {
      return 'en';
    }
  });
  const localeIndex = Math.max(0, locales.findIndex((value) => value === locale));
  const setActiveTab = (tab: ActiveTab) => {
    window.location.hash = tab;
    setTab(tab);
  };
  useEffect(() => {
    const sync = () => setTab(tabFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    try { localStorage.setItem('echo_ui_locale', locale); } catch { /* Session choice still applies. */ }
  }, [locale]);

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

  const reportSectionRef = useRef<HTMLDivElement | null>(null);

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
        let completed = false;

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
            } else if (event.type === 'partial_segments') {
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
              completed = true;
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
        if (!completed) throw new Error('The transcript stream ended before completion. Try again.');
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
    }
  };

  function persistTranscript(video: VideoMaterial): boolean {
    try {
      setCustomVideos(saveCustomVideo(video));
      setCurrentVideo(video);
      setStorageError(null);
      return true;
    } catch {
      setStorageError('The transcript change could not be saved. Check browser storage space and try again.');
      return false;
    }
  }

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
    persistTranscript(updatedVideo);
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
    persistTranscript(updatedVideo);
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
    if (!persistTranscript(updatedVideo)) return;
    setSelectedSegmentIds((prev) => {
      const remaining = prev.filter((id) => id !== segmentId);
      return remaining.length > 0 ? remaining : [nextSegments[0].id];
    });
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

  const handleAdvanceToNextSegment = (): TranscriptSegment | null => {
    if (!currentVideo || currentVideo.segments.length === 0) return null;
    const nextIndex = activeSegmentIndex + 1;
    if (nextIndex < currentVideo.segments.length) {
      setActiveSegmentIndex(nextIndex);
      return currentVideo.segments[nextIndex];
    }
    return null;
  };

  const handleAdvanceToSegmentIndex = (targetIndex: number): TranscriptSegment | null => {
    if (!currentVideo || currentVideo.segments.length === 0) return null;
    const clampedIndex = Math.max(0, Math.min(targetIndex, currentVideo.segments.length - 1));
    setActiveSegmentIndex(clampedIndex);
    return currentVideo.segments[clampedIndex];
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
    try {
      setSavedVocabulary(saveVocabularyItem(newItem));
      setStorageError(null);
    } catch {
      setStorageError('The word could not be saved. Check browser storage space and try again.');
    }
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
        throw new Error(typeof data.detail === 'string' ? data.detail : data.error || 'Evaluation request failed.');
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
          speechRateValue: Number(data.speechRateValue ?? 0),
          speechRateUnit:
            currentVideo.language === 'ja' ? 'Moras/min' : 'WPM',
          targetRateValue: Number(data.targetRateValue ?? 0),
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

  return (
    <div className="echo-app">
      <a className="skip-link" href="#main-content" onClick={(event) => {
        event.preventDefault();
        document.getElementById('main-content')?.focus();
      }}>Skip to content</a>
      <header className="echo-header">
        <a href="#home" className="echo-brand"><AudioLines aria-hidden="true" />EchoLearning</a>
        <nav aria-label="Main navigation">
          {Object.entries(navigation).map(([tab, labels]) => (
            <a key={tab} href={`#${tab}`} aria-current={activeTab === tab ? 'page' : undefined}>
              {labels[localeIndex]}
            </a>
          ))}
        </nav>
        <div className="echo-header-actions">
          <select aria-label="Interface language" value={locale} onChange={(event) => setLocale(event.target.value)}>
            {locales.map((value, index) => <option key={value} value={value} lang={value}>{localeLabels[index]}</option>)}
          </select>
          <button type="button" onClick={() => setShowShutdownConfirm(true)}><Power aria-hidden="true" /> Shut down</button>
        </div>
      </header>
      {showShutdownConfirm && (
        <dialog ref={(node) => { if (node && !node.open) node.showModal(); }}
          aria-labelledby="shutdown-title" onCancel={() => setShowShutdownConfirm(false)}>
          <h2 id="shutdown-title">Stop EchoLearning?</h2>
          <p>Run <code>./scripts/stop.sh</code> in the EchoLearning folder to stop the local app and its services.</p>
          <button autoFocus type="button" onClick={() => setShowShutdownConfirm(false)}>Close</button>
        </dialog>
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

      <main className="echo-main" id="main-content" tabIndex={-1}>
        {storageError && <p className="echo-error" role="alert">{storageError}</p>}
        {(activeTab === 'home' || (activeTab === 'studio' && !currentVideo && !latestReport)) && (
          <section className="echo-home">
            <h1>{['Enter a YouTube link', 'YouTube リンクを入力', '輸入 YouTube 連結', '输入 YouTube 链接'][localeIndex]}</h1>
            <p>{[
              'Choose an English or Japanese video to prepare a synchronized transcript for shadowing practice.',
              '英語または日本語の動画を選び、シャドーイング用の同期字幕を作成します。',
              '選擇英文或日文影片，建立跟讀練習用的同步逐字稿。',
              '选择英文或日文视频，生成跟读练习所需的同步字幕。',
            ][localeIndex]}</p>
            <form className="echo-panel echo-import" onSubmit={handleUrlSubmit}>
              <label htmlFor="video-url">{['YouTube link', 'YouTube リンク', 'YouTube 連結', 'YouTube 链接'][localeIndex]}</label>
              <input id="video-url" value={urlInput} onChange={(event) => setUrlInput(event.target.value)}
                placeholder="https://youtu.be/…" required disabled={isLoadingTranscript} />
              <div className="echo-choice" role="group" aria-label="Content language">
                {(['ja', 'en'] as const).map((language) => (
                  <button key={language} type="button" aria-pressed={preferredFetchLang === language}
                    disabled={isLoadingTranscript} onClick={() => setPreferredFetchLang(language)}>
                    {language === 'ja' ? '日本語コンテンツ' : 'English content'}
                  </button>
                ))}
              </div>
              {isLoadingTranscript && <div role="status" className="echo-progress"><Loader2 className="size-4 animate-spin" />{transcriptProgressMsg}</div>}
              {urlError && <p role="alert" className="echo-error">{urlError}</p>}
              <button className="echo-primary" type="submit" disabled={isLoadingTranscript}>
                {['Generate Learning Transcript', '練習用字幕を作成', '產生練習逐字稿', '生成练习字幕'][localeIndex]}
              </button>
              {customVideos.length > 0 && (
                <details>
                  <summary>Recent materials</summary>
                  <ul>{customVideos.map((video) => (
                    <li key={video.videoId}><button type="button" disabled={isLoadingTranscript}
                      onClick={() => handleLoadVideoMaterial(video)}>{video.title}</button></li>
                  ))}</ul>
                </details>
              )}
            </form>
          </section>
        )}
        {activeTab === 'studio' && !currentVideo && latestReport && (
          <section ref={reportSectionRef}>
            <p role="status" className="echo-progress">The original material is unavailable. You can still review this report.</p>
            <PerformanceReport report={latestReport} />
          </section>
        )}
        {activeTab === 'studio' && currentVideo && (
          <div className="space-y-4">
                {/* Video Metadata & Transcript Accuracy Notice (Unboxed Zero-Pill Metadata) */}
                <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="echo-video-title">{currentVideo.title}</h1>
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

                <div className="echo-studio">
                  {/* LEFT ZONE: Video Player Stage + AI Shadowing Practice Studio */}
                  <div className="echo-media space-y-2">
                    <YouTubePlayer
                      key={currentVideo.videoId}
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
                        key={currentVideo.videoId}
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
                        latestReport={latestReport}
                        onAdvanceToNextSegment={handleAdvanceToNextSegment}
                        onAdvanceToSegmentIndex={handleAdvanceToSegmentIndex}
                      />
                    )}

                    {evaluationError && (
                      <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700">
                        {evaluationError}
                      </div>
                    )}
                  </div>

                  {/* RIGHT ZONE: Synchronized Interactive Transcript Reader with Direct Inline Editing */}
                  <div className="echo-reader">
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
          </div>
        )}

        {/* Vocabulary Vault Tab */}
        {activeTab === 'vocabulary' && (
          <VocabularyVaultView
            items={savedVocabulary}
            onRemoveItem={(id) => {
              try {
                setSavedVocabulary(removeVocabularyItem(id));
                setStorageError(null);
              } catch {
                setStorageError('The word could not be removed. Try again.');
              }
            }}
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
            onDeleteReport={(id) => {
              try {
                setPracticeHistory(deletePracticeReport(id));
                setStorageError(null);
              } catch {
                setStorageError('The report could not be removed. Try again.');
              }
            }}
            onSelectReportForReview={(rep) => {
              const targetVid = customVideos.find(
                (v) => v.videoId === rep.videoId
              );
              if (targetVid) {
                handleLoadVideoMaterial(targetVid);
                setShadowingMode(rep.mode);
                const segments = targetVid.segments.filter((segment) => rep.segmentIds.includes(segment.id));
                if (segments.length > 0) {
                  setActiveSegmentIndex(segments[0].index);
                  setCurrentTime(segments[0].startTime);
                  setSelectedSegmentIds(segments.map((segment) => segment.id));
                }
              } else {
                setCurrentVideo(null);
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
        {activeTab === 'settings' && (
          <section>
            <h1 className="echo-page-title">{navigation.settings[localeIndex]}</h1>
            <div className="echo-settings">
              <section className="echo-panel">
                <h2>Study backup</h2>
                <p>Save or restore vocabulary, transcripts and report details. JSON backups exclude audio.</p>
                <button type="button" className="echo-primary" onClick={() => {
                  try {
                    exportAllStudyDataJson(savedVocabulary, practiceHistory);
                    setBackupError('');
                  } catch {
                    setBackupError('The backup could not be generated. Check your browser storage.');
                  }
                }}>Generate backup</button>
                <div className="echo-restore">
                  <label htmlFor="backup-file">Restore backup</label>
                  <input id="backup-file" type="file" accept=".json,application/json" onChange={async (event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    const generation = ++backupGeneration.current;
                    setBackup(null);
                    setBackupError('');
                    setBackupStatus('');
                    if (!file) return;
                    try {
                      const preview = await previewStudyBackup(file);
                      if (generation === backupGeneration.current) setBackup(preview);
                    } catch (error) {
                      if (generation === backupGeneration.current) {
                        setBackupError(error instanceof SyntaxError ? 'Choose a valid JSON backup.' :
                          error instanceof Error ? error.message : 'Unable to read the backup.');
                      }
                    }
                  }} />
                  {backup && (
                    <div>
                      <p>{backup.vocabulary.length} words, {backup.materials.length} materials, {backup.history.length} reports. Existing records take precedence when IDs match.</p>
                      <button className="echo-primary" type="button" onClick={() => {
                        try {
                          const restored = restoreStudyBackup(backup);
                          setSavedVocabulary(restored.vocabulary);
                          setPracticeHistory(restored.history);
                          setCustomVideos(restored.materials);
                          setBackup(null);
                          setBackupError('');
                          setBackupStatus('Backup merged into this browser.');
                        } catch {
                          setBackupError('The backup could not be saved. The existing study data is unchanged.');
                        }
                      }}>Merge backup</button>
                      <button type="button" onClick={() => { setBackup(null); setBackupError(''); }}>Cancel</button>
                    </div>
                  )}
                  {backupError && <p className="echo-error" role="alert">{backupError}</p>}
                  {backupStatus && <p role="status">{backupStatus}</p>}
                </div>
              </section>
              <section className="echo-panel">
                <h2>Private connections</h2>
                <dl><dt>Tailscale access</dt><dd>Unavailable in this build</dd><dt>MCP agents</dt><dd>Local clients can connect using <code>scripts/start_mcp.sh</code>.</dd></dl>
              </section>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
