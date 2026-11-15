import type {
  DictionaryLookupResult,
  SavedVocabularyItem,
  ShadowingAssessmentReport,
  VideoMaterial,
} from '../types';

const VOCAB_STORAGE_KEY = 'echosense_vocabulary_v1';
const HISTORY_STORAGE_KEY = 'echosense_history_v1';
const CUSTOM_VIDEOS_KEY = 'echosense_custom_videos_v1';
const DICT_CACHE_KEY = 'echosense_dict_cache_v1';

const STUDY_KEY = 'echolearning_study_v2';

interface StudyData {
  vocabulary: SavedVocabularyItem[];
  history: ShadowingAssessmentReport[];
  materials: VideoMaterial[];
}

function readLegacy<T>(key: string): T[] {
  const raw = localStorage.getItem(key);
  const data: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(data)) throw new Error('The saved study data has an invalid format.');
  return data;
}

function loadStudy(): StudyData {
  const current = localStorage.getItem(STUDY_KEY);
  if (current) return JSON.parse(current);
  return {
    vocabulary: readLegacy(VOCAB_STORAGE_KEY),
    history: readLegacy(HISTORY_STORAGE_KEY),
    materials: readLegacy(CUSTOM_VIDEOS_KEY),
  };
}

function updateStudy<K extends keyof StudyData>(key: K, update: (items: StudyData[K]) => StudyData[K]): StudyData[K] {
  const current = loadStudy();
  const updated = update(current[key]);
  localStorage.setItem(STUDY_KEY, JSON.stringify({ ...current, [key]: updated }));
  return updated;
}

export function loadSavedVocabulary() { return loadStudy().vocabulary; }
export function loadPracticeHistory() { return loadStudy().history; }
export function loadCustomVideos() { return loadStudy().materials; }

function vocabularyKey(item: SavedVocabularyItem) {
  return JSON.stringify([item.language, item.word.normalize('NFC').toLowerCase()]);
}

export function saveVocabularyItem(item: SavedVocabularyItem) {
  return updateStudy('vocabulary', (items) => [item, ...items.filter((other) => vocabularyKey(other) !== vocabularyKey(item))]);
}

export function removeVocabularyItem(id: string) {
  return updateStudy('vocabulary', (items) => items.filter((item) => item.id !== id));
}

export function savePracticeReport(report: ShadowingAssessmentReport) {
  const { audioDataUrl, ...metadata } = report;
  return updateStudy('history', (items) => [metadata, ...items.filter((item) => item.id !== report.id)]);
}

export function deletePracticeReport(id: string) {
  return updateStudy('history', (items) => items.filter((item) => item.id !== id));
}

export function saveCustomVideo(video: VideoMaterial) {
  return updateStudy('materials', (items) => [video, ...items.filter((item) => item.videoId !== video.videoId)]);
}

