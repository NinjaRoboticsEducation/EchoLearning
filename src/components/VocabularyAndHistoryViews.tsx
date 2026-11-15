import React, { useState } from 'react';
import {
  Clock,
  Download,
  Loader2,
  Play,
  Search,
  Trash2,
  Volume2,
} from 'lucide-react';
import {
  LanguageCode,
  SavedVocabularyItem,
  ShadowingAssessmentReport,
} from '../types';
import { formatTimestamp } from './YouTubePlayer';

interface VocabularyVaultViewProps {
  items: SavedVocabularyItem[];
  localeIndex?: number;
  onRemoveItem: (id: string) => void;
  onExportCsv: () => void;
  onJumpToVideoSegment: (videoId: string, timestampSec: number) => void;
}

const vocabLabels = {
  title: [
    'Personal Vocabulary Vault',
    'マイ単語帳',
    '個人詞彙庫',
    '个人词汇库',
  ],
  subtitle: [
    'Review contextual English and Japanese words saved from your shadowing transcripts, complete with Furigana, IPA, and source video timestamps.',
    'シャドーイング字幕から保存した英語・日本語の単語を、振り仮名・発音記号・動画タイムスタンプ付きで復習できます。',
    '複習從跟讀逐字稿中儲存的英文與日文單字，包含假名、IPA 音標與影片時間戳記。',
    '复习从跟读字幕中保存的英文与日文单词，包含假名、IPA 音标和视频时间戳。',
  ],
  searchPlaceholder: [
    'Search word, reading, meaning...',
    '単語・読み・意味を検索…',
    '搜尋單字、讀音、釋義…',
    '搜索单词、读音、释义…',
  ],
  all: ['All', 'すべて', '全部', '全部'],
  exportCsv: ['Export Anki CSV', 'Anki CSV 出力', '匯出 Anki CSV', '导出 Anki CSV'],
  emptyTitle: [
    'No saved vocabulary words match your filter yet.',
    '条件に一致する保存単語はまだありません。',
    '目前沒有符合條件的已儲存單字。',
    '暂无符合条件的已保存单词。',
  ],
  emptyDesc: [
    'In the Practice Studio, click any unfamiliar English or Japanese word in the transcript to view its contextual definition and save it to your Vault.',
    '練習スタジオで字幕内の気になる単語をクリックすると、文脈に沿った意味を確認して単語帳に保存できます。',
    '在練習室點擊逐字稿中的任何英文或日文單字，即可查看語境釋義並儲存至詞彙庫。',
    '在练习室点击字幕中的任何英文或日文单词，即可查看语境释义并保存到词汇库。',
  ],
};

