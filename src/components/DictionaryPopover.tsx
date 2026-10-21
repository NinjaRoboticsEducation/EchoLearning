import React, { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  BookmarkCheck,
  BookmarkPlus,
  GripHorizontal,
  Loader2,
  MessagesSquare,
  Sparkles,
  Volume2,
  X,
} from 'lucide-react';
import { DictionaryLookupResult } from '../types';

interface DictionaryPopoverProps {
  lookupResult: DictionaryLookupResult | null;
  isLoading: boolean;
  error: string | null;
  selectedWord: string | null;
  anchorRect: { x: number; y: number } | null;
  isSaved: boolean;
  onClose: () => void;
  onSaveWord: (entry: DictionaryLookupResult) => void;
}

export const DictionaryPopover: React.FC<DictionaryPopoverProps> = ({
  lookupResult,
  isLoading,
  error,
  selectedWord,
  anchorRect,
  isSaved,
  onClose,
  onSaveWord,
}) => {
  const [isPlayingTts, setIsPlayingTts] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({
    left: 24,
    top: 96,
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Position floating window near clicked word (clamped within viewport) when a new word is clicked
  useEffect(() => {
    if (!anchorRect) return;
    const cardWidth = 380;
    const cardHeight = 360;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;

    let left = anchorRect.x - cardWidth / 2;
    let top = anchorRect.y + 22;

    if (left + cardWidth > vw - 16) {
      left = vw - cardWidth - 16;
    }
    if (left < 16) {
      left = 16;
    }
    // If placing below the word overflows bottom of viewport, place it above the clicked word
    if (top + cardHeight > vh - 16) {
      top = Math.max(72, anchorRect.y - cardHeight - 16);
    }

    setPosition({ left, top });
  }, [anchorRect]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const newLeft = Math.max(12, Math.min(vw - 360, e.clientX - dragOffsetRef.current.dx));
      const newTop = Math.max(60, Math.min(vh - 120, e.clientY - dragOffsetRef.current.dy));
      setPosition({ left: newLeft, top: newTop });
    };
    const handleMouseUp = () => {
      setIsDragging(false);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  if (!selectedWord && !isLoading && !lookupResult) {
    return null;
  }

  const handleMouseDownHeader = (e: React.MouseEvent) => {
    setIsDragging(true);
    dragOffsetRef.current = {
      dx: e.clientX - position.left,
      dy: e.clientY - position.top,
    };
  };

  const handlePlayReferenceAudio = async (textToSpeak: string, lang: 'en' | 'ja') => {
    if (isPlayingTts) return;
    setIsPlayingTts(true);
    setTtsError(null);
    try {
      const response = await fetch('/api/tts/pronounce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textToSpeak, language: lang }),
      });
      const data = await response.json();
      if (!response.ok || !data.audioBase64) {
        throw new Error(data.error || 'Could not synthesize pronunciation audio.');
      }
      const audio = new Audio(
        `data:${data.mimeType || 'audio/wav'};base64,${data.audioBase64}`
      );
      audio.onended = () => setIsPlayingTts(false);
      audio.onerror = () => {
        setIsPlayingTts(false);
        setTtsError('Audio playback failed in browser.');
      };
      await audio.play();
    } catch (err: any) {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          const u = new SpeechSynthesisUtterance(textToSpeak);
          u.lang = lang === 'ja' ? 'ja-JP' : 'en-US';
          u.onend = () => setIsPlayingTts(false);
          u.onerror = () => setIsPlayingTts(false);
          window.speechSynthesis.speak(u);
          return;
        } catch {
          // Ignore
        }
      }
      setIsPlayingTts(false);
      setTtsError(err?.message || 'TTS unavailable');
    }
  };

  const hasGenuinePitchAccent = Boolean(
    lookupResult?.pitchAccent &&
      lookupResult.pitchAccent !== 'Standard Accent' &&
      lookupResult.pitchAccent !== 'Primary Stress'
  );

  return (
    <div
      ref={cardRef}
      style={{
        left: `${position.left}px`,
        top: `${position.top}px`,
      }}
      role="dialog"
      aria-label="Floating Contextual Dictionary"
      className="fixed z-50 w-[360px] sm:w-[400px] max-h-[82vh] overflow-y-auto bg-white/95 backdrop-blur-md border border-slate-300 rounded-xl shadow-2xl p-4 transition-opacity"
    >
      {/* Draggable Floating Header Bar */}
      <div
        onMouseDown={handleMouseDownHeader}
        className="flex items-center justify-between gap-2 pb-2 mb-2.5 border-b border-slate-100 cursor-move select-none"
      >
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <GripHorizontal className="w-3.5 h-3.5 text-slate-400" />
          <span className="font-semibold text-slate-700">Floating Dictionary</span>
          {lookupResult && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-medium text-sky-800">{lookupResult.partOfSpeech}</span>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close floating dictionary"
          className="p-1 text-slate-400 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Word Title & Action Buttons */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-lg font-bold text-slate-900 flex flex-wrap items-baseline gap-1.5">
            <span>{lookupResult?.word || selectedWord}</span>
            {lookupResult?.reading && (
              <span className="text-sm font-normal text-sky-700">
                【{lookupResult.reading}】
              </span>
            )}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-0.5">
            {lookupResult?.ipa && (
              <span className="font-mono-tabular text-slate-600 bg-slate-100 px-1 py-0.5 rounded">
                {lookupResult.ipa}
              </span>
            )}
            {lookupResult?.romaji && (
              <span className="font-mono-tabular">({lookupResult.romaji})</span>
            )}
            {lookupResult?.lemma && lookupResult.lemma !== lookupResult.word && (
              <span>Base: {lookupResult.lemma}</span>
            )}
          </div>
        </div>

        {lookupResult && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() =>
                handlePlayReferenceAudio(lookupResult.word, lookupResult.language)
              }
              disabled={isPlayingTts}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {isPlayingTts ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-600" />
              ) : (
                <Volume2 className="w-3.5 h-3.5 text-sky-600" />
              )}
              <span>Listen</span>
            </button>

            <button
              type="button"
              onClick={() => onSaveWord(lookupResult)}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                isSaved
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'bg-sky-600 hover:bg-sky-700 text-white'
              }`}
            >
              {isSaved ? (
                <>
                  <BookmarkCheck className="w-3.5 h-3.5" />
                  <span>Saved</span>
                </>
              ) : (
                <>
                  <BookmarkPlus className="w-3.5 h-3.5" />
                  <span>Save</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {isLoading && (
        <div className="py-6 flex items-center justify-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
          <span>Searching English-Japanese dictionary for "{selectedWord}"...</span>
        </div>
      )}

      {error && !isLoading && (
        <div className="py-2 text-xs text-red-600">{error}</div>
      )}

      {ttsError && <div className="mb-2 text-xs text-amber-700">{ttsError}</div>}

      {lookupResult && !isLoading && (
        <div className="space-y-3 text-xs">
          {/* English-Japanese Dictionary Definitions */}
          {lookupResult.dictionaryDefinitions?.length > 0 && (
            <div className="p-2.5 bg-slate-50 border border-slate-200/80 rounded-lg">
              <div className="font-semibold text-slate-800 mb-1.5 flex items-center gap-1.5">
                <BookOpen className="w-3.5 h-3.5 text-sky-600" />
                <span>
                  {lookupResult.language === 'ja'
                    ? 'English-Japanese Dictionary'
                    : 'Dictionary Definitions'}
                </span>
              </div>
              <ul className="list-disc list-inside space-y-1 text-slate-700">
                {lookupResult.dictionaryDefinitions.map((def, i) => (
                  <li key={i} className="leading-relaxed">
                    {def}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Meaning in Video Context */}
          {lookupResult.contextualMeaning && (
            <div className="p-2.5 bg-sky-50/80 border border-sky-100 rounded-lg">
              <div className="font-semibold text-sky-950 mb-0.5 flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 text-sky-600" />
                <span>Meaning in This Context</span>
              </div>
              <p className="text-slate-800 leading-relaxed">
                {lookupResult.contextualMeaning}
              </p>
            </div>
          )}

          {/* Conversational Usage Examples */}
          {lookupResult.conversationExamples && lookupResult.conversationExamples.length > 0 ? (
            <div className="p-2.5 bg-amber-50/70 border border-amber-200/80 rounded-lg">
              <div className="font-semibold text-amber-950 mb-1.5 flex items-center gap-1.5">
                <MessagesSquare className="w-3.5 h-3.5 text-amber-600" />
                <span>Conversational Examples</span>
              </div>
              <div className="space-y-2">
                {lookupResult.conversationExamples.map((ex, i) => (
                  <div key={i} className="text-slate-800 pl-1 border-l-2 border-amber-300">
                    <div className="font-medium text-slate-900 leading-snug">
                      {ex.sentence}
                    </div>
                    <div className="text-[11px] text-slate-600 mt-0.5">
                      {ex.translation}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : lookupResult.usageExample ? (
            <div className="p-2.5 bg-amber-50/70 border border-amber-200/80 rounded-lg">
              <div className="font-semibold text-amber-950 mb-1 flex items-center gap-1.5">
                <MessagesSquare className="w-3.5 h-3.5 text-amber-600" />
                <span>Conversational Example</span>
              </div>
              <div className="font-medium text-slate-900 leading-snug">
                {lookupResult.usageExample}
              </div>
              {lookupResult.usageExampleTranslation && (
                <div className="text-[11px] text-slate-600 mt-0.5">
                  {lookupResult.usageExampleTranslation}
                </div>
              )}
            </div>
          ) : null}

          {/* Pitch Accent & Pronunciation Tip (Only when genuine info is present) */}
          {(hasGenuinePitchAccent || lookupResult.pronunciationTip) && (
            <div className="p-2 bg-slate-50 border border-slate-200/70 rounded-lg space-y-1 text-[11px]">
              {hasGenuinePitchAccent && (
                <div>
                  <span className="text-slate-500 font-medium">
                    {lookupResult.language === 'ja' ? 'Pitch Accent: ' : 'Stress Pattern: '}
                  </span>
                  <span className="text-slate-900 font-semibold">
                    {lookupResult.pitchAccent}
                  </span>
                </div>
              )}
              {lookupResult.pronunciationTip && (
                <div className="text-slate-700">
                  <span className="text-slate-500 font-medium">Pronunciation Tip: </span>
                  {lookupResult.pronunciationTip}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

