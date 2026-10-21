export type LanguageCode = 'en' | 'ja';

export type CaptionSourceType =
  | 'curated_verified'
  | 'youtube_manual'
  | 'youtube_asr'
  | 'ai_generated'
  | 'user_aligned';

export interface WordToken {
  surface: string;
  reading?: string; // Hiragana reading (Furigana) for Japanese Kanji words
  romaji?: string;  // Hepburn Romaji for Japanese tokens
  ipa?: string;     // IPA phonetic hint for English tokens
  lemma?: string;   // Dictionary base form
  pos?: string;     // Part of speech
  isKanji?: boolean;
  meaningHint?: string; // Brief contextual gloss
}

export interface TranscriptSegment {
  id: string;
  index: number;
  startTime: number; // Seconds
  endTime: number;   // Seconds
  text: string;
  translation?: string;
  tokens?: WordToken[];
}

export interface VideoMaterial {
  videoId: string;
  title: string;
  channel: string;
  language: LanguageCode;
  level: string;
  durationSec: number;
  captionSource: CaptionSourceType;
  captionNote: string;
  description?: string;
  segments: TranscriptSegment[];
}

export interface DictionaryLookupResult {
  word: string;
  lemma: string;
  language: LanguageCode;
  reading: string;       // Hiragana for JA, or phonetic spelling for EN
  romaji?: string;       // Romaji for JA
  ipa?: string;          // IPA for EN (or phonetic JA)
  pitchAccent?: string;  // e.g. "Heiban [0] (平板型)" or stress pattern for EN
  partOfSpeech: string;
  contextualMeaning: string;
  dictionaryDefinitions: string[];
  usageExample: string;
  usageExampleTranslation: string;
  pronunciationTip: string;
}

export type DiffTokenStatus =
  | 'correct'
  | 'omitted'
  | 'substituted'
  | 'inserted'
  | 'stt_uncertain';

export interface DiffToken {
  word: string;
  expectedWord?: string;
  reading?: string;
  status: DiffTokenStatus;
  explanation?: string;
}

export interface PhonemeFeedbackItem {
  targetWord: string;
  readingOrIpa: string;
  category: string; // e.g., "Consonant Articulation", "Vowel Length (長音)", "Pitch & Stress"
  observedIssue: string;
  actionableTip: string;
  severity: 'high' | 'medium' | 'low';
}

export type ShadowingMode = 'listen_repeat' | 'simultaneous';

export interface ShadowingAssessmentReport {
  id: string;
  videoId: string;
  videoTitle: string;
  language: LanguageCode;
  segmentIds: string[];
  mode: ShadowingMode;
  createdAt: string;
  targetText: string;
  recognizedTranscript: string;
  webSpeechTranscript?: string;
  overallScore: number;
  dimensions: {
    contentAccuracy: number; // Objective lexical match (0-100)
    pronunciation: number;   // Multimodal acoustic articulation score (0-100)
    fluency: number;         // Pacing, pause continuity & smoothness (0-100)
    prosody: number;         // Rhythm, stress timing / mora timing & intonation (0-100)
  };
  metrics: {
    speechRateValue: number;
    speechRateUnit: 'WPM' | 'Moras/min';
    targetRateValue: number;
    durationSec: number;
    targetDurationSec: number;
    omittedCount: number;
    substitutedCount: number;
    uncertainSttCount: number;
  };
  scoreExplanation: string;
  wordDiff: DiffToken[];
  pronunciationFeedback: PhonemeFeedbackItem[];
  improvementSuggestions: string[];
  recommendedRetryText?: string;
  audioDataUrl?: string;
}

export interface SavedVocabularyItem {
  id: string;
  word: string;
  lemma: string;
  language: LanguageCode;
  reading: string;
  romaji?: string;
  ipa?: string;
  pitchAccent?: string;
  partOfSpeech: string;
  contextualMeaning: string;
  dictionaryDefinitions: string[];
  sourceSentence: string;
  videoId: string;
  videoTitle: string;
  timestampSec: number;
  createdAt: string;
}
