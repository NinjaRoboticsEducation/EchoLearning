import React, { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  Edit3,
  Loader2,
  Mic,
  Play,
  Plus,
  Repeat,
  Trash2,
  X,
} from 'lucide-react';
import {
  DiffToken,
  LanguageCode,
  TranscriptSegment,
  WordToken,
} from '../types';
import { formatTimestamp } from './YouTubePlayer';

interface TranscriptReaderProps {
  language: LanguageCode;
  segments: TranscriptSegment[];
  activeSegmentIndex: number;
  selectedSegmentIds: string[];
  loopSegmentId: string | null;
  showFurigana: boolean;
  autoScroll: boolean;
  activeDiffMap: Record<string, DiffToken[]>;
  activeDiffSegmentIds: string[];
  disabledControls?: boolean;
  onSelectSegmentToSeek: (segment: TranscriptSegment) => void;
  onToggleSegmentSelection: (segmentId: string) => void;
  onSelectAllSegments: () => void;
  onToggleLoopSegment: (segment: TranscriptSegment) => void;
  onStartShadowingSegment: (segment: TranscriptSegment) => void;
  onWordClick: (
    word: string,
    sentence: string,
    segment: TranscriptSegment,
    anchorRect: { x: number; y: number },
    token?: WordToken
  ) => void;
  onToggleFurigana: () => void;
  onToggleAutoScroll: () => void;
  onUpdateSegment: (updatedSegment: TranscriptSegment) => void;
  onAddSegmentAfter: (index: number) => void;
  onDeleteSegment: (segmentId: string) => void;
}

function tokenizeFallback(text: string, language: LanguageCode): WordToken[] {
  if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
    const segmenter = new (Intl as any).Segmenter(language, { granularity: 'word' });
    const rawSegments = Array.from(segmenter.segment(text)) as Array<{
      segment: string;
      isWordLike?: boolean;
    }>;
    return rawSegments
      .filter((item) => item.segment && !/^\s+$/.test(item.segment))
      .map((item) => ({
        surface: item.segment,
        isKanji: /[\u4e00-\u9faf]/.test(item.segment),
      }));
  }
  if (language === 'ja') {
    return text.split('').map((ch) => ({
      surface: ch,
      isKanji: /[\u4e00-\u9faf]/.test(ch),
    }));
  }
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ({ surface: w }));
}

