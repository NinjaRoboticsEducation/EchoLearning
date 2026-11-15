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
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < 600 : false
  );
  const [position, setPosition] = useState<{ left: number; top: number }>({
    left: 24,
    top: 96,
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const updateViewport = () => {
      setIsMobileViewport(window.innerWidth < 600);
    };
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  // Position floating window near clicked word (clamped within viewport) on desktop/tablet
  useEffect(() => {
    if (!anchorRect) return;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const cardWidth = Math.min(400, vw - 32);
    const cardHeight = 360;

    let left = anchorRect.x - cardWidth / 2;
    let top = anchorRect.y + 22;

    if (left + cardWidth > vw - 16) {
      left = vw - cardWidth - 16;
    }
    if (left < 16) {
      left = 16;
    }
    if (top + cardHeight > vh - 16) {
      top = Math.max(72, anchorRect.y - cardHeight - 16);
    }

    setPosition({ left, top });
  }, [anchorRect]);

  useEffect(() => {
    if (!isDragging || isMobileViewport) return;
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
  }, [isDragging, isMobileViewport]);

  // Escape key closes dictionary popover (U05)
  useEffect(() => {
    if (!selectedWord && !isLoading && !lookupResult) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedWord, isLoading, lookupResult, onClose]);

  if (!selectedWord && !isLoading && !lookupResult) {
    return null;
  }

  const handleMouseDownHeader = (e: React.MouseEvent) => {
    if (isMobileViewport) return;
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
      style={
        isMobileViewport
          ? undefined
          : {
              left: `${position.left}px`,
              top: `${position.top}px`,
            }
      }
      role="dialog"
      aria-label="Floating Contextual Dictionary"
      className={
        isMobileViewport
          ? 'fixed inset-x-0 bottom-0 z-50 rounded-t-2xl max-h-[65vh] overflow-y-auto bg-[#1e2331] text-[#eef1fa] border-t border-[#525a6d] shadow-2xl p-4'
          : 'fixed z-50 w-[360px] sm:w-[400px] max-h-[82vh] overflow-y-auto bg-[#1e2331] text-[#eef1fa] border border-[#525a6d] rounded-xl shadow-2xl p-4 transition-opacity'
      }
    >
      {/* Draggable Floating Header Bar */}
      <div
        onMouseDown={handleMouseDownHeader}
        className={`flex items-center justify-between gap-2 pb-2 mb-2.5 border-b border-[#525a6d]/60 select-none ${
          isMobileViewport ? '' : 'cursor-move'
        }`}
      >
        <div className="flex items-center gap-1.5 text-xs text-[#b8c1d4] min-w-0">
          {!isMobileViewport && <GripHorizontal className="w-3.5 h-3.5 text-[#b8c1d4] shrink-0" />}
          <span className="font-semibold text-[#eef1fa]">Live Dictionary</span>
          {lookupResult && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-medium text-[#c3bbff] truncate">{lookupResult.partOfSpeech}</span>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close floating dictionary"
          className="p-1 text-[#b8c1d4] hover:text-white hover:bg-[#332b57] rounded-md transition-colors cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Word Title & Action Buttons */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h3 className="text-lg font-bold text-[#eef1fa] flex flex-wrap items-baseline gap-1.5 break-words">
            <span>{lookupResult?.word || selectedWord}</span>
            {lookupResult?.reading && lookupResult.reading !== lookupResult.word && (
              <span className="text-sm font-normal text-[#c3bbff]">
                【{lookupResult.reading}】
              </span>
            )}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#b8c1d4] mt-0.5">
            {lookupResult?.ipa && (
              <span className="font-mono-tabular text-[#eef1fa] bg-[#151925] border border-[#525a6d]/60 px-1.5 py-0.5 rounded">
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
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-[#151925] hover:bg-[#262d40] text-[#eef1fa] border border-[#525a6d] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {isPlayingTts ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#c3bbff]" />
              ) : (
                <Volume2 className="w-3.5 h-3.5 text-[#c3bbff]" />
              )}
              <span>Listen</span>
            </button>

            <button
              type="button"
              onClick={() => onSaveWord(lookupResult)}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                isSaved
                  ? 'bg-[#133328] text-[#6ee7b7] border border-[#235c47]'
                  : 'bg-[#c3bbff] hover:bg-[#d4ceff] text-[#151925]'
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
        <div className="py-6 flex items-center justify-center gap-2 text-xs text-[#b8c1d4]">
          <Loader2 className="w-4 h-4 animate-spin text-[#c3bbff]" />
          <span>Looking up "{selectedWord}" in English/Japanese dictionary...</span>
        </div>
      )}

      {error && !isLoading && (
        <div role="alert" className="py-2 text-xs text-[#fda4af]">
          {error}
        </div>
      )}

      {ttsError && <div className="mb-2 text-xs text-[#fcd34d]">{ttsError}</div>}

      {lookupResult && !isLoading && (
        <div className="space-y-3 text-xs">
          {lookupResult.contextualMeaning && (
            <div className="p-2.5 bg-[#332b57] border border-[#c3bbff]/30 rounded-lg">
              <div className="font-semibold text-[#c3bbff] mb-0.5 flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 text-[#c3bbff]" />
                <span>Meaning &amp; Translation</span>
              </div>
              <p className="text-[#eef1fa] leading-relaxed">
                {lookupResult.contextualMeaning}
              </p>
            </div>
          )}

          {lookupResult.dictionaryDefinitions?.length > 0 && (
            <div className="p-2.5 bg-[#151925] border border-[#525a6d]/70 rounded-lg">
              <div className="font-semibold text-[#eef1fa] mb-1.5 flex items-center gap-1.5">
                <BookOpen className="w-3.5 h-3.5 text-[#c3bbff]" />
                <span>
                  {lookupResult.language === 'ja'
                    ? 'Japanese–English Dictionary (Jisho)'
                    : 'English–Japanese Dictionary'}
                </span>
              </div>
              <ul className="list-disc list-inside space-y-1 text-[#d4d7e1]">
                {lookupResult.dictionaryDefinitions.map((def, i) => (
                  <li key={i} className="leading-relaxed">
                    {def}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {lookupResult.conversationExamples && lookupResult.conversationExamples.length > 0 ? (
            <div className="p-2.5 bg-[#151925] border border-[#525a6d]/70 rounded-lg">
              <div className="font-semibold text-[#c3bbff] mb-1.5 flex items-center gap-1.5">
                <MessagesSquare className="w-3.5 h-3.5 text-[#c3bbff]" />
                <span>Bilingual Examples</span>
              </div>
              <div className="space-y-2">
                {lookupResult.conversationExamples.map((ex, i) => (
                  <div key={i} className="text-[#eef1fa] pl-2 border-l-2 border-[#c3bbff]">
                    <div className="font-medium text-[#eef1fa] leading-snug">
                      {ex.sentence}
                    </div>
                    {ex.translation && (
                      <div className="text-[11px] text-[#b8c1d4] mt-0.5">
                        {ex.translation}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : lookupResult.usageExample ? (
            <div className="p-2.5 bg-[#151925] border border-[#525a6d]/70 rounded-lg">
              <div className="font-semibold text-[#c3bbff] mb-1 flex items-center gap-1.5">
                <MessagesSquare className="w-3.5 h-3.5 text-[#c3bbff]" />
                <span>Usage Example</span>
              </div>
              <div className="font-medium text-[#eef1fa] leading-snug">
                {lookupResult.usageExample}
              </div>
              {lookupResult.usageExampleTranslation && (
                <div className="text-[11px] text-[#b8c1d4] mt-0.5">
                  {lookupResult.usageExampleTranslation}
                </div>
              )}
            </div>
          ) : null}

          {(hasGenuinePitchAccent || lookupResult.pronunciationTip) && (
            <div className="p-2.5 bg-[#151925] border border-[#525a6d]/60 rounded-lg space-y-1 text-[11px]">
              {hasGenuinePitchAccent && (
                <div>
                  <span className="text-[#b8c1d4] font-medium">
                    {lookupResult.language === 'ja' ? 'Pitch Accent: ' : 'Stress Pattern: '}
                  </span>
                  <span className="text-[#eef1fa] font-semibold">
                    {lookupResult.pitchAccent}
                  </span>
                </div>
              )}
              {lookupResult.pronunciationTip && (
                <div className="text-[#d4d7e1]">
                  <span className="text-[#b8c1d4] font-medium">Pronunciation Tip: </span>
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
