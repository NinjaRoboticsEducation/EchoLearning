import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  FolderOpen,
  Loader2,
  Power,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import logoImg from './assets/logo.png';
import { extractYouTubeId } from './utils/youtube';
import {
  DictionaryLookupResult,
  DiffToken,
  LanguageCode,
  ModelInfo,
  SavedMaterial,
  SavedVocabularyItem,
  ShadowingAssessmentReport,
  ShadowingMode,
  SystemStatus,
  TranscriptSegment,
  VideoMaterial,
  WordToken,
} from './types';
import {
  deleteMaterialFromApi,
  deletePracticeReportApi,
  exportAllStudyDataJson,
  exportVocabularyToCsv,
  fetchHistoryFromApi,
  fetchMaterialByIdApi,
  fetchMaterialsFromApi,
  fetchVocabularyFromApi,
  getCachedDictionaryLookup,
  isDegradedDictionaryEntry,
  loadCustomVideos,
  loadPracticeHistory,
  loadSavedVocabulary,
  migrateLocalStorageToSqlite,
  previewStudyBackup,
  removeVocabularyItemApi,
  restoreStudyBackup,
  saveMaterialToApi,
  savePracticeReportApi,
  saveVocabularyItemApi,
  setCachedDictionaryLookup,
  updateMaterialSegmentApi,
} from './services/storage';
import { YouTubePlayer, YouTubePlayerHandle } from './components/YouTubePlayer';
import { TranscriptReader } from './components/TranscriptReader';
import { DictionaryPopover } from './components/DictionaryPopover';
import {
  RecognizedSpeechPreview,
  S05PreviewState,
  ShadowingStudio,
} from './components/ShadowingStudio';
import { PerformanceReport } from './components/PerformanceReport';
import {
  SessionHistoryView,
  VocabularyVaultView,
} from './components/VocabularyAndHistoryViews';

type ActiveTab = 'home' | 'studio' | 'vocabulary' | 'history' | 'settings';
type SnippetClient = 'claude' | 'codex' | 'antigravity' | 'bots';

const navigation = {
  studio: ['Practice Studio', '練習スタジオ', '練習室', '练习室'],
  vocabulary: ['Vocabulary', '単語帳', '詞彙', '词汇'],
  history: ['History', '履歴', '歷史紀錄', '历史记录'],
  settings: ['Settings', '設定', '設定', '设置'],
} as const;

const uiCopy = {
  homeTitle: [
    'Input the YouTube Link',
    'YouTube リンクを入力',
    '輸入 YouTube 連結',
    '输入 YouTube 链接',
  ],
  homeDesc: [
    'Paste any English or Japanese YouTube video link below and click Generate Learning Transcript. EchoLearning prepares synchronized transcripts, Japanese Furigana, and 100% local AI shadowing coaching.',
    '英語または日本語の YouTube 動画リンクを貼り付けて、シャドーイング用の同期字幕・振り仮名・ローカル AI 発音コーチングを作成します。',
    '貼上英文或日文 YouTube 影片連結，即可建立同步逐字稿、日文振り仮名與 100% 本地 AI 跟讀教練。',
    '粘贴英文或日文 YouTube 视频链接，即可生成同步字幕、日文假名注音与 100% 本地 AI 跟读教练。',
  ],
  urlLabel: ['YouTube link', 'YouTube リンク', 'YouTube 連結', 'YouTube 链接'],
  modelLabel: [
    'Model Selection:',
    'モデル選択:',
    '模型選擇:',
    '模型选择:',
  ],
  generateBtn: [
    'Generate Learning Transcript',
    '練習用字幕を作成',
    '產生練習逐字稿',
    '生成练习字幕',
  ],
  savedTitle: [
    'Saved Shadowing Materials (Generate Now, Practice Later)',
    '保存済み教材ライブラリ（後で練習）',
    '已儲存的跟讀教材（隨時練習）',
    '已保存的跟读教材（随时练习）',
  ],
  shutdownBtn: ['SHUT DOWN', 'シャットダウン', '關閉系統', '关闭系统'],
  shutdownTitle: [
    'Shut down EchoLearning?',
    'EchoLearning を終了しますか？',
    '確定要關閉 EchoLearning 嗎？',
    '确定要关闭 EchoLearning 吗？',
  ],
  shutdownBody: [
    'This will cleanly stop the local FastAPI backend, Qwen3.5 LLM server, and Whisper speech engine.',
    'ローカルの FastAPI、Qwen3.5 LLM、Whisper 音声認識サーバーを安全に停止します。',
    '這將會安全停止本地 FastAPI、Qwen3.5 LLM 與 Whisper 語音辨識伺服器。',
    '这将安全停止本地 FastAPI、Qwen3.5 LLM 与 Whisper 语音识别服务器。',
  ],
  shutdownConfirm: ['Shut down now', '終了する', '立即關閉', '立即关闭'],
  cancel: ['Cancel', 'キャンセル', '取消', '取消'],
  stoppedTitle: [
    'EchoLearning Server Stopped',
    'EchoLearning サーバーを停止しました',
    'EchoLearning 伺服器已停止',
    'EchoLearning 服务器已停止',
  ],
  stoppedBody: [
    'All local AI services have shut down cleanly. You may close this browser tab.',
    'すべてのローカル AI サービスが安全に停止しました。このタブを閉じて構いません。',
    '所有本地 AI 服務均已安全停止，您現在可以關閉此分頁。',
    '所有本地 AI 服务均已安全停止，您可以关闭此标签页。',
  ],
  studyBackupTitle: ['Study backup', '学習データのバックアップ', '學習資料備份', '学习数据备份'],
  studyBackupDesc: [
    'Export or restore vocabulary, transcripts, and session reports from your local SQLite vault.',
    'ローカル SQLite に保存された単語帳・字幕教材・診断履歴をエクスポート／復元します。',
    '匯出或還原本機 SQLite 儲存庫中的詞彙、逐字稿與練習報告。',
    '导出或恢复本地 SQLite 库中的词汇、字幕与练习报告。',
  ],
  privateConnTitle: [
    'Private connections & MCP',
    'プライベート接続・MCP 連携',
    '私有連線與 MCP 代理',
    '私有连接与 MCP 代理',
  ],
};