export const TranscriptReader: React.FC<TranscriptReaderProps> = ({
  language,
  segments,
  activeSegmentIndex,
  selectedSegmentIds,
  loopSegmentId,
  showFurigana,
  autoScroll,
  disabledControls = false,
  onSelectSegmentToSeek,
  onToggleSegmentSelection,
  onSelectAllSegments,
  onToggleLoopSegment,
  onStartShadowingSegment,
  onWordClick,
  onToggleFurigana,
  onToggleAutoScroll,
  onUpdateSegment,
  onAddSegmentAfter,
  onDeleteSegment,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const segmentRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [draftStartTime, setDraftStartTime] = useState('0');
  const [draftEndTime, setDraftEndTime] = useState('5');
  const [editError, setEditError] = useState<string | null>(null);
  const [isRetokenizing, setIsRetokenizing] = useState(false);

  useEffect(() => {
    if (!autoScroll || activeSegmentIndex < 0 || editingSegmentId) return;
    const activeEl = segmentRefs.current[activeSegmentIndex];
    const container = scrollContainerRef.current;
    if (activeEl && container) {
      const containerRect = container.getBoundingClientRect();
      const activeRect = activeEl.getBoundingClientRect();
      const offset = activeRect.top - containerRect.top - containerRect.height * 0.28;
      const reducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      container.scrollBy({
        top: offset,
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
    }
  }, [activeSegmentIndex, autoScroll, editingSegmentId]);

  const handleStartEdit = (segment: TranscriptSegment) => {
    setEditingSegmentId(segment.id);
    setDraftText(segment.text);
    setDraftStartTime(segment.startTime.toFixed(1));
    setDraftEndTime(segment.endTime.toFixed(1));
    setEditError(null);
  };

  const handleCancelEdit = () => {
    setEditingSegmentId(null);
    setEditError(null);
  };

  const handleSaveEdit = async (segment: TranscriptSegment) => {
    const cleanedText = draftText.trim();
    if (!cleanedText) {
      setEditError('Transcript text cannot be empty.');
      return;
    }

    const newStart = parseFloat(draftStartTime);
    const newEnd = parseFloat(draftEndTime);
    if (!Number.isFinite(newStart) || !Number.isFinite(newEnd) || newStart < 0 || newEnd <= newStart) {
      setEditError('End time must be greater than start time (and both >= 0).');
      return;
    }

    setEditError(null);

    if (cleanedText !== segment.text) {
      setIsRetokenizing(true);
      try {
        const res = await fetch('/api/transcript/retokenize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: cleanedText, language }),
        });
        if (res.ok) {
          const data = await res.json();
          onUpdateSegment({
            ...segment,
            startTime: newStart,
            endTime: newEnd,
            text: cleanedText,
            tokens:
              data.tokens && data.tokens.length > 0
                ? data.tokens
                : tokenizeFallback(cleanedText, language),
          });
          setEditingSegmentId(null);
          setIsRetokenizing(false);
          return;
        }
      } catch {
        // Fallback to local tokenization
      }
      setIsRetokenizing(false);
    }

    onUpdateSegment({
      ...segment,
      startTime: newStart,
      endTime: newEnd,
      text: cleanedText,
      tokens:
        cleanedText !== segment.text
          ? tokenizeFallback(cleanedText, language)
          : segment.tokens,
    });
    setEditingSegmentId(null);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl flex flex-col h-full min-w-0">
      {/* Reader Header & Display Controls */}
      <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen className="w-4 h-4 text-sky-600 shrink-0" />
          <h2 className="text-sm font-semibold text-slate-900 truncate">
            Transcript Reader ({segments.length})
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {language === 'ja' && (
            <button
              type="button"
              aria-pressed={showFurigana}
              onClick={onToggleFurigana}
              className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                showFurigana
                  ? 'bg-[#c3bbff] text-[#151925]'
                  : 'bg-[#151925] text-[#eef1fa] border border-[#525a6d] hover:border-[#c3bbff]'
              }`}
            >
              振り仮名 Furigana
            </button>
          )}
          <button
            type="button"
            aria-pressed={autoScroll}
            onClick={onToggleAutoScroll}
            className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              autoScroll
                ? 'bg-[#c3bbff] text-[#151925]'
                : 'bg-[#151925] text-[#eef1fa] border border-[#525a6d] hover:border-[#c3bbff]'
            }`}
          >
            Auto-Sync
          </button>
        </div>
      </div>

      {/* Sub-bar: Segment Range Selection */}
      <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
        <div className="flex items-center gap-2 min-w-0">
          <span>
            Practice Scope:{' '}
            <strong className="text-slate-900">
              {selectedSegmentIds.length === segments.length
                ? `Full Video (${segments.length} segments)`
                : `${selectedSegmentIds.length} of ${segments.length} selected`}
            </strong>
          </span>
        </div>
        <button
          type="button"
          onClick={onSelectAllSegments}
          disabled={disabledControls}
          className="text-sky-700 hover:text-sky-900 font-medium underline cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
        >
          {selectedSegmentIds.length === segments.length
            ? 'Select Active Only'
            : 'Select All Segments'}
        </button>
      </div>

      {/* Scrollable Synchronized Segments */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto transcript-scroll divide-y divide-slate-100 max-h-[55vh] lg:max-h-[640px]"
      >
        {segments.map((segment, idx) => {
          const isActive = idx === activeSegmentIndex;
          const isSelectedForPractice = selectedSegmentIds.includes(segment.id);
          const isLooping = loopSegmentId === segment.id;
          const isEditingThis = editingSegmentId === segment.id;

          const tokens =
            segment.tokens && segment.tokens.length > 0
              ? segment.tokens
              : tokenizeFallback(segment.text, language);

          const textFieldId = `seg-text-${segment.id}`;
          const startFieldId = `seg-start-${segment.id}`;
          const endFieldId = `seg-end-${segment.id}`;

          return (
            <div
              key={segment.id}
              ref={(el) => {
                segmentRefs.current[idx] = el;
              }}
              className={`p-3 sm:p-4 transition-colors min-w-0 ${
                isActive
                  ? 'bg-[#332b57]'
                  : isSelectedForPractice
                  ? 'bg-[#1e2331] hover:bg-[#262d40]'
                  : 'bg-[#151925]/60 opacity-85 hover:opacity-100 hover:bg-[#262d40]'
              }`}
            >
              {/* Segment Top Meta & Quick Actions */}
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2 min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 min-w-0">
                  <input
                    type="checkbox"
                    checked={isSelectedForPractice}
                    disabled={disabledControls}
                    onChange={() => onToggleSegmentSelection(segment.id)}
                    aria-label={`Include segment ${idx + 1} in shadowing session`}
                    className="rounded border-slate-300 text-sky-600 focus:ring-sky-500 cursor-pointer"
                  />
                  <button
                    type="button"
                    onClick={() => onSelectSegmentToSeek(segment)}
                    className="font-mono-tabular font-medium text-sky-700 hover:text-sky-900 hover:underline flex items-center gap-1 cursor-pointer whitespace-nowrap"
                  >
                    <Play className="w-3 h-3 shrink-0" />
                    <span>
                      {formatTimestamp(segment.startTime)} – {formatTimestamp(segment.endTime)}
                    </span>
                  </button>
                  {isActive && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-sky-800">Playing</span>
                    </>
                  )}
                  {isLooping && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-amber-700">Looping</span>
                    </>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    disabled={disabledControls}
                    onClick={() =>
                      isEditingThis ? handleCancelEdit() : handleStartEdit(segment)
                    }
                    title="Edit or correct this transcript line"
                    className={`px-2 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                      isEditingThis
                        ? 'bg-sky-100 text-sky-900'
                        : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                    }`}
                  >
                    <Edit3 className="w-3 h-3" />
                    <span>{isEditingThis ? 'Editing' : 'Edit'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onToggleLoopSegment(segment)}
                    aria-pressed={isLooping}
                    className={`px-2 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer ${
                      isLooping
                        ? 'bg-amber-100 text-amber-900'
                        : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                    }`}
                  >
                    <Repeat className="w-3 h-3" />
                    <span>{isLooping ? 'Looping' : 'Loop'}</span>
                  </button>

                  <button
                    type="button"
                    disabled={disabledControls}
                    onClick={() => onStartShadowingSegment(segment)}
                    className="px-2.5 py-1 text-xs font-medium bg-slate-900 hover:bg-slate-800 text-white rounded transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    <Mic className="w-3 h-3" />
                    <span>Shadow</span>
                  </button>
                </div>
              </div>

              {/* Inline Transcript Editor Mode vs. Interactive Reader Mode */}
              {isEditingThis ? (
                <div className="mt-2 p-3 bg-white border border-sky-300 rounded-lg space-y-2.5">
                  <div>
                    <label
                      htmlFor={textFieldId}
                      className="block text-[11px] font-semibold text-slate-600 mb-1"
                    >
                      Transcript Line ({language === 'ja' ? 'Japanese · 日本語' : 'English'})
                    </label>
                    <textarea
                      id={textFieldId}
                      rows={2}
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      className="w-full p-2 text-sm bg-slate-50 border border-slate-300 rounded-md focus:outline-none focus:bg-white focus:border-sky-600"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2 max-w-xs">
                    <div>
                      <label
                        htmlFor={startFieldId}
                        className="block text-[11px] font-semibold text-slate-600 mb-1"
                      >
                        Start (s)
                      </label>
                      <input
                        id={startFieldId}
                        type="number"
                        step="0.1"
                        min="0"
                        value={draftStartTime}
                        onChange={(e) => setDraftStartTime(e.target.value)}
                        className="w-full px-2 py-1.5 text-xs font-mono-tabular bg-slate-50 border border-slate-300 rounded-md focus:outline-none focus:border-sky-600"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={endFieldId}
                        className="block text-[11px] font-semibold text-slate-600 mb-1"
                      >
                        End (s)
                      </label>
                      <input
                        id={endFieldId}
                        type="number"
                        step="0.1"
                        min="0.5"
                        value={draftEndTime}
                        onChange={(e) => setDraftEndTime(e.target.value)}
                        className="w-full px-2 py-1.5 text-xs font-mono-tabular bg-slate-50 border border-slate-300 rounded-md focus:outline-none focus:border-sky-600"
                      />
                    </div>
                  </div>

                  {editError && (
                    <p role="alert" className="text-xs text-red-500">
                      {editError}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onAddSegmentAfter(idx)}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
                      >
                        <Plus className="w-3 h-3" />
                        <span>Insert Line Below</span>
                      </button>
                      {segments.length > 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingSegmentId(null);
                            onDeleteSegment(segment.id);
                          }}
                          className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 rounded cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>Delete Line</span>
                        </button>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-md cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                        <span>Cancel</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveEdit(segment)}
                        disabled={isRetokenizing}
                        className="flex items-center gap-1 px-3 py-1 text-xs font-semibold bg-sky-600 hover:bg-sky-700 text-white rounded-md cursor-pointer disabled:opacity-50"
                      >
                        {isRetokenizing ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>Updating...</span>
                          </>
                        ) : (
                          <>
                            <Check className="w-3 h-3" />
                            <span>Save Correction</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  className={`leading-relaxed break-words ${
                    language === 'ja' ? 'text-lg tracking-wide' : 'text-[17px]'
                  } text-slate-900 flex flex-wrap items-baseline gap-x-1 gap-y-1.5`}
                >
                  {tokens.map((tok, tIdx) => {
                    const isPunctuationOnly = /^[.,!?;:"'()「」『』、。！？—-]+$/.test(
                      tok.surface
                    );
                    if (isPunctuationOnly) {
                      return (
                        <span key={tIdx} className="text-slate-500 mr-0.5">
                          {tok.surface}
                        </span>
                      );
                    }

                    const shouldRenderRuby =
                      language === 'ja' &&
                      showFurigana &&
                      tok.reading &&
                      tok.reading !== tok.surface &&
                      /[\u4e00-\u9faf]/.test(tok.surface);

                    return (
                      <button
                        key={tIdx}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          onWordClick(
                            tok.surface,
                            segment.text,
                            segment,
                            { x: rect.left + rect.width / 2, y: rect.bottom },
                            tok
                          );
                        }}
                        className="group relative inline-flex flex-col items-center px-1.5 py-0.5 rounded-md hover:bg-[#c3bbff] focus-visible:outline-2 focus-visible:outline-[#c3bbff] transition-colors cursor-pointer text-left"
                      >
                        {shouldRenderRuby ? (
                          <ruby className="font-medium text-[#eef1fa] group-hover:text-[#151925]!">
                            {tok.surface}
                            <rt className="text-[11px] text-[#b8c1d4] group-hover:text-[#151925]!">
                              {tok.reading}
                            </rt>
                          </ruby>
                        ) : (
                          <span className="font-medium text-[#eef1fa] group-hover:text-[#151925]! border-b border-transparent group-hover:border-[#151925]/40">
                            {tok.surface}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
