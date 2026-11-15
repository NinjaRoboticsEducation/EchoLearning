import type {
  DictionaryLookupResult,
  SavedMaterial,
  SavedVocabularyItem,
  ShadowingAssessmentReport,
  VideoMaterial,
  WordToken,
} from '../types';

const VOCAB_STORAGE_KEY = 'echosense_vocabulary_v1';
const HISTORY_STORAGE_KEY = 'echosense_history_v1';
const CUSTOM_VIDEOS_KEY = 'echosense_custom_videos_v1';
const DICT_CACHE_KEY = 'echosense_dict_cache_v1';

const STUDY_KEY = 'echolearning_study_v2';
const SQLITE_MIGRATED_KEY = 'echolearning_sqlite_migrated_v2';

export interface StudyData {
  vocabulary: SavedVocabularyItem[];
  history: ShadowingAssessmentReport[];
  materials: SavedMaterial[];
}

function readLegacy<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? (data as T[]) : [];
  } catch {
    return [];
  }
}

function loadStudy(): StudyData {
  try {
    const current = localStorage.getItem(STUDY_KEY);
    if (current) {
      const parsed: unknown = JSON.parse(current);
      if (typeof parsed === 'object' && parsed !== null) {
        const rec = parsed as Partial<StudyData>;
        return {
          vocabulary: Array.isArray(rec.vocabulary) ? rec.vocabulary : [],
          history: Array.isArray(rec.history) ? rec.history : [],
          materials: Array.isArray(rec.materials) ? rec.materials : [],
        };
      }
    }
  } catch {
    // Recover gracefully if localStorage contains corrupt JSON (D02)
  }
  return {
    vocabulary: readLegacy<SavedVocabularyItem>(VOCAB_STORAGE_KEY),
    history: readLegacy<ShadowingAssessmentReport>(HISTORY_STORAGE_KEY),
    materials: readLegacy<SavedMaterial>(CUSTOM_VIDEOS_KEY),
  };
}

function persistStudy(data: StudyData): void {
  try {
    localStorage.setItem(STUDY_KEY, JSON.stringify(data));
  } catch {
    // Ignore QuotaExceededError on cache writes; SQLite is primary storage (D01)
  }
}

function updateStudy<K extends keyof StudyData>(
  key: K,
  update: (items: StudyData[K]) => StudyData[K]
): StudyData[K] {
  const current = loadStudy();
  const updated = update(current[key]);
  persistStudy({ ...current, [key]: updated });
  return updated;
}

export function loadSavedVocabulary(): SavedVocabularyItem[] {
  return loadStudy().vocabulary;
}
export function loadPracticeHistory(): ShadowingAssessmentReport[] {
  return loadStudy().history;
}
export function loadCustomVideos(): SavedMaterial[] {
  return loadStudy().materials;
}

function vocabularyKey(item: SavedVocabularyItem): string {
  return JSON.stringify([item.language, item.word.normalize('NFC').toLowerCase()]);
}

export function saveVocabularyItem(item: SavedVocabularyItem): SavedVocabularyItem[] {
  return updateStudy('vocabulary', (items) => [
    item,
    ...items.filter((other) => vocabularyKey(other) !== vocabularyKey(item)),
  ]);
}

export function removeVocabularyItem(id: string): SavedVocabularyItem[] {
  return updateStudy('vocabulary', (items) => items.filter((item) => item.id !== id));
}

export function savePracticeReport(report: ShadowingAssessmentReport): ShadowingAssessmentReport[] {
  const { audioDataUrl: _strip, ...metadata } = report;
  return updateStudy('history', (items) => [
    metadata,
    ...items.filter((item) => item.id !== report.id),
  ]);
}

export function deletePracticeReport(id: string): ShadowingAssessmentReport[] {
  return updateStudy('history', (items) => items.filter((item) => item.id !== id));
}