export const VocabularyVaultView: React.FC<VocabularyVaultViewProps> = ({
  items,
  localeIndex = 0,
  onRemoveItem,
  onExportCsv,
  onJumpToVideoSegment,
}) => {
  const [filterLang, setFilterLang] = useState<'all' | LanguageCode>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);

  const filtered = items.filter((item) => {
    const matchesLang = filterLang === 'all' || item.language === filterLang;
    const q = searchQuery.trim().toLowerCase();
    const matchesQuery =
      !q ||
      item.word.toLowerCase().includes(q) ||
      item.reading.toLowerCase().includes(q) ||
      item.contextualMeaning.toLowerCase().includes(q) ||
      (item.romaji && item.romaji.toLowerCase().includes(q));
    return matchesLang && matchesQuery;
  });

  const handlePlayWord = async (item: SavedVocabularyItem) => {
    if (playingId) return;
    setPlayingId(item.id);
    try {
      const res = await fetch('/api/tts/pronounce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: item.word, language: item.language }),
      });
      const data = await res.json();
      if (res.ok && data.audioBase64) {
        const audio = new Audio(`data:${data.mimeType || 'audio/wav'};base64,${data.audioBase64}`);
        audio.onended = () => setPlayingId(null);
        audio.onerror = () => setPlayingId(null);
        await audio.play();
      } else {
        setPlayingId(null);
      }
    } catch {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          const u = new SpeechSynthesisUtterance(item.word);
          u.lang = item.language === 'ja' ? 'ja-JP' : 'en-US';
          u.onend = () => setPlayingId(null);
          u.onerror = () => setPlayingId(null);
          window.speechSynthesis.speak(u);
          return;
        } catch {
          // Ignore
        }
      }
      setPlayingId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Unboxed Header matching Vocabulary.png */}
      <div className="space-y-3">
        <div>
          <h1 className="echo-page-title text-slate-900">
            {vocabLabels.title[localeIndex]}
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1 max-w-3xl">
            {vocabLabels.subtitle[localeIndex]}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="echo-choice" role="group" aria-label="Filter vocabulary by language">
            {(['all', 'en', 'ja'] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                aria-pressed={filterLang === lang}
                onClick={() => setFilterLang(lang)}
                className="text-xs uppercase tracking-wide cursor-pointer"
              >
                {lang === 'all' ? vocabLabels.all[localeIndex] : lang === 'en' ? 'English' : 'Japanese'}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="Search saved vocabulary"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={vocabLabels.searchPlaceholder[localeIndex]}
                className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:border-sky-600 min-w-[200px]"
              />
            </div>

            <button
              type="button"
              onClick={onExportCsv}
              disabled={items.length === 0}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>
                {vocabLabels.exportCsv[localeIndex]} ({items.length})
              </span>
            </button>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
          <p className="text-sm font-semibold text-slate-800">
            {vocabLabels.emptyTitle[localeIndex]}
          </p>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            {vocabLabels.emptyDesc[localeIndex]}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((item) => (
            <article
              key={item.id}
              className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-3 min-w-0"
            >
              <div className="space-y-2.5 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-xs text-slate-500 font-medium break-words">
                    {item.language === 'ja' ? 'Japanese · 日本語' : 'English'} · {item.partOfSpeech}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => handlePlayWord(item)}
                      disabled={playingId === item.id}
                      aria-label={`Listen to ${item.word}`}
                      title="Listen to pronunciation"
                      className="p-1.5 text-slate-600 hover:text-sky-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                    >
                      {playingId === item.id ? (
                        <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
                      ) : (
                        <Volume2 className="w-4 h-4" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveItem(item.id)}
                      aria-label={`Remove ${item.word} from Vault`}
                      title="Remove from Vault"
                      className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Inset word & phonetic surface matching Vocabulary.png */}
                <div className="bg-slate-50 border border-slate-200/80 rounded-lg px-3 py-2.5 min-w-0">
                  <h3 className="text-base font-bold text-slate-900 flex flex-wrap items-baseline gap-2 break-words">
                    <span>{item.word}</span>
                    {item.reading && (
                      <span className="text-xs font-normal text-sky-700">
                        【{item.reading}】
                      </span>
                    )}
                    {item.ipa && (
                      <span className="text-xs font-mono-tabular text-slate-500">
                        {item.ipa}
                      </span>
                    )}
                  </h3>
                </div>

                {/* Inset contextual meaning box matching Vocabulary.png */}
                <p className="text-xs sm:text-sm text-slate-800 leading-relaxed bg-sky-50/70 px-3 py-2.5 rounded-lg border border-sky-100 break-words">
                  {item.contextualMeaning}
                </p>

                <div className="text-xs text-slate-600 break-words">
                  <span className="font-medium text-slate-700 block mb-0.5">Example:</span>
                  <span>"{item.sourceSentence}"</span>
                </div>
              </div>

              <div className="pt-2.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                <span className="truncate max-w-[220px]" title={item.videoTitle}>
                  {item.videoTitle}
                </span>
                <button
                  type="button"
                  onClick={() => onJumpToVideoSegment(item.videoId, item.timestampSec)}
                  className="text-sky-700 hover:text-sky-900 font-mono-tabular font-medium flex items-center gap-1 cursor-pointer shrink-0"
                >
                  <Play className="w-3 h-3" />
                  <span>Jump to {formatTimestamp(item.timestampSec)}</span>
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
};

interface SessionHistoryViewProps {
  reports: ShadowingAssessmentReport[];
  localeIndex?: number;
  onDeleteReport: (id: string) => void;
  onSelectReportForReview: (report: ShadowingAssessmentReport) => void;
}

const historyLabels = {
  title: [
    'Personal Shadowing History & Progress',
    'シャドーイング履歴・進捗',
    '個人跟讀歷史與進度',
    '个人跟读历史与进度',
  ],
  subtitle: [
    'Track your Content Accuracy, Pronunciation, Fluency, and Prosody scores across English and Japanese sessions.',
    '英語・日本語セッションの内容正確度・発音・流暢さ・韻律スコアの推移を確認できます。',
    '追蹤英語與日語跟讀練習的內容準確度、發音、流暢度與韻律分數。',
    '跟踪英语与日语跟读练习的内容准确度、发音、流畅度与韵律分数。',
  ],
  emptyTitle: [
    'No shadowing sessions match this view.',
    '該当する練習履歴はまだありません。',
    '目前沒有符合此篩選的跟讀紀錄。',
    '暂无符合此筛选的跟读记录。',
  ],
  emptyDesc: [
    'Complete a Listen-Then-Repeat or Simultaneous shadowing recording in the Practice Studio to generate your first AI diagnostic report.',
    '練習スタジオでシャドーイング録音と評価を完了すると、ここに診断レポートが保存されます。',
    '在練習室完成任一次跟讀錄音與評估，即可在此檢視 AI 診斷報告。',
    '在练习室完成任意一次跟读录音与评估，即可在此查看 AI 诊断报告。',
  ],
  openAndRetry: [
    'Open Report and Try Again',
    'レポートを開いて再挑戦',
    '開啟報告並再試一次',
    '打开报告并再试一次',
  ],
};

export const SessionHistoryView: React.FC<SessionHistoryViewProps> = ({
  reports,
  localeIndex = 0,
  onDeleteReport,
  onSelectReportForReview,
}) => {
  const [filter, setFilter] = useState<'all' | LanguageCode>('all');
  const nonDemoReports = reports.filter((r) => !r.isDemo);
  const visibleReports = nonDemoReports.filter(
    (report) => filter === 'all' || report.language === filter
  );
  const avgScore =
    nonDemoReports.length > 0
      ? Math.round(
          nonDemoReports.reduce((acc, r) => acc + r.overallScore, 0) /
            nonDemoReports.length
        )
      : 0;

  return (
    <div className="space-y-5">
      {/* Unboxed Header matching History.png */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="echo-page-title text-slate-900">
            {historyLabels.title[localeIndex]}
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1 max-w-2xl">
            {historyLabels.subtitle[localeIndex]}
          </p>
        </div>

        {nonDemoReports.length > 0 && (
          <div className="flex items-center gap-6 text-xs">
            <div>
              <span className="text-slate-500 block">Sessions</span>
              <span className="text-lg font-bold font-mono-tabular text-slate-900">
                {nonDemoReports.length}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Avg Score</span>
              <span className="text-lg font-bold font-mono-tabular text-sky-700">
                {avgScore}/100
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="echo-choice" role="group" aria-label="Filter history by language">
        {(['all', 'en', 'ja'] as const).map((language) => (
          <button
            key={language}
            type="button"
            aria-pressed={filter === language}
            onClick={() => setFilter(language)}
            className="text-xs uppercase tracking-wide cursor-pointer"
          >
            {language === 'all' ? vocabLabels.all[localeIndex] : language === 'en' ? 'English' : 'Japanese'}
          </button>
        ))}
      </div>

      {visibleReports.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
          <p className="text-sm font-semibold text-slate-800">
            {historyLabels.emptyTitle[localeIndex]}
          </p>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            {historyLabels.emptyDesc[localeIndex]}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleReports.map((rep) => (
            <article
              key={rep.id}
              className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3 min-w-0"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span>{new Date(rep.createdAt).toLocaleString()}</span>
                    <span aria-hidden="true">·</span>
                    <span>{rep.language === 'ja' ? 'Japanese (日本語)' : 'English'}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {rep.mode === 'listen_repeat' ? 'Listen-Then-Repeat' : 'Simultaneous'}
                    </span>
                  </div>
                  <h3 className="text-base font-bold text-slate-900 break-words">
                    {rep.videoTitle}
                  </h3>
                  {rep.channel && (
                    <p className="text-xs text-slate-500">{rep.channel}</p>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => onDeleteReport(rep.id)}
                  aria-label={`Delete report for ${rep.videoTitle}`}
                  title="Delete session report"
                  className="p-1.5 text-slate-400 hover:text-red-500 rounded-lg transition-colors cursor-pointer shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
                <div className="flex flex-wrap items-center gap-4 text-xs font-mono-tabular">
                  <div>
                    <span className="text-slate-400 block text-[11px]">Overall</span>
                    <span className="font-bold text-slate-900 text-lg">
                      {Math.round(rep.overallScore)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[11px]">Content</span>
                    <span className="text-slate-700 text-sm font-semibold">
                      {Math.round(rep.dimensions.contentAccuracy)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[11px]">Pronunc.</span>
                    <span className="text-slate-700 text-sm font-semibold">
                      {Math.round(rep.dimensions.pronunciation)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[11px]">Fluency</span>
                    <span className="text-slate-700 text-sm font-semibold">
                      {Math.round(rep.dimensions.fluency)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[11px]">Prosody</span>
                    <span className="text-slate-700 text-sm font-semibold">
                      {Math.round(rep.dimensions.prosody)}%
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onSelectReportForReview(rep)}
                  className="px-3.5 py-2 text-xs font-semibold bg-sky-600 hover:bg-sky-700 text-white rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  {historyLabels.openAndRetry[localeIndex]}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
};