const locales = ['en', 'ja', 'zh-Hant', 'zh-Hans'] as const;
const localeLabels = ['English', '日本語', '繁體中文', '简体中文'];

function tabFromHash(): ActiveTab {
  const hash = window.location.hash.slice(1);
  return hash === 'studio' || hash === 'vocabulary' || hash === 'history' || hash === 'settings'
    ? hash
    : 'home';
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
    try {
      localStorage.setItem('echo_ui_locale', locale);
    } catch {
      // Ignore
    }
  }, [locale]);

  // Persistent Data & Materials
  const [customVideos, setCustomVideos] = useState<SavedMaterial[]>(() => loadCustomVideos());
  const [savedVocabulary, setSavedVocabulary] = useState<SavedVocabularyItem[]>(() =>
    loadSavedVocabulary()
  );
  const [practiceHistory, setPracticeHistory] = useState<ShadowingAssessmentReport[]>(() =>
    loadPracticeHistory()
  );

  // Models & System Status
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [activeModelId, setActiveModelId] = useState<string>('');
  const [isSwitchingModel, setIsSwitchingModel] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [isUpdatingSettings, setIsUpdatingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [activeSnippetTab, setActiveSnippetTab] = useState<SnippetClient>('claude');
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  // Current Studio Material & Import State
  const [currentVideo, setCurrentVideo] = useState<VideoMaterial | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [preferredFetchLang, setPreferredFetchLang] = useState<LanguageCode>('ja');
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [transcriptProgressMsg, setTranscriptProgressMsg] = useState<string | null>(null);
  const [transcriptProgressPct, setTranscriptProgressPct] = useState<number>(20);
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
  const [videoEndedCount, setVideoEndedCount] = useState(0);

  // Transcript Reader Preferences
  const [showFurigana, setShowFurigana] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);

  // Floating Dictionary State (C05 request ID + AbortController)
  const [selectedWord, setSelectedWord] = useState<string | null>(null);
  const [selectedWordSentence, setSelectedWordSentence] = useState<string>('');
  const [selectedWordTimestamp, setSelectedWordTimestamp] = useState<number>(0);
  const [dictAnchorRect, setDictAnchorRect] = useState<{ x: number; y: number } | null>(null);
  const [dictionaryResult, setDictionaryResult] = useState<DictionaryLookupResult | null>(null);
  const [isLoadingDict, setIsLoadingDict] = useState(false);
  const [dictError, setDictError] = useState<string | null>(null);
  const dictRequestSeq = useRef(0);
  const dictAbortRef = useRef<AbortController | null>(null);

  // Shadowing & S05/S06 State
  const [shadowingMode, setShadowingMode] = useState<ShadowingMode>('listen_repeat');
  const [isShadowingBusy, setIsShadowingBusy] = useState(false);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [latestReport, setLatestReport] = useState<ShadowingAssessmentReport | null>(null);
  const [activeDiffMap, setActiveDiffMap] = useState<Record<string, DiffToken[]>>({});
  const [activeDiffSegmentIds, setActiveDiffSegmentIds] = useState<string[]>([]);
  const [s05PreviewState, setS05PreviewState] = useState<S05PreviewState>({
    sessionState: 'idle',
    preview: null,
    recordedAudioUrl: null,
    takeSnapshot: null,
    finalizeError: null,
  });
  const triggerAnalyzeRef = useRef<(() => void) | null>(null);
  const triggerRecordAgainRef = useRef<(() => void) | null>(null);

  // Shutdown Dialog & Stopped State
  const [showShutdownConfirm, setShowShutdownConfirm] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [serverStopped, setServerStopped] = useState(false);
  const [shutdownError, setShutdownError] = useState<string | null>(null);

  const reportSectionRef = useRef<HTMLDivElement | null>(null);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models');
      if (!res.ok) return;
      const data = await res.json();
      const list: ModelInfo[] = Array.isArray(data.models) ? data.models : [];
      setModels(list);
      const activeId =
        data.activeModelId ||
        data.activeProfileId ||
        list.find((m) => m.active)?.id ||
        '';
      setActiveModelId(activeId);
    } catch {
      // Backend may still be booting
    }
  }, []);

  const loadSystemStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/system/status');
      if (!res.ok) return;
      const data = (await res.json()) as SystemStatus;
      setSystemStatus(data);
    } catch {
      // Ignore transient offline errors
    }
  }, []);

  // Initial migration & SQLite sync
  useEffect(() => {
    let active = true;
    (async () => {
      await migrateLocalStorageToSqlite();
      const [mats, vocs, hist] = await Promise.all([
        fetchMaterialsFromApi(),
        fetchVocabularyFromApi(),
        fetchHistoryFromApi(),
      ]);
      if (!active) return;
      setCustomVideos(mats);
      setSavedVocabulary(vocs);
      setPracticeHistory(hist);
      await Promise.all([loadModels(), loadSystemStatus()]);
    })();
    return () => {
      active = false;
    };
  }, [loadModels, loadSystemStatus]);

  // Refresh system status when opening Settings
  useEffect(() => {
    if (activeTab === 'settings') {
      void loadSystemStatus();
    }
  }, [activeTab, loadSystemStatus]);

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
  }, [currentTime, currentVideo, activeSegmentIndex]);

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

  const handleOpenSavedMaterial = async (mat: SavedMaterial) => {
    if (mat.segments && mat.segments.length > 0) {
      handleLoadVideoMaterial(mat);
      return;
    }
    const full = await fetchMaterialByIdApi(mat.videoId);
    if (full) {
      handleLoadVideoMaterial(full);
    } else {
      handleLoadVideoMaterial(mat);
    }
  };

  const handleModelSwitch = async (nextId: string) => {
    if (!nextId || nextId === activeModelId || isSwitchingModel) return;
    setIsSwitchingModel(true);
    setModelError(null);
    try {
      const res = await fetch('/api/models/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: nextId, profileId: nextId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof data?.detail === 'string'
            ? data.detail
            : data?.error || 'Could not switch local AI model.'
        );
      }
      setActiveModelId(data.activeModelId || data.activeProfileId || nextId);
      await loadModels();
      await loadSystemStatus();
    } catch (err: any) {
      setModelError(err?.message || 'Model switch failed.');
    } finally {
      setIsSwitchingModel(false);
    }
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
    setTranscriptProgressMsg('Fetching YouTube video metadata & captions...');
    setTranscriptProgressPct(18);

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
          if (typeof errJson?.detail === 'string') errText = errJson.detail;
          else if (errJson?.error) errText = errJson.error;
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

        const processNdjsonLine = async (rawLine: string) => {
          const trimmed = rawLine.trim();
          if (!trimmed) return;
          let event: any;
          try {
            event = JSON.parse(trimmed);
          } catch {
            return;
          }

          if (event.type === 'meta') {
            streamMeta = {
              videoId: event.videoId || extractedId,
              title: event.title || streamMeta.title,
              channel: event.channel || streamMeta.channel,
              durationSec: event.durationSec || 180,
              language: event.language || preferredFetchLang,
            };
            setTranscriptProgressPct(35);
          } else if (event.type === 'progress') {
            setTranscriptProgressMsg(event.message || 'Transcribing video...');
            setTranscriptProgressPct((prev) =>
              typeof event.progress === 'number'
                ? Math.round(event.progress)
                : Math.min(90, prev + 12)
            );
          } else if (event.type === 'partial_segments') {
            setTranscriptProgressMsg(event.message || 'Generating segments...');
            setTranscriptProgressPct(70);

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
            setTranscriptProgressPct(100);
            const updatedCustom = await saveMaterialToApi(event.video);
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
              event.error || event.message || 'Failed to generate complete transcript.'
            );
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            // Flush trailing non-newline-terminated NDJSON event (C03)
            const tail = buffer + decoder.decode();
            if (tail.trim()) {
              await processNdjsonLine(tail);
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const rawLine of lines) {
            await processNdjsonLine(rawLine);
          }
        }
        if (!completed) {
          throw new Error('The transcript stream ended before completion. Try again.');
        }
      } else {
        const data = await response.json();
        if (!data.video) {
          throw new Error(data.error || 'Could not generate video transcript.');
        }
        const updatedCustom = await saveMaterialToApi(data.video);
        setCustomVideos(updatedCustom);
        handleLoadVideoMaterial(data.video);
        setUrlInput('');
      }
    } catch (err: any) {
      setUrlError(err?.message || 'Failed to generate transcript from YouTube video.');
    } finally {
      setIsLoadingTranscript(false);
      setTranscriptProgressMsg(null);
      setTranscriptProgressPct(0);
    }
  };

  async function persistTranscript(video: VideoMaterial): Promise<boolean> {
    try {
      const updated = await saveMaterialToApi(video);
      setCustomVideos(updated);
      setCurrentVideo(video);
      setStorageError(null);
      return true;
    } catch {
      setStorageError('The transcript change could not be saved.');
      return false;
    }
  }

  // Inline Transcript Editing Handlers (persisted to SQLite)
  const handleUpdateSegment = (updatedSegment: TranscriptSegment) => {
    if (!currentVideo) return;
    const newSegments = currentVideo.segments.map((seg) =>
      seg.id === updatedSegment.id ? updatedSegment : seg
    );
    const updatedVideo: VideoMaterial = {
      ...currentVideo,
      segments: newSegments,
      captionNote: 'Transcript edited inline — Furigana and timestamps are synchronized.',
    };
    setCurrentVideo(updatedVideo);
    void updateMaterialSegmentApi(currentVideo.videoId, updatedSegment.id, {
      text: updatedSegment.text,
      tokens: updatedSegment.tokens,
      startTime: updatedSegment.startTime,
      endTime: updatedSegment.endTime,
    });
    void persistTranscript(updatedVideo);
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

    void persistTranscript({ ...currentVideo, segments: nextSegments });
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
    void persistTranscript(updatedVideo);
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
    const nextIdx = Math.min(currentVideo.segments.length - 1, activeSegmentIndex + 1);
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
      const next = [...prev, segmentId];
      if (!currentVideo) return next;
      return currentVideo.segments
        .filter((s) => next.includes(s.id))
        .map((s) => s.id);
    });
  };

  const handleSelectActiveOnly = () => {
    if (!currentVideo) return;
    const currentSeg =
      currentVideo.segments[activeSegmentIndex] || currentVideo.segments[0];
    setSelectedSegmentIds(currentSeg ? [currentSeg.id] : []);
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

  // Dictionary Lookup with C05 request identity + AbortController & C11 degraded check
  const handleWordClick = async (
    word: string,
    sentence: string,
    segment: TranscriptSegment,
    anchorRect: { x: number; y: number },
    _token?: WordToken
  ) => {
    if (!currentVideo) return;
    const cleanWord =
      word.replace(/[.,!?;:"'()「」『』、。！？—-]+/g, '').trim() || word.trim();
    if (!cleanWord) return;

    const reqId = ++dictRequestSeq.current;
    dictAbortRef.current?.abort();
    const controller = new AbortController();
    dictAbortRef.current = controller;

    setSelectedWord(cleanWord);
    setSelectedWordSentence(sentence);
    setSelectedWordTimestamp(segment.startTime);
    setDictAnchorRect(anchorRect);
    setDictError(null);

    const cacheKey = `${currentVideo.language}:${cleanWord}:${sentence.trim()}`;
    const cached = getCachedDictionaryLookup(cacheKey);
    if (cached) {
      setIsLoadingDict(false);
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
        signal: controller.signal,
      });
      const data = (await response.json()) as DictionaryLookupResult & { error?: string; detail?: string };
      if (reqId !== dictRequestSeq.current) return;
      if (!response.ok) {
        throw new Error(data.detail || data.error || 'Could not look up word.');
      }
      setDictionaryResult(data);
      if (!isDegradedDictionaryEntry(data)) {
        setCachedDictionaryLookup(cacheKey, data);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || reqId !== dictRequestSeq.current) return;
      setDictError(err?.message || 'Dictionary lookup failed.');
    } finally {
      if (reqId === dictRequestSeq.current) {
        setIsLoadingDict(false);
      }
    }
  };

  const handleCloseDictionary = () => {
    dictRequestSeq.current += 1;
    dictAbortRef.current?.abort();
    setSelectedWord(null);
    setDictionaryResult(null);
    setIsLoadingDict(false);
    setDictError(null);
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

  const handleAdvanceToSegmentIndex = (
    targetIndex: number,
    selectSingle = false
  ): TranscriptSegment | null => {
    if (!currentVideo || currentVideo.segments.length === 0) return null;
    const clampedIndex = Math.max(0, Math.min(targetIndex, currentVideo.segments.length - 1));
    const seg = currentVideo.segments[clampedIndex];
    setActiveSegmentIndex(clampedIndex);
    if (selectSingle && seg) {
      setSelectedSegmentIds([seg.id]);
    }
    return seg;
  };

  const handleSaveVocabularyWord = async (entry: DictionaryLookupResult) => {
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
      const updated = await saveVocabularyItemApi(newItem);
      setSavedVocabulary(updated);
      setStorageError(null);
    } catch {
      setStorageError('The word could not be saved.');
    }
  };

  const handleReportGenerated = async (report: ShadowingAssessmentReport) => {
    setLatestReport(report);
    setActiveDiffMap({ latest: report.wordDiff });
    setActiveDiffSegmentIds(report.segmentIds);

    // R08: Demo takes never pollute real SQLite progress averages
    if (!report.isDemo) {
      const updatedHistory = await savePracticeReportApi(report);
      setPracticeHistory(updatedHistory);
    }

    setTimeout(() => {
      reportSectionRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 120);
  };

  const handleToggleSetting = async (patch: Record<string, boolean>) => {
    setIsUpdatingSettings(true);
    setSettingsError(null);
    try {
      const res = await fetch('/api/system/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof data?.detail === 'string'
            ? data.detail
            : data?.error || 'Failed to update settings.'
        );
      }
      setSystemStatus(data as SystemStatus);
    } catch (err: any) {
      setSettingsError(err?.message || 'Could not update system settings.');
    } finally {
      setIsUpdatingSettings(false);
    }
  };

  const handleConfirmShutdown = async () => {
    setIsShuttingDown(true);
    setShutdownError(null);
    const verifyServerStopped = async (): Promise<boolean> => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        const healthRes = await fetch('/api/health');
        return !healthRes.ok;
      } catch {
        return true;
      }
    };

    try {
      const res = await fetch('/api/system/shutdown', {
        method: 'POST',
      });
      if (!res.ok) {
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          if (await verifyServerStopped()) {
            setShowShutdownConfirm(false);
            setServerStopped(true);
            return;
          }
        }
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || 'Shutdown request was rejected.');
      }
      setShowShutdownConfirm(false);
      setServerStopped(true);
    } catch (err: any) {
      if (await verifyServerStopped()) {
        setShowShutdownConfirm(false);
        setServerStopped(true);
        return;
      }
      setShutdownError(err?.message || 'Could not shut down server cleanly.');
    } finally {
      setIsShuttingDown(false);
    }
  };

  const originHost =
    systemStatus?.tailscale?.running && systemStatus?.tailscale?.ip
      ? `http://${systemStatus.tailscale.ip}:3000`
      : typeof window !== 'undefined'
      ? window.location.origin
      : 'http://127.0.0.1:3000';

  const mcpHttpUrl = systemStatus?.mcp?.httpEndpoint || `${originHost}/mcp`;
  const mcpStdioCmd = systemStatus?.mcp?.stdioCommand || './scripts/start_mcp.sh';

  const snippetMap: Record<SnippetClient, string> = {
    claude: `# Claude Code — add EchoLearning local MCP server\nclaude mcp add echolearning --transport http ${mcpHttpUrl}\n# Or stdio locally:\nclaude mcp add echolearning -- ${mcpStdioCmd}`,
    codex: `# OpenAI Codex CLI (~/.codex/config.toml)\n[mcp_servers.echolearning]\nurl = "${mcpHttpUrl}"\n# Or local stdio:\n# command = "${mcpStdioCmd}"`,
    antigravity: `{\n  "mcpServers": {\n    "echolearning": {\n      "serverUrl": "${mcpHttpUrl}"\n    }\n  }\n}`,
    bots: `# Personal AI Bots (Grok Bot / Muse Bot) — Streamable HTTP MCP or REST\n# MCP Endpoint: ${mcpHttpUrl}\ncurl -X POST ${originHost}/api/transcript/fetch \\\n  -H "Content-Type: application/json" \\\n  -d '{"urlOrId": "https://youtu.be/VIDEO_ID", "preferredLanguage": "ja", "stream": false}'`,
  };

  const handleCopySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippetMap[activeSnippetTab]);
      setCopiedSnippet(true);
      setTimeout(() => setCopiedSnippet(false), 1800);
    } catch {
      // Ignore clipboard failure
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

  if (serverStopped) {
    return (
      <div className="echo-app flex items-center justify-center p-6">
        <div className="echo-panel max-w-md w-full text-center space-y-4">
          <Power className="w-10 h-10 mx-auto text-sky-400" />
          <h1 className="text-xl font-bold">{uiCopy.stoppedTitle[localeIndex]}</h1>
          <p className="text-sm text-slate-400">{uiCopy.stoppedBody[localeIndex]}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="echo-primary cursor-pointer text-sm"
          >
            Reload Page
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="echo-app">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>

      <header className="echo-header">
        <a href="#home" className="echo-brand">
          <img src={logoImg} alt="" className="w-7 h-7 rounded-md object-contain" />
          <span>EchoLearning</span>
        </a>

        <nav aria-label="Main navigation">
          {Object.entries(navigation).map(([tab, labels]) => (
            <a
              key={tab}
              href={`#${tab}`}
              aria-current={activeTab === tab ? 'page' : undefined}
            >
              {labels[localeIndex]}
            </a>
          ))}
        </nav>

        <div className="echo-header-actions">
          <select
            aria-label="Interface language"
            value={locale}
            onChange={(event) => setLocale(event.target.value)}
          >
            {locales.map((value, index) => (
              <option key={value} value={value} lang={value}>
                {localeLabels[index]}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => {
              setShutdownError(null);
              setShowShutdownConfirm(true);
            }}
            aria-label="Shut down EchoLearning"
            className="px-2.5 py-1.5 rounded-lg hover:bg-slate-800/70 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Power aria-hidden="true" />
            <span className="shutdown-label font-semibold text-xs">
              {uiCopy.shutdownBtn[localeIndex]}
            </span>
          </button>
        </div>
      </header>

      {showShutdownConfirm && (
        <dialog
          ref={(node) => {
            if (node && !node.open) node.showModal();
          }}
          aria-labelledby="shutdown-title"
          onCancel={() => !isShuttingDown && setShowShutdownConfirm(false)}
        >
          <h2 id="shutdown-title" className="text-lg font-bold">
            {uiCopy.shutdownTitle[localeIndex]}
          </h2>
          <p className="text-sm">{uiCopy.shutdownBody[localeIndex]}</p>
          {shutdownError && (
            <p className="echo-error" role="alert">
              {shutdownError}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 mt-4">
            <button
              type="button"
              disabled={isShuttingDown}
              onClick={() => setShowShutdownConfirm(false)}
              className="px-3.5 py-2 text-xs bg-slate-800 text-slate-200 rounded-lg cursor-pointer"
            >
              {uiCopy.cancel[localeIndex]}
            </button>
            <button
              autoFocus
              type="button"
              disabled={isShuttingDown}
              onClick={handleConfirmShutdown}
              className="echo-primary text-xs cursor-pointer flex items-center gap-1.5"
            >
              {isShuttingDown && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>{uiCopy.shutdownConfirm[localeIndex]}</span>
            </button>
          </div>
        </dialog>
      )}

      {/* Non-blocking Floating Dictionary Window (S04) */}
      <DictionaryPopover
        lookupResult={dictionaryResult}
        isLoading={isLoadingDict}
        error={dictError}
        selectedWord={selectedWord}
        anchorRect={dictAnchorRect}
        isSaved={isCurrentWordSaved}
        onClose={handleCloseDictionary}
        onSaveWord={handleSaveVocabularyWord}
      />

      <main className="echo-main" id="main-content" tabIndex={-1}>
        {storageError && (
          <p className="echo-error mb-3" role="alert">
            {storageError}
          </p>
        )}

        {/* HOME PAGE */}
        {(activeTab === 'home' || (activeTab === 'studio' && !currentVideo && !latestReport)) && (
          <div className="space-y-8">
            <section className="echo-home">
              <h1>{uiCopy.homeTitle[localeIndex]}</h1>
              <p>{uiCopy.homeDesc[localeIndex]}</p>

              <form className="echo-panel echo-import" onSubmit={handleUrlSubmit}>
                <label htmlFor="video-url">{uiCopy.urlLabel[localeIndex]}</label>
                <input
                  id="video-url"
                  value={urlInput}
                  onChange={(event) => setUrlInput(event.target.value)}
                  placeholder="https://youtu.be/..."
                  required
                  disabled={isLoadingTranscript}
                />

                <div className="echo-choice" role="group" aria-label="Content language">
                  {(['ja', 'en'] as const).map((language) => (
                    <button
                      key={language}
                      type="button"
                      aria-pressed={preferredFetchLang === language}
                      disabled={isLoadingTranscript}
                      onClick={() => setPreferredFetchLang(language)}
                      className="cursor-pointer text-xs sm:text-sm"
                    >
                      {language === 'ja' ? '日本語コンテンツ' : 'English Content'}
                    </button>
                  ))}
                </div>

                {/* Runtime Local AI Model Selection (Section 9) */}
                <div className="flex flex-wrap items-center gap-2.5 pt-1">
                  <label htmlFor="model-select" className="shrink-0">
                    {uiCopy.modelLabel[localeIndex]}
                  </label>
                  <div className="flex-1 min-w-[200px] flex items-center gap-2">
                    <select
                      id="model-select"
                      value={activeModelId}
                      disabled={isSwitchingModel || isLoadingTranscript || models.length === 0}
                      onChange={(e) => handleModelSwitch(e.target.value)}
                      className="text-xs sm:text-sm"
                    >
                      {models.length === 0 ? (
                        <option value="">Qwen3.5-9B-GGUF:Q6_K (Default)</option>
                      ) : (
                        models.map((m) => {
                          const label = m.displayName || m.name || m.id;
                          const statusTag = m.active
                            ? '[Active]'
                            : m.installed
                            ? '[Installed]'
                            : '[Not Installed]';
                          return (
                            <option key={m.id} value={m.id} disabled={!m.installed}>
                              {label} ({m.sizeGb} GiB) {statusTag}
                            </option>
                          );
                        })
                      )}
                    </select>
                    {isSwitchingModel && (
                      <Loader2 className="w-4 h-4 animate-spin text-sky-400 shrink-0" />
                    )}
                  </div>
                </div>
                {modelError && (
                  <p role="alert" className="echo-error">
                    {modelError}
                  </p>
                )}

                {isLoadingTranscript && (
                  <div className="space-y-2">
                    <div role="status" className="echo-progress justify-between">
                      <span className="flex items-center gap-2 min-w-0">
                        <Loader2 className="size-4 animate-spin shrink-0" />
                        <span className="truncate">{transcriptProgressMsg}</span>
                      </span>
                      <span className="font-mono-tabular shrink-0">
                        {transcriptProgressPct}%
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-sky-400 transition-all duration-300"
                        style={{ width: `${Math.max(8, transcriptProgressPct)}%` }}
                      />
                    </div>
                  </div>
                )}

                {urlError && (
                  <p role="alert" className="echo-error">
                    {urlError}
                  </p>
                )}

                <button
                  className="echo-primary cursor-pointer text-sm"
                  type="submit"
                  disabled={isLoadingTranscript || isSwitchingModel}
                >
                  {uiCopy.generateBtn[localeIndex]}
                </button>
              </form>
            </section>

            {/* Saved Shadowing Materials Library (Generate Now, Practice Later) */}
            {customVideos.length > 0 && (
              <section className="max-w-3xl mx-auto space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-bold text-white text-[#ffffff]! flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-sky-400" />
                    <span>{uiCopy.savedTitle[localeIndex]}</span>
                  </h2>
                  <button
                    type="button"
                    onClick={async () => setCustomVideos(await fetchMaterialsFromApi())}
                    className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1 cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Refresh</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {customVideos.map((video) => (
                    <div
                      key={video.videoId}
                      className="echo-panel flex items-start justify-between gap-3 hover:border hover:border-sky-400/50 transition-colors"
                    >
                      <button
                        type="button"
                        disabled={isLoadingTranscript}
                        onClick={() => handleOpenSavedMaterial(video)}
                        className="text-left min-w-0 flex-1 space-y-1 cursor-pointer"
                      >
                        <div className="text-xs text-slate-400 flex items-center gap-2">
                          <span className="uppercase font-semibold text-sky-400">
                            {video.language === 'ja' ? 'JA 日本語' : 'EN'}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{video.segments?.length || 0} lines</span>
                        </div>
                        <div className="text-sm font-bold text-white text-[#ffffff]! line-clamp-2 break-words">
                          {video.title}
                        </div>
                        <div className="text-xs text-slate-400 truncate">
                          {video.channel}
                        </div>
                      </button>

                      <button
                        type="button"
                        aria-label={`Delete saved material ${video.title}`}
                        onClick={async () =>
                          setCustomVideos(await deleteMaterialFromApi(video.videoId))
                        }
                        className="p-1.5 text-slate-400 hover:text-red-400 rounded-lg cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* STUDIO REPORT FALLBACK WHEN MATERIAL DELETED */}
        {activeTab === 'studio' && !currentVideo && latestReport && (
          <section ref={reportSectionRef} className="space-y-3">
            <p role="status" className="echo-progress">
              The original material is unavailable. You can still review this report.
            </p>
            <PerformanceReport report={latestReport} />
          </section>
        )}

        {/* PRACTICE STUDIO */}
        {activeTab === 'studio' && currentVideo && (
          <div className="space-y-4">
            {/* Video Metadata */}
            <div className="flex flex-wrap items-start justify-between gap-2 px-1 text-xs text-[#b8c1d4]">
              <div className="min-w-0 flex-1 space-y-0.5">
                <h1 className="echo-video-title text-[#eef1fa] break-words">
                  {currentVideo.title}
                </h1>
                <div className="flex flex-wrap items-center gap-2">
                  <span>{currentVideo.channel}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {currentVideo.language === 'ja' ? 'Japanese (日本語)' : 'English (EN)'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{currentVideo.level}</span>
                </div>
              </div>
            </div>

            <div className="echo-studio">
              {/* LEFT COLUMN: Synchronized Interactive Transcript Reader */}
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
                  disabledControls={isShadowingBusy}
                  onSelectSegmentToSeek={handleSelectSegmentToSeek}
                  onToggleSegmentSelection={handleToggleSegmentSelection}
                  onSelectAllSegments={handleSelectAllSegments}
                  onResetToActiveSegment={handleSelectActiveOnly}
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

              {/* RIGHT COLUMN: Video Player + AI Shadowing Practice */}
              <div className="echo-media space-y-3">
                <YouTubePlayer
                  key={currentVideo.videoId}
                  videoId={currentVideo.videoId}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  playbackRate={playbackRate}
                  loopSegment={loopSegment}
                  autoPauseAtSec={autoPauseAtSec}
                  activeSegmentStartTime={activeSegment?.startTime}
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
                  onVideoEnded={() => setVideoEndedCount((c) => c + 1)}
                  playerRefOut={playerHandleRef}
                />

                {activeSegment && (
                  <ShadowingStudio
                    key={currentVideo.videoId}
                    videoId={currentVideo.videoId}
                    videoTitle={currentVideo.title}
                    channel={currentVideo.channel}
                    language={currentVideo.language}
                    mode={shadowingMode}
                    showFurigana={showFurigana}
                    allSegments={currentVideo.segments}
                    targetSegments={targetPracticeSegments}
                    activeSegment={activeSegment}
                    isEvaluating={isShadowingBusy}
                    playerHandleRef={playerHandleRef}
                    onModeChange={handleModeChange}
                    onSetAutoPauseAtSec={setAutoPauseAtSec}
                    onClearLoopSegment={() => setLoopSegment(null)}
                    onReportGenerated={handleReportGenerated}
                    onPreviewStateChange={setS05PreviewState}
                    onBusyStateChange={setIsShadowingBusy}
                    onEvaluationError={setEvaluationError}
                    autoPauseTriggerCount={autoPauseTriggerCount}
                    videoEndedCount={videoEndedCount}
                    latestReport={latestReport}
                    onAdvanceToNextSegment={handleAdvanceToNextSegment}
                    onAdvanceToSegmentIndex={handleAdvanceToSegmentIndex}
                    triggerAnalyzeRef={triggerAnalyzeRef}
                    triggerRecordAgainRef={triggerRecordAgainRef}
                  />
                )}

                {evaluationError && (
                  <div
                    role="alert"
                    className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700"
                  >
                    {evaluationError}
                  </div>
                )}
              </div>
            </div>

            {/* FULL-WIDTH S05: Post-Recording Local Whisper Preview */}
            <RecognizedSpeechPreview
              state={s05PreviewState}
              onAnalyzeResult={() => triggerAnalyzeRef.current?.()}
              onRecordAgain={() => triggerRecordAgainRef.current?.()}
            />

            {/* FULL-WIDTH S06: AI Shadowing Evaluation Report */}
            {latestReport && (
              <div ref={reportSectionRef} className="pt-1">
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
                    const matchedSegs = currentVideo.segments.filter((s) =>
                      latestReport.segmentIds.includes(s.id)
                    );
                    const firstSeg = matchedSegs[0] || activeSegment;
                    const lastSeg = matchedSegs[matchedSegs.length - 1] || firstSeg;
                    if (firstSeg && lastSeg) {
                      if (matchedSegs.length > 1 && latestReport.mode === 'listen_repeat') {
                        setActiveSegmentIndex(firstSeg.index);
                        setSelectedSegmentIds(matchedSegs.map((s) => s.id));
                        setShadowingMode('listen_repeat');
                        setAutoPauseAtSec(lastSeg.endTime);
                        playerHandleRef.current?.seekTo(firstSeg.startTime, true);
                        playerHandleRef.current?.play();
                      } else {
                        handleStartShadowingSegment(firstSeg);
                      }
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* VOCABULARY VAULT */}
        {activeTab === 'vocabulary' && (
          <VocabularyVaultView
            items={savedVocabulary}
            localeIndex={localeIndex}
            onRemoveItem={async (id) => {
              try {
                setSavedVocabulary(await removeVocabularyItemApi(id));
                setStorageError(null);
              } catch {
                setStorageError('The word could not be removed. Try again.');
              }
            }}
            onExportCsv={() => exportVocabularyToCsv(savedVocabulary)}
            onJumpToVideoSegment={async (videoId, timestampSec) => {
              const targetVid =
                customVideos.find((v) => v.videoId === videoId) ||
                (await fetchMaterialByIdApi(videoId));
              if (targetVid) {
                handleLoadVideoMaterial(targetVid);
                setTimeout(() => {
                  playerHandleRef.current?.seekTo(timestampSec, true);
                  playerHandleRef.current?.play();
                }, 400);
              }
            }}
          />
        )}

        {/* SESSION HISTORY */}
        {activeTab === 'history' && (
          <SessionHistoryView
            reports={practiceHistory}
            localeIndex={localeIndex}
            onDeleteReport={async (id) => {
              try {
                setPracticeHistory(await deletePracticeReportApi(id));
                setStorageError(null);
              } catch {
                setStorageError('The report could not be removed. Try again.');
              }
            }}
            onSelectReportForReview={async (rep) => {
              const targetVid =
                customVideos.find((v) => v.videoId === rep.videoId) ||
                (await fetchMaterialByIdApi(rep.videoId));
              if (targetVid) {
                handleLoadVideoMaterial(targetVid);
                setShadowingMode(rep.mode);
                const segments = targetVid.segments.filter((segment) =>
                  rep.segmentIds.includes(segment.id)
                );
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

        {/* SETTINGS */}
        {activeTab === 'settings' && (
          <section className="space-y-4">
            <h1 className="echo-page-title text-[#eef1fa]">{navigation.settings[localeIndex]}</h1>

            <div className="echo-settings">
              {/* Left Card: Study Backup */}
              <section className="echo-panel space-y-3.5">
                <h2 className="text-[#eef1fa]">{uiCopy.studyBackupTitle[localeIndex]}</h2>
                <p className="text-xs sm:text-sm text-[#b8c1d4]">{uiCopy.studyBackupDesc[localeIndex]}</p>

                <div className="echo-restore">
                  <label htmlFor="backup-file" className="text-xs font-semibold text-[#b8c1d4]">
                    Backup JSON
                  </label>
                  <input
                    id="backup-file"
                    type="file"
                    accept=".json,application/json"
                    className="w-full px-3 py-2 text-xs bg-[#151925] text-[#eef1fa] border border-[#525a6d] rounded-lg file:mr-3 file:py-1 file:px-2.5 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-[#332b57] file:text-[#eef1fa] hover:file:bg-[#c3bbff] hover:file:text-[#151925] cursor-pointer"
                    onChange={async (event) => {
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
                          setBackupError(
                            error instanceof SyntaxError
                              ? 'Choose a valid JSON backup.'
                              : error instanceof Error
                              ? error.message
                              : 'Unable to read the backup.'
                          );
                        }
                      }
                    }}
                  />

                  <div className="flex flex-wrap items-center gap-2.5 pt-1">
                    <button
                      type="button"
                      className="px-3.5 py-2 text-xs font-semibold bg-[#151925] text-[#eef1fa] border border-[#525a6d] hover:border-[#c3bbff] hover:bg-[#262d40] rounded-lg transition-colors cursor-pointer"
                      onClick={() => {
                        try {
                          exportAllStudyDataJson(
                            savedVocabulary,
                            practiceHistory,
                            customVideos
                          );
                          setBackupError('');
                        } catch {
                          setBackupError('The backup could not be generated.');
                        }
                      }}
                    >
                      Generate backup
                    </button>

                    <label
                      htmlFor="backup-file"
                      className="px-3.5 py-2 text-xs font-semibold bg-[#151925] text-[#eef1fa] border border-[#525a6d] hover:border-[#c3bbff] hover:bg-[#262d40] rounded-lg transition-colors cursor-pointer"
                    >
                      Restore backup
                    </label>
                  </div>

                  {backup && (
                    <div className="p-3 bg-[#151925] border border-[#525a6d] rounded-lg space-y-2 text-xs text-[#eef1fa]">
                      <p className="text-[#eef1fa]!">
                        {backup.vocabulary.length} words, {backup.materials.length} materials,{' '}
                        {backup.history.length} reports ready to merge.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="echo-primary cursor-pointer text-xs"
                          type="button"
                          onClick={async () => {
                            try {
                              const restored = await restoreStudyBackup(backup);
                              setSavedVocabulary(restored.vocabulary);
                              setPracticeHistory(restored.history);
                              setCustomVideos(restored.materials);
                              setBackup(null);
                              setBackupError('');
                              setBackupStatus('Backup merged into local SQLite vault.');
                            } catch {
                              setBackupError('The backup could not be saved.');
                            }
                          }}
                        >
                          Merge backup
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setBackup(null);
                            setBackupError('');
                          }}
                          className="px-3 py-1.5 bg-[#262d40] text-[#eef1fa] border border-[#525a6d] rounded-lg cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {backupError && (
                    <p className="echo-error" role="alert">
                      {backupError}
                    </p>
                  )}
                  {backupStatus && <p role="status" className="text-xs text-[#6ee7b7]!">{backupStatus}</p>}
                </div>
              </section>

              {/* Right Card: Private Connections, Tailscale & MCP Agents */}
              <section className="echo-panel space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="mb-0! flex items-center gap-2 text-[#eef1fa]">
                    <ShieldCheck className="w-5 h-5 text-[#c3bbff]" />
                    <span>{uiCopy.privateConnTitle[localeIndex]}</span>
                  </h2>
                  <button
                    type="button"
                    onClick={() => void loadSystemStatus()}
                    className="px-2.5 py-1 text-xs text-[#eef1fa] bg-[#151925] border border-[#525a6d] hover:border-[#c3bbff] rounded-md flex items-center gap-1 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-[#c3bbff]" />
                    <span>Refresh</span>
                  </button>
                </div>

                {/* Live Service Readiness Badges */}
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="px-2.5 py-1 rounded-md bg-[#151925] text-[#eef1fa] border border-[#525a6d] flex items-center gap-1.5">
                    <Server className="w-3.5 h-3.5 text-[#c3bbff]" />
                    <span>
                      LLM: {systemStatus?.llamaReady ? 'Ready' : 'Offline/Warming'}
                    </span>
                  </span>
                  <span className="px-2.5 py-1 rounded-md bg-[#151925] text-[#eef1fa] border border-[#525a6d]">
                    Whisper: {systemStatus?.whisperReady ? 'Ready' : 'Offline'}
                  </span>
                  <span className="px-2.5 py-1 rounded-md bg-[#151925] text-[#eef1fa] border border-[#525a6d]">
                    SQLite: {systemStatus?.sqliteReady ? 'Connected' : 'Local Cache'}
                  </span>
                </div>

                {/* Tailscale Remote Access */}
                <div className="p-3.5 bg-[#151925] border border-[#525a6d] rounded-lg space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-[#eef1fa]">Tailscale access</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(systemStatus?.tailscale?.enabled)}
                      disabled={isUpdatingSettings}
                      onClick={() =>
                        handleToggleSetting({
                          tailscale_enabled: !systemStatus?.tailscale?.enabled,
                        })
                      }
                      className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                        systemStatus?.tailscale?.enabled
                          ? 'bg-[#c3bbff] text-[#151925]'
                          : 'bg-[#1e2331] text-[#eef1fa] border border-[#525a6d] hover:border-[#c3bbff]'
                      }`}
                    >
                      {systemStatus?.tailscale?.enabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  <div className="text-xs text-[#b8c1d4] space-y-1 font-mono-tabular">
                    {systemStatus?.tailscale?.running && systemStatus.tailscale.ip ? (
                      <>
                        <div>
                          Web UI:{' '}
                          <strong className="text-[#eef1fa]">
                            http://{systemStatus.tailscale.ip}:5173
                          </strong>
                        </div>
                        <div>
                          API &amp; MCP:{' '}
                          <strong className="text-[#eef1fa]">
                            http://{systemStatus.tailscale.ip}:3000/mcp
                          </strong>
                        </div>
                        {systemStatus.tailscale.hostname && (
                          <div>Hostname: {systemStatus.tailscale.hostname}</div>
                        )}
                      </>
                    ) : systemStatus?.tailscale?.installed ? (
                      <div>Tailscale installed — sign in / start Tailscale to view your 100.x.y.z IP.</div>
                    ) : (
                      <div>Tailscale CLI not detected on this Mac. Install Tailscale for private mobile access.</div>
                    )}
                  </div>
                </div>

                {/* MCP Agents Toggles */}
                <div className="p-3.5 bg-[#151925] border border-[#525a6d] rounded-lg space-y-2.5">
                  <div className="text-sm font-semibold text-[#eef1fa]">MCP agents</div>
                  <div className="flex flex-wrap items-center gap-2.5 text-xs">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(systemStatus?.mcp?.httpEnabled ?? true)}
                      disabled={isUpdatingSettings}
                      onClick={() =>
                        handleToggleSetting({
                          mcp_http_enabled: !(systemStatus?.mcp?.httpEnabled ?? true),
                        })
                      }
                      className={`px-3 py-1.5 rounded-lg font-semibold transition-colors cursor-pointer ${
                        systemStatus?.mcp?.httpEnabled ?? true
                          ? 'bg-[#c3bbff] text-[#151925]'
                          : 'bg-[#1e2331] text-[#eef1fa] border border-[#525a6d] hover:border-[#c3bbff]'
                      }`}
                    >
                      HTTP /mcp: {systemStatus?.mcp?.httpEnabled ?? true ? 'ON' : 'OFF'}
                    </button>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(systemStatus?.mcp?.stdioEnabled ?? true)}
                      disabled={isUpdatingSettings}
                      onClick={() =>
                        handleToggleSetting({
                          mcp_stdio_enabled: !(systemStatus?.mcp?.stdioEnabled ?? true),
                        })
                      }
                      className={`px-3 py-1.5 rounded-lg font-semibold transition-colors cursor-pointer ${
                        systemStatus?.mcp?.stdioEnabled ?? true
                          ? 'bg-[#c3bbff] text-[#151925]'
                          : 'bg-[#1e2331] text-[#eef1fa] border border-[#525a6d] hover:border-[#c3bbff]'
                      }`}
                    >
                      Stdio MCP: {systemStatus?.mcp?.stdioEnabled ?? true ? 'ON' : 'OFF'}
                    </button>
                  </div>
                </div>

                {settingsError && (
                  <p className="echo-error" role="alert">
                    {settingsError}
                  </p>
                )}

                {/* Copyable Configuration Snippets */}
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    {(
                      [
                        ['claude', 'Claude Code'],
                        ['codex', 'OpenAI Codex'],
                        ['antigravity', 'Antigravity'],
                        ['bots', 'Grok / Muse Bots'],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setActiveSnippetTab(key)}
                        className={`px-3 py-1.5 rounded-lg font-semibold transition-colors cursor-pointer ${
                          activeSnippetTab === key
                            ? 'bg-[#c3bbff] text-[#151925]'
                            : 'bg-[#151925] text-[#eef1fa] border border-[#525a6d] hover:border-[#c3bbff]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="relative">
                    <pre className="p-3 pr-10 rounded-lg bg-[#151925] border border-[#525a6d] text-[11px] font-mono-tabular text-[#eef1fa] overflow-x-auto whitespace-pre-wrap break-all">
                      {snippetMap[activeSnippetTab]}
                    </pre>
                    <button
                      type="button"
                      onClick={handleCopySnippet}
                      aria-label="Copy MCP snippet"
                      className="absolute top-2 right-2 p-1.5 rounded-md bg-[#1e2331] border border-[#525a6d] hover:border-[#c3bbff] text-[#eef1fa] cursor-pointer"
                    >
                      {copiedSnippet ? (
                        <Check className="w-3.5 h-3.5 text-[#6ee7b7]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </section>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