export function getCachedDictionaryLookup(key: string): DictionaryLookupResult | null {
  try {
    const raw = localStorage.getItem(DICT_CACHE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, DictionaryLookupResult>;
    return map[key] || null;
  } catch {
    return null;
  }
}

export function setCachedDictionaryLookup(key: string, result: DictionaryLookupResult): void {
  try {
    const raw = localStorage.getItem(DICT_CACHE_KEY);
    const map: Record<string, DictionaryLookupResult> = raw ? JSON.parse(raw) : {};
    map[key] = result;
    const keys = Object.keys(map);
    if (keys.length > 150) {
      delete map[keys[0]];
    }
    localStorage.setItem(DICT_CACHE_KEY, JSON.stringify(map));
  } catch {
    // Ignore
  }
}

export function exportVocabularyToCsv(items: SavedVocabularyItem[]): void {
  const headers = [
    'Word',
    'Lemma',
    'Language',
    'Reading / IPA',
    'Romaji',
    'Part of Speech',
    'Contextual Meaning',
    'Dictionary Definitions',
    'Source Sentence',
    'Video Title',
    'Timestamp (s)',
  ];
  const escapeCsv = (val: string | number | undefined) => {
    const str = String(val ?? '').replace(/"/g, '""');
    return `"${str}"`;
  };
  const rows = items.map((item) =>
    [
      item.word,
      item.lemma,
      item.language.toUpperCase(),
      item.language === 'ja' ? item.reading : item.ipa || item.reading,
      item.romaji || '',
      item.partOfSpeech,
      item.contextualMeaning,
      item.dictionaryDefinitions.join(' | '),
      item.sourceSentence,
      item.videoTitle,
      item.timestampSec.toFixed(1),
    ]
      .map(escapeCsv)
      .join(',')
  );

  const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `echosense-vocabulary-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportAllStudyDataJson(
  vocabulary: SavedVocabularyItem[],
  history: ShadowingAssessmentReport[]
): void {
  const payload = {
    format: 'echolearning-study',
    schemaVersion: 2,
    materials: loadCustomVideos(),
    exportedAt: new Date().toISOString(),
    app: 'Echo Language Learning',
    vocabularyCount: vocabulary.length,
    sessionCount: history.length,
    vocabulary,
    history: history.map(({ audioDataUrl, ...rest }) => rest),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `echosense-study-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

type RecordValue = Record<string, unknown>;

function object(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(record: RecordValue, keys: string[]): boolean {
  return keys.every((key) => typeof record[key] === 'string');
}

function numbers(record: RecordValue, keys: string[]): boolean {
  return keys.every((key) => typeof record[key] === 'number' && Number.isFinite(record[key]));
}

function textList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function learningLanguage(record: RecordValue) {
  return record.language === 'ja' || record.language === 'en';
}

function validateRows<T>(value: unknown, label: string, test: (item: RecordValue) => boolean): T[] {
  if (!Array.isArray(value) || !value.every((item) => object(item) && test(item))) {
    throw new Error(`Invalid ${label} in the backup. No records were imported.`);
  }
  return value as T[];
}

export async function previewStudyBackup(file: File): Promise<StudyData> {
  if (file.size > 10 * 1024 * 1024) throw new Error('Choose a JSON backup smaller than 10 MiB.');
  const data: unknown = JSON.parse(await file.text());
  if (!object(data) || !(data.format === 'echolearning-study' && data.schemaVersion === 2 ||
    data.app === 'Echo Language Learning' && data.schemaVersion === undefined)) {
    throw new Error('This EchoLearning backup format is unsupported.');
  }

  return {
    vocabulary: validateRows(data.vocabulary, 'vocabulary', (row) =>
      learningLanguage(row) &&
      strings(row, ['id', 'word', 'lemma', 'reading', 'partOfSpeech', 'contextualMeaning', 'sourceSentence', 'videoId', 'videoTitle', 'createdAt']) &&
      numbers(row, ['timestampSec']) && textList(row.dictionaryDefinitions) &&
      ['romaji', 'ipa', 'pitchAccent'].every((key) => row[key] === undefined || typeof row[key] === 'string')),
    history: validateRows<ShadowingAssessmentReport>(data.history, 'reports', (row) =>
      learningLanguage(row) && (row.mode === 'listen_repeat' || row.mode === 'simultaneous') &&
      strings(row, ['id', 'videoId', 'videoTitle', 'createdAt', 'targetText', 'recognizedTranscript', 'scoreExplanation']) &&
      numbers(row, ['overallScore']) && textList(row.segmentIds) && object(row.dimensions) &&
      numbers(row.dimensions, ['contentAccuracy', 'pronunciation', 'fluency', 'prosody']) &&
      object(row.metrics) && numbers(row.metrics, ['speechRateValue', 'targetRateValue', 'durationSec', 'targetDurationSec', 'omittedCount', 'substitutedCount', 'uncertainSttCount']) &&
      textList(row.improvementSuggestions) &&
      Array.isArray(row.wordDiff) && row.wordDiff.every((token) => object(token) && strings(token, ['word', 'status'])) &&
      Array.isArray(row.pronunciationFeedback) && row.pronunciationFeedback.every((feedback) => object(feedback) &&
        strings(feedback, ['targetWord', 'readingOrIpa', 'category', 'observedIssue', 'actionableTip', 'severity'])))
      .map(({ audioDataUrl, ...report }) => report),
    materials: validateRows(data.schemaVersion === 2 ? data.materials : [], 'materials', (row) =>
      learningLanguage(row) && strings(row, ['videoId', 'title', 'channel', 'level', 'captionSource', 'captionNote']) &&
      typeof row.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(row.videoId) &&
      numbers(row, ['durationSec']) && Array.isArray(row.segments) && row.segments.every((segment) =>
        object(segment) && strings(segment, ['id', 'text']) && numbers(segment, ['index', 'startTime', 'endTime']) &&
        (segment.tokens === undefined || Array.isArray(segment.tokens) && segment.tokens.every((token) =>
          object(token) && strings(token, ['surface']) &&
          ['reading', 'romaji', 'ipa', 'lemma', 'pos', 'meaningHint'].every((key) =>
            token[key] == null || typeof token[key] === 'string'))))),
  };
}

function mergeUnique<T>(current: T[], imported: T[], key: (item: T) => string): T[] {
  const seen = new Set(current.map(key));
  return [...current, ...imported.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  })];
}

export function restoreStudyBackup(backup: StudyData): StudyData {
  const current = loadStudy();
  const merged = {
    vocabulary: mergeUnique(current.vocabulary, backup.vocabulary, vocabularyKey),
    history: mergeUnique(current.history, backup.history, (report) => report.id),
    materials: mergeUnique(current.materials, backup.materials, (material) => material.videoId),
  };
  localStorage.setItem(STUDY_KEY, JSON.stringify(merged));
  return merged;
}
