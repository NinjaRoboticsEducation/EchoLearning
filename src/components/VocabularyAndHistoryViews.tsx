import React, { useState } from 'react';
import {
  BookMarked,
  Clock,
  Download,
  History,
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
  onRemoveItem: (id: string) => void;
  onExportCsv: () => void;
  onJumpToVideoSegment: (videoId: string, timestampSec: number) => void;
}

export const VocabularyVaultView: React.FC<VocabularyVaultViewProps> = ({
  items,
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
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <BookMarked className="w-5 h-5 text-sky-600" />
            <span>Personal Vocabulary Vault</span>
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Review contextual English and Japanese words saved from your shadowing transcripts, complete with Furigana, IPA, and source video timestamps.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search word, reading, meaning..."
              className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-sky-600"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(['all', 'en', 'ja'] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => setFilterLang(lang)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  filterLang === lang
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {lang === 'all' ? 'All' : lang === 'en' ? 'English' : '日本語'}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onExportCsv}
            disabled={items.length === 0}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-40"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Anki CSV ({items.length})</span>
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-2">
          <p className="text-sm font-semibold text-slate-800">
            No saved vocabulary words match your filter yet.
          </p>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            In the Practice Studio, click any unfamiliar English or Japanese word in the transcript to view its contextual definition and save it to your Vault.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((item) => (
            <div
              key={item.id}
              className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-3"
            >
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[11px] text-slate-500">
                      {item.language === 'ja' ? 'Japanese · 日本語' : 'English'} · {item.partOfSpeech}
                    </div>
                    <h3 className="text-lg font-bold text-slate-900 flex items-baseline gap-2 mt-0.5">
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

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handlePlayWord(item)}
                      disabled={playingId === item.id}
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
                      title="Remove from Vault"
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <p className="text-xs text-slate-800 leading-relaxed bg-sky-50/60 p-2.5 rounded-lg border border-sky-100">
                  {item.contextualMeaning}
                </p>

                <div className="text-xs text-slate-600">
                  <span className="font-medium text-slate-700">Context: </span>
                  "{item.sourceSentence}"
                </div>
              </div>

              <div className="pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                <span className="truncate max-w-[180px]" title={item.videoTitle}>
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

interface SessionHistoryViewProps {
  reports: ShadowingAssessmentReport[];
  onDeleteReport: (id: string) => void;
  onSelectReportForReview: (report: ShadowingAssessmentReport) => void;
}

export const SessionHistoryView: React.FC<SessionHistoryViewProps> = ({
  reports,
  onDeleteReport,
  onSelectReportForReview,
}) => {
  const [filter, setFilter] = useState<'all' | LanguageCode>('all');
  const visibleReports = reports.filter((report) => filter === 'all' || report.language === filter);
  const avgScore =
    reports.length > 0
      ? Math.round(reports.reduce((acc, r) => acc + r.overallScore, 0) / reports.length)
      : 0;

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <History className="w-5 h-5 text-sky-600" />
            <span>Shadowing Session History &amp; Progress</span>
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Track your Content Accuracy, Pronunciation, Fluency, and Prosody scores across English and Japanese sessions.
          </p>
        </div>

        {reports.length > 0 && (
          <div className="flex items-center gap-6 text-xs">
            <div>
              <span className="text-slate-500 block">Completed Sessions</span>
              <span className="text-lg font-bold font-mono-tabular text-slate-900">
                {reports.length}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Average Overall Score</span>
              <span className="text-lg font-bold font-mono-tabular text-sky-700">
                {avgScore}/100
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="echo-choice" role="group" aria-label="Filter history by language">
        {(['all', 'en', 'ja'] as const).map((language) => (
          <button key={language} type="button" aria-pressed={filter === language}
            onClick={() => setFilter(language)}>
            {language === 'all' ? 'All' : language === 'en' ? 'English' : 'Japanese'}
          </button>
        ))}
      </div>
      {visibleReports.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-2">
          <p className="text-sm font-semibold text-slate-800">
            No shadowing sessions match this view.
          </p>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Complete a Listen-Then-Repeat or Simultaneous shadowing recording in the Practice Studio to generate your first AI diagnostic report.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleReports.map((rep) => (
            <div
              key={rep.id}
              className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4"
            >
              <div className="space-y-1 max-w-2xl">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <Clock className="w-3.5 h-3.5 text-slate-400" />
                  <span>{new Date(rep.createdAt).toLocaleString()}</span>
                  <span aria-hidden="true">·</span>
                  <span>{rep.language === 'ja' ? 'Japanese (日本語)' : 'English'}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {rep.mode === 'listen_repeat' ? 'Listen-Then-Repeat' : 'Simultaneous'}
                  </span>
                </div>
                <h3 className="text-sm font-bold text-slate-900">{rep.videoTitle}</h3>
                <p className="text-xs text-slate-700 line-clamp-1">"{rep.targetText}"</p>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-3 text-xs font-mono-tabular">
                  <div>
                    <span className="text-slate-400 block text-[10px]">Overall</span>
                    <span className="font-bold text-slate-900 text-sm">
                      {Math.round(rep.overallScore)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">Content</span>
                    <span className="text-slate-700">
                      {Math.round(rep.dimensions.contentAccuracy)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">Pronunc.</span>
                    <span className="text-slate-700">
                      {Math.round(rep.dimensions.pronunciation)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">Fluency</span>
                    <span className="text-slate-700">
                      {Math.round(rep.dimensions.fluency)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">Prosody</span>
                    <span className="text-slate-700">
                      {Math.round(rep.dimensions.prosody)}%
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectReportForReview(rep)}
                    className="px-3 py-1.5 text-xs font-semibold bg-sky-600 hover:bg-sky-700 text-white rounded-lg transition-colors cursor-pointer"
                  >
                    Open Report and Try Again
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteReport(rep.id)}
                    title="Delete session report"
                    className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
