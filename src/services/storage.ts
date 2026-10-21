import {
  DictionaryLookupResult,
  SavedVocabularyItem,
  ShadowingAssessmentReport,
  VideoMaterial,
} from '../types';

const VOCAB_STORAGE_KEY = 'echosense_vocabulary_v1';
const HISTORY_STORAGE_KEY = 'echosense_history_v1';
const CUSTOM_VIDEOS_KEY = 'echosense_custom_videos_v1';
const DICT_CACHE_KEY = 'echosense_dict_cache_v1';

export function loadSavedVocabulary(): SavedVocabularyItem[] {
  try {
    const raw = localStorage.getItem(VOCAB_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveVocabularyItem(item: SavedVocabularyItem): SavedVocabularyItem[] {
  const existing = loadSavedVocabulary();
  const filtered = existing.filter(
    (v) => !(v.word.toLowerCase() === item.word.toLowerCase() && v.language === item.language)
  );
  const updated = [item, ...filtered];
  try {
    localStorage.setItem(VOCAB_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Handle storage quota gracefully
  }
  return updated;
}

export function removeVocabularyItem(id: string): SavedVocabularyItem[] {
  const existing = loadSavedVocabulary();
  const updated = existing.filter((v) => v.id !== id);
  try {
    localStorage.setItem(VOCAB_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore
  }
  return updated;
}

export function loadPracticeHistory(): ShadowingAssessmentReport[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function savePracticeReport(report: ShadowingAssessmentReport): ShadowingAssessmentReport[] {
  const existing = loadPracticeHistory();
  // Keep up to 40 recent sessions in localStorage; trim large audioDataUrl on older entries if needed
  const updated = [report, ...existing.filter((r) => r.id !== report.id)].slice(0, 40);
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // If audioDataUrl exceeds localStorage quota, store without audioDataUrl on older items
    const compact = updated.map((r, idx) => (idx > 3 ? { ...r, audioDataUrl: undefined } : r));
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(compact));
    } catch {
      // Ignore
    }
  }
  return updated;
}

export function deletePracticeReport(id: string): ShadowingAssessmentReport[] {
  const existing = loadPracticeHistory();
  const updated = existing.filter((r) => r.id !== id);
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore
  }
  return updated;
}

export function loadCustomVideos(): VideoMaterial[] {
  try {
    const raw = localStorage.getItem(CUSTOM_VIDEOS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveCustomVideo(video: VideoMaterial): VideoMaterial[] {
  const existing = loadCustomVideos();
  const updated = [video, ...existing.filter((v) => v.videoId !== video.videoId)].slice(0, 20);
  try {
    localStorage.setItem(CUSTOM_VIDEOS_KEY, JSON.stringify(updated));
  } catch {
    // Ignore
  }
  return updated;
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