export function saveCustomVideo(video: VideoMaterial | SavedMaterial): SavedMaterial[] {
  const material: SavedMaterial = {
    ...video,
    updatedAt: (video as SavedMaterial).updatedAt || new Date().toISOString(),
  };
  return updateStudy('materials', (items) => [
    material,
    ...items.filter((item) => item.videoId !== material.videoId),
  ]);
}

export function removeCustomVideo(videoId: string): SavedMaterial[] {
  return updateStudy('materials', (items) => items.filter((item) => item.videoId !== videoId));
}

/**
 * C11: Determine whether a dictionary entry is a degraded fallback that must NOT be cached.
 */
export function isDegradedDictionaryEntry(entry: DictionaryLookupResult | null | undefined): boolean {
  if (!entry) return true;
  if (entry.isDegraded === true) return true;
  if (entry.source === 'offline_fallback') return true;
  const textBlob = [
    entry.contextualMeaning || '',
    ...(entry.dictionaryDefinitions || []),
    entry.pronunciationTip || '',
  ]
    .join(' ')
    .toLowerCase();
  return textBlob.includes('offline fallback') || textBlob.includes('warming up');
}

export function getCachedDictionaryLookup(key: string): DictionaryLookupResult | null {
  try {
    const raw = localStorage.getItem(DICT_CACHE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, DictionaryLookupResult>;
    const entry = map[key];
    if (!entry) return null;
    if (isDegradedDictionaryEntry(entry)) {
      delete map[key];
      localStorage.setItem(DICT_CACHE_KEY, JSON.stringify(map));
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

export function setCachedDictionaryLookup(key: string, result: DictionaryLookupResult): void {
  if (isDegradedDictionaryEntry(result)) {
    return;
  }
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
    // Ignore cache write errors
  }
}

// ---------------------------------------------------------------------------
// Backend SQLite API Synchronization & One-Time localStorage Migration (R2)
// ---------------------------------------------------------------------------

export async function migrateLocalStorageToSqlite(): Promise<boolean> {
  try {
    if (localStorage.getItem(SQLITE_MIGRATED_KEY) === '1') {
      return false;
    }
    const study = loadStudy();
    const hasAny =
      study.vocabulary.length > 0 ||
      study.history.length > 0 ||
      study.materials.length > 0;

    if (!hasAny) {
      localStorage.setItem(SQLITE_MIGRATED_KEY, '1');
      return false;
    }

    const res = await fetch('/api/v1/localStorage-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vocabulary: study.vocabulary,
        history: study.history,
        materials: study.materials,
      }),
    });
    if (res.ok) {
      localStorage.setItem(SQLITE_MIGRATED_KEY, '1');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function fetchMaterialsFromApi(): Promise<SavedMaterial[]> {
  try {
    const res = await fetch('/api/materials');
    if (!res.ok) throw new Error('Failed to load materials');
    const data = await res.json();
    const items: SavedMaterial[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.materials)
      ? data.materials
      : [];
    const current = loadStudy();
    persistStudy({ ...current, materials: items });
    return items;
  } catch {
    return loadCustomVideos();
  }
}

export async function fetchMaterialByIdApi(videoId: string): Promise<SavedMaterial | null> {
  try {
    const res = await fetch(`/api/materials/${encodeURIComponent(videoId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const mat: SavedMaterial | undefined = data?.material || (data?.videoId ? data : undefined);
    if (mat) {
      saveCustomVideo(mat);
      return mat;
    }
    return null;
  } catch {
    return loadCustomVideos().find((m) => m.videoId === videoId) || null;
  }
}

export async function saveMaterialToApi(video: VideoMaterial): Promise<SavedMaterial[]> {
  const updated = saveCustomVideo(video);
  try {
    await fetch('/api/materials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(video),
    });
  } catch {
    // Keep local cache fallback
  }
  return updated;
}

export async function updateMaterialSegmentApi(
  videoId: string,
  segmentId: string,
  payload: { text: string; tokens?: WordToken[]; startTime?: number; endTime?: number }
): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/materials/${encodeURIComponent(videoId)}/segments/${encodeURIComponent(segmentId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteMaterialFromApi(videoId: string): Promise<SavedMaterial[]> {
  const updated = removeCustomVideo(videoId);
  try {
    await fetch(`/api/materials/${encodeURIComponent(videoId)}`, {
      method: 'DELETE',
    });
  } catch {
    // Keep local cache update
  }
  return updated;
}

export async function fetchVocabularyFromApi(): Promise<SavedVocabularyItem[]> {
  try {
    const res = await fetch('/api/vocabulary');
    if (!res.ok) throw new Error('Failed to load vocabulary');
    const data = await res.json();
    const items: SavedVocabularyItem[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.vocabulary)
      ? data.vocabulary
      : [];
    const current = loadStudy();
    persistStudy({ ...current, vocabulary: items });
    return items;
  } catch {
    return loadSavedVocabulary();
  }
}

export async function saveVocabularyItemApi(item: SavedVocabularyItem): Promise<SavedVocabularyItem[]> {
  const updated = saveVocabularyItem(item);
  try {
    await fetch('/api/vocabulary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });
  } catch {
    // Keep local cache fallback
  }
  return updated;
}

export async function removeVocabularyItemApi(id: string): Promise<SavedVocabularyItem[]> {
  const updated = removeVocabularyItem(id);
  try {
    await fetch(`/api/vocabulary/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  } catch {
    // Keep local cache fallback
  }
  return updated;
}

export async function fetchHistoryFromApi(): Promise<ShadowingAssessmentReport[]> {
  try {
    const res = await fetch('/api/history');
    if (!res.ok) throw new Error('Failed to load history');
    const data = await res.json();
    const items: ShadowingAssessmentReport[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.history)
      ? data.history
      : [];
    const current = loadStudy();
    persistStudy({ ...current, history: items });
    return items;
  } catch {
    return loadPracticeHistory();
  }
}

export async function savePracticeReportApi(
  report: ShadowingAssessmentReport
): Promise<ShadowingAssessmentReport[]> {
  const updated = savePracticeReport(report);
  try {
    const { audioDataUrl: _strip, ...metadata } = report;
    await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
  } catch {
    // Keep local cache fallback
  }
  return updated;
}

export async function deletePracticeReportApi(id: string): Promise<ShadowingAssessmentReport[]> {
  const updated = deletePracticeReport(id);
  try {
    await fetch(`/api/history/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  } catch {
    // Keep local cache fallback
  }
  return updated;
}

// ---------------------------------------------------------------------------
// CSV & JSON Backup Export / Restore
// ---------------------------------------------------------------------------

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
    let raw = String(val ?? '');
    if (/^[=+\-@\t\r]/.test(raw)) {
      raw = `'${raw}`;
    }
    const str = raw.replace(/"/g, '""');
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
  link.download = `echolearning-vocabulary-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportAllStudyDataJson(
  vocabulary: SavedVocabularyItem[],
  history: ShadowingAssessmentReport[],
  materials?: SavedMaterial[]
): void {
  const payload = {
    format: 'echolearning-study',
    schemaVersion: 2,
    materials: materials ?? loadCustomVideos(),
    exportedAt: new Date().toISOString(),
    app: 'EchoLearning',
    vocabularyCount: vocabulary.length,
    sessionCount: history.length,
    vocabulary,
    history: history.map(({ audioDataUrl: _strip, ...rest }) => rest),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `echolearning-study-backup-${new Date().toISOString().slice(0, 10)}.json`;
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

function learningLanguage(record: RecordValue): boolean {
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
  if (
    !object(data) ||
    !(
      (data.format === 'echolearning-study' && data.schemaVersion === 2) ||
      ((data.app === 'Echo Language Learning' || data.app === 'EchoLearning') &&
        data.schemaVersion === undefined)
    )
  ) {
    throw new Error('This EchoLearning backup format is unsupported.');
  }

  return {
    vocabulary: validateRows(data.vocabulary, 'vocabulary', (row) =>
      learningLanguage(row) &&
      strings(row, [
        'id',
        'word',
        'lemma',
        'reading',
        'partOfSpeech',
        'contextualMeaning',
        'sourceSentence',
        'videoId',
        'videoTitle',
        'createdAt',
      ]) &&
      numbers(row, ['timestampSec']) &&
      textList(row.dictionaryDefinitions) &&
      ['romaji', 'ipa', 'pitchAccent'].every(
        (key) => row[key] == null || typeof row[key] === 'string'
      )
    ),
    history: validateRows<ShadowingAssessmentReport>(data.history, 'reports', (row) =>
      learningLanguage(row) &&
      (row.mode === 'listen_repeat' || row.mode === 'simultaneous') &&
      strings(row, [
        'id',
        'videoId',
        'videoTitle',
        'createdAt',
        'targetText',
        'recognizedTranscript',
        'scoreExplanation',
      ]) &&
      numbers(row, ['overallScore']) &&
      textList(row.segmentIds) &&
      object(row.dimensions) &&
      numbers(row.dimensions, ['contentAccuracy', 'pronunciation', 'fluency', 'prosody']) &&
      object(row.metrics) &&
      numbers(row.metrics, [
        'speechRateValue',
        'targetRateValue',
        'durationSec',
        'targetDurationSec',
        'omittedCount',
        'substitutedCount',
        'uncertainSttCount',
      ]) &&
      textList(row.improvementSuggestions) &&
      Array.isArray(row.wordDiff) &&
      row.wordDiff.every((token) => object(token) && strings(token, ['word', 'status'])) &&
      Array.isArray(row.pronunciationFeedback) &&
      row.pronunciationFeedback.every(
        (feedback) =>
          object(feedback) &&
          strings(feedback, [
            'targetWord',
            'readingOrIpa',
            'category',
            'observedIssue',
            'actionableTip',
            'severity',
          ])
      )
    ).map(({ audioDataUrl: _strip, ...report }) => report),
    materials: validateRows(data.schemaVersion === 2 ? data.materials : [], 'materials', (row) =>
      learningLanguage(row) &&
      strings(row, ['videoId', 'title', 'channel', 'level', 'captionSource', 'captionNote']) &&
      typeof row.videoId === 'string' &&
      /^[A-Za-z0-9_-]{11}$/.test(row.videoId) &&
      numbers(row, ['durationSec']) &&
      Array.isArray(row.segments) &&
      row.segments.every(
        (segment) =>
          object(segment) &&
          strings(segment, ['id', 'text']) &&
          numbers(segment, ['index', 'startTime', 'endTime']) &&
          (segment.tokens === undefined ||
            (Array.isArray(segment.tokens) &&
              segment.tokens.every(
                (token) =>
                  object(token) &&
                  strings(token, ['surface']) &&
                  ['reading', 'romaji', 'ipa', 'lemma', 'pos', 'meaningHint'].every(
                    (key) => token[key] == null || typeof token[key] === 'string'
                  )
              )))
      )
    ),
  };
}

function mergeUnique<T>(current: T[], imported: T[], key: (item: T) => string): T[] {
  const seen = new Set(current.map(key));
  return [
    ...current,
    ...imported.filter((item) => {
      const id = key(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  ];
}

export async function restoreStudyBackup(backup: StudyData): Promise<StudyData> {
  const current = loadStudy();
  const merged: StudyData = {
    vocabulary: mergeUnique(current.vocabulary, backup.vocabulary, vocabularyKey),
    history: mergeUnique(current.history, backup.history, (report) => report.id),
    materials: mergeUnique(current.materials, backup.materials, (material) => material.videoId),
  };
  persistStudy(merged);
  try {
    await fetch('/api/v1/localStorage-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(backup),
    });
  } catch {
    // Local storage already updated
  }
  return merged;
}
