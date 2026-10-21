import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import {
  GoogleGenAI,
  MediaResolution,
  ThinkingLevel,
  Type,
} from '@google/genai';
// @ts-ignore - kuromoji does not ship bundled .d.ts files
import kuromoji from 'kuromoji';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

interface RawCaptionLine {
  start: number;
  dur: number;
  text: string;
}

interface ServerWordToken {
  surface: string;
  reading?: string;
  lemma?: string;
  pos?: string;
  isKanji?: boolean;
}

interface KuromojiToken {
  surface_form: string;
  reading?: string;
  basic_form?: string;
  pos?: string;
}

interface KuromojiTokenizer {
  tokenize: (text: string) => KuromojiToken[];
}

// Singleton Kuromoji Japanese Morphological Tokenizer
let kuromojiTokenizerPromise: Promise<KuromojiTokenizer> | null = null;

function getKuromojiTokenizer(): Promise<KuromojiTokenizer> {
  if (!kuromojiTokenizerPromise) {
    kuromojiTokenizerPromise = new Promise((resolve, reject) => {
      const dicPath = path.resolve(__dirname, 'node_modules/kuromoji/dict');
      kuromoji
        .builder({ dicPath })
        .build((err: Error | null, tokenizer: KuromojiTokenizer) => {
          if (err || !tokenizer) {
            kuromojiTokenizerPromise = null;
            reject(err || new Error('Failed to initialize kuromoji tokenizer'));
          } else {
            resolve(tokenizer);
          }
        });
    });
  }
  return kuromojiTokenizerPromise;
}

function katakanaToHiragana(str: string): string {
  return str.replace(/[\u30a1-\u30f6]/g, (match) =>
    String.fromCharCode(match.charCodeAt(0) - 0x60)
  );
}

async function tokenizeSentenceServerSide(
  text: string,
  language: 'en' | 'ja'
): Promise<ServerWordToken[]> {
  if (language === 'ja') {
    try {
      const tokenizer = await getKuromojiTokenizer();
      const rawTokens = tokenizer.tokenize(text);
      return rawTokens.map((t: KuromojiToken) => {
        const surface = t.surface_form;
        const hasKanji = /[\u4e00-\u9faf]/.test(surface);
        const hiraganaReading = t.reading
          ? katakanaToHiragana(t.reading)
          : undefined;
        return {
          surface,
          reading: hasKanji && hiraganaReading ? hiraganaReading : undefined,
          lemma: t.basic_form && t.basic_form !== '*' ? t.basic_form : surface,
          pos: t.pos,
          isKanji: hasKanji,
        };
      });
    } catch (err) {
      console.warn('Kuromoji fallback to Intl.Segmenter:', err);
    }
  }

  // English or fallback tokenization via Intl.Segmenter
  if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
    const segmenter = new (Intl as any).Segmenter(language, {
      granularity: 'word',
    });
    const items = Array.from(segmenter.segment(text)) as Array<{
      segment: string;
      isWordLike?: boolean;
    }>;
    const result: ServerWordToken[] = [];
    for (const item of items) {
      const trimmed = item.segment;
      if (!trimmed || /^\s+$/.test(trimmed)) continue;
      result.push({
        surface: trimmed,
        isKanji: /[\u4e00-\u9faf]/.test(trimmed),
      });
    }
    return result;
  }

  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ({ surface: w }));
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/<[^>]+>/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

function extractYouTubeId(input: string): string | null {
  const trimmed = (input || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(
    /(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([a-zA-Z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

function detectJapaneseCharacters(text: string): boolean {
  return /[\u3040-\u30ff\u4e00-\u9faf]/.test(text);
}

async function fetchYouTubeOEmbed(
  videoId: string
): Promise<{ title: string; authorName: string }> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const res = await fetch(oembedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    if (res.ok) {
      const data = (await res.json()) as {
        title?: string;
        author_name?: string;
      };
      return {
        title: data.title || `YouTube Video (${videoId})`,
        authorName: data.author_name || 'YouTube Creator',
      };
    }
  } catch {
    // Ignore oEmbed failure
  }
  return { title: `YouTube Video (${videoId})`, authorName: 'YouTube Creator' };
}

function parseTimedTextPayload(body: string): RawCaptionLine[] {
  const lines: RawCaptionLine[] = [];
  const trimmed = body.trim();
  if (!trimmed) return lines;

  if (trimmed.startsWith('{')) {
    try {
      const json3 = JSON.parse(trimmed);
      const events = json3.events || [];
      for (const ev of events) {
        if (!ev.segs) continue;
        const text = decodeHtmlEntities(
          ev.segs.map((s: any) => s.utf8 || '').join('')
        );
        if (text && !/^\[.*\]$/.test(text) && !/^♪+$/.test(text)) {
          lines.push({
            start: (ev.tStartMs || 0) / 1000,
            dur: (ev.dDurationMs || 2500) / 1000,
            text,
          });
        }
      }
    } catch {
      // Ignore JSON parse error
    }
  } else {
    const textMatches = trimmed.matchAll(
      /<text\s+[^>]*start="([\d.]+)"[^>]*?(?:dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g
    );
    for (const m of textMatches) {
      const text = decodeHtmlEntities(m[3]);
      if (text && !/^\[.*\]$/.test(text) && !/^♪+$/.test(text)) {
        lines.push({
          start: parseFloat(m[1]),
          dur: m[2] ? parseFloat(m[2]) : 2.5,
          text,
        });
      }
    }

    if (lines.length === 0) {
      const pMatches = trimmed.matchAll(
        /<p\s+[^>]*t="(\d+)"[^>]*?(?:d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g
      );
      for (const m of pMatches) {
        const text = decodeHtmlEntities(m[3]);
        if (text && !/^\[.*\]$/.test(text) && !/^♪+$/.test(text)) {
          lines.push({
            start: parseInt(m[1], 10) / 1000,
            dur: m[2] ? parseInt(m[2], 10) / 1000 : 2.5,
            text,
          });
        }
      }
    }
  }

  return lines;
}

/**
 * Fetches accurate video duration (`lengthSeconds`), title, author, description,
 * and any available public caption tracks.
 * Uses `ANDROID_TESTSUITE` and `VISIONOS` InnerTube clients which reliably return
 * `videoDetails.lengthSeconds` on Cloud Run IPs without `LOGIN_REQUIRED`.
 */
async function fetchYouTubeCaptionsAndDetails(
  videoId: string,
  preferredLang?: string
): Promise<{
  title: string;
  authorName: string;
  lines: RawCaptionLine[];
  language: 'en' | 'ja';
  isAutoGenerated: boolean;
  shortDescription: string;
  durationSec: number;
}> {
  let title = '';
  let authorName = '';
  let shortDescription = '';
  let durationSec = 0;
  let innertubeApiKey = '';
  let captionTracks: Array<{
    baseUrl: string;
    languageCode: string;
    kind?: string;
  }> = [];

  const commonHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
    Cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+410',
  };

  // Step 1: Fast InnerTube metadata query via ANDROID_TESTSUITE (reliably returns exact lengthSeconds & videoDetails)
  try {
    const testsuiteRes = await fetch(
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'ANDROID_TESTSUITE',
              clientVersion: '1.9',
              hl: 'en',
              gl: 'US',
            },
          },
          videoId,
        }),
      }
    );
    if (testsuiteRes.ok) {
      const data = (await testsuiteRes.json()) as any;
      const vd = data?.videoDetails;
      if (vd) {
        if (vd.title) title = vd.title;
        if (vd.author) authorName = vd.author;
        if (vd.shortDescription) shortDescription = vd.shortDescription;
        const len = Number(vd.lengthSeconds);
        if (len > 0) durationSec = len;
      }
      const tracks =
        data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (tracks.length > 0) {
        captionTracks = tracks;
      }
    }
  } catch {
    // Continue to next strategies
  }

  // Step 2: Watch page & additional InnerTube clients for captionTracks
  try {
    const watchRes = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en`,
      {
        headers: commonHeaders,
      }
    );
    const html = await watchRes.text();

    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    if (apiKeyMatch && apiKeyMatch[1]) {
      innertubeApiKey = apiKeyMatch[1];
    }

    const playerMatch = html.match(
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|let|const|<\/script>)/s
    );
    if (playerMatch && playerMatch[1]) {
      try {
        const playerResponse = JSON.parse(playerMatch[1]);
        const tracks =
          playerResponse?.captions?.playerCaptionsTracklistRenderer
            ?.captionTracks || [];
        if (tracks.length > 0) captionTracks = tracks;
        if (!shortDescription && playerResponse?.videoDetails?.shortDescription) {
          shortDescription = playerResponse.videoDetails.shortDescription;
        }
        const len = Number(playerResponse?.videoDetails?.lengthSeconds);
        if (len > 0) durationSec = len;
      } catch {
        // Ignore JSON error
      }
    }

    if (captionTracks.length === 0) {
      const tracksMatch = html.match(/"captionTracks":(\[.*?\])/);
      if (tracksMatch && tracksMatch[1]) {
        try {
          captionTracks = JSON.parse(tracksMatch[1]);
        } catch {
          // Ignore
        }
      }
    }

    if (!durationSec) {
      const lenMatch = html.match(/"lengthSeconds":"(\d+)"/);
      if (lenMatch && lenMatch[1]) {
        durationSec = Number(lenMatch[1]) || 0;
      }
    }

    if (captionTracks.length === 0) {
      const playerEndpoint = innertubeApiKey
        ? `https://www.youtube.com/youtubei/v1/player?key=${innertubeApiKey}&prettyPrint=false`
        : 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

      for (const clientCfg of [
        {
          clientName: 'ANDROID',
          clientVersion: '20.10.38',
          userAgent:
            'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
        },
        {
          clientName: 'IOS',
          clientVersion: '20.10.4',
          userAgent:
            'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
        },
      ]) {
        try {
          const innertubeRes = await fetch(playerEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': clientCfg.userAgent,
            },
            body: JSON.stringify({
              context: {
                client: {
                  clientName: clientCfg.clientName,
                  clientVersion: clientCfg.clientVersion,
                  hl: 'en',
                  gl: 'US',
                },
              },
              videoId,
            }),
          });
          if (innertubeRes.ok) {
            const data = (await innertubeRes.json()) as any;
            const len = Number(data?.videoDetails?.lengthSeconds);
            if (len > 0 && !durationSec) durationSec = len;
            const tracks =
              data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
              [];
            if (tracks.length > 0) {
              captionTracks = tracks;
              break;
            }
          }
        } catch {
          // Try next client
        }
      }
    }

    if (captionTracks.length > 0) {
      const findTrack = (langPrefix: 'en' | 'ja', manualOnly: boolean) =>
        captionTracks.find(
          (t) =>
            t.languageCode?.toLowerCase().startsWith(langPrefix) &&
            (manualOnly ? t.kind !== 'asr' : true)
        );

      const chosenTrack =
        (preferredLang === 'ja'
          ? findTrack('ja', true) ||
            findTrack('ja', false) ||
            findTrack('en', true) ||
            findTrack('en', false)
          : preferredLang === 'en'
          ? findTrack('en', true) ||
            findTrack('en', false) ||
            findTrack('ja', true) ||
            findTrack('ja', false)
          : findTrack('ja', true) ||
            findTrack('en', true) ||
            findTrack('ja', false) ||
            findTrack('en', false)) || captionTracks[0];

      if (chosenTrack && chosenTrack.baseUrl) {
        const detectedLang: 'en' | 'ja' = chosenTrack.languageCode
          ?.toLowerCase()
          .startsWith('ja')
          ? 'ja'
          : 'en';
        const isAutoGenerated = chosenTrack.kind === 'asr';

        for (const fmtSuffix of ['', '&fmt=json3', '&fmt=srv3']) {
          try {
            const url = fmtSuffix
              ? `${chosenTrack.baseUrl.replace(/&fmt=[^&]+/, '')}${fmtSuffix}`
              : chosenTrack.baseUrl;
            const trackRes = await fetch(url, { headers: commonHeaders });
            if (trackRes.ok) {
              const trackBody = await trackRes.text();
              const parsedLines = parseTimedTextPayload(trackBody);
              if (parsedLines.length > 0) {
                return {
                  title,
                  authorName,
                  lines: parsedLines,
                  language: detectedLang,
                  isAutoGenerated,
                  shortDescription,
                  durationSec: durationSec || 180,
                };
              }
            }
          } catch {
            // Try next format
          }
        }
      }
    }
  } catch {
    // Fall through to full Gemini multimodal video transcription
  }

  return {
    title,
    authorName,
    lines: [],
    language: (preferredLang as 'en' | 'ja') || 'en',
    isAutoGenerated: true,
    shortDescription,
    durationSec: durationSec || 180,
  };
}

/**
 * Merges 100% of raw caption fragments across the ENTIRE video into natural sentence segments
 * without dropping or truncating any part of the video.
 */
function mergeCaptionLinesIntoCompleteSegments(
  rawLines: RawCaptionLine[],
  language: 'en' | 'ja'
): Array<{ startTime: number; endTime: number; text: string }> {
  if (rawLines.length === 0) return [];

  const merged: Array<{ startTime: number; endTime: number; text: string }> = [];
  let currentStart = rawLines[0].start;
  let currentEnd = rawLines[0].start + rawLines[0].dur;
  let currentPieces: string[] = [];

  const maxChars = language === 'ja' ? 58 : 130;
  const maxDurationSec = 10.5;
  const minDurationSec = 2.2;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const cleanText = line.text.trim();
    if (!cleanText) continue;

    if (
      currentPieces.length > 0 &&
      currentPieces[currentPieces.length - 1] === cleanText
    ) {
      currentEnd = Math.max(currentEnd, line.start + line.dur);
      continue;
    }

    if (currentPieces.length === 0) {
      currentStart = line.start;
    }

    currentPieces.push(cleanText);
    const nextLine = rawLines[i + 1];
    const rawLineEnd = line.start + line.dur;
    currentEnd = nextLine
      ? Math.min(rawLineEnd, Math.max(line.start + 0.8, nextLine.start))
      : rawLineEnd;

    const combinedText = currentPieces
      .join(language === 'ja' ? '' : ' ')
      .trim();
    const currentDur = currentEnd - currentStart;
    const endsWithSentencePunct = /[.?!。？！]$/.test(cleanText);
    const pauseGapToNext = nextLine ? nextLine.start - currentEnd : 99;

    const shouldFlush =
      !nextLine ||
      (endsWithSentencePunct && currentDur >= minDurationSec) ||
      pauseGapToNext > 1.2 ||
      combinedText.length >= maxChars ||
      currentDur >= maxDurationSec;

    if (shouldFlush) {
      merged.push({
        startTime: Number(currentStart.toFixed(1)),
        endTime: Number(Math.max(currentStart + 1.0, currentEnd).toFixed(1)),
        text: combinedText,
      });
      currentPieces = [];
    }
  }

  return merged;
}

const CHUNK_TRANSCRIPT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    detectedLanguage: { type: Type.STRING },
    levelEstimate: { type: Type.STRING },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          startTime: { type: Type.NUMBER },
          endTime: { type: Type.NUMBER },
          text: { type: Type.STRING },
        },
        required: ['startTime', 'endTime', 'text'],
      },
    },
  },
  required: ['detectedLanguage', 'levelEstimate', 'segments'],
};

function formatMMSS(sec: number): string {
  const mins = Math.floor(sec / 60);
  const secs = Math.floor(sec % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Transcribes a single [chunkStartSec, chunkEndSec] window of a YouTube video verbatim
 * using Gemini's `videoMetadata: { startOffset, endOffset }` and low media resolution.
 */
async function transcribeVideoTimeWindowWithGemini(params: {
  youtubeUrl: string;
  title: string;
  authorName: string;
  inferredLang: 'en' | 'ja';
  chunkStartSec: number;
  chunkEndSec: number;
  totalDurationSec: number;
}): Promise<{
  detectedLanguage: 'en' | 'ja';
  levelEstimate: string;
  segments: Array<{ startTime: number; endTime: number; text: string }>;
}> {
  const {
    youtubeUrl,
    title,
    authorName,
    inferredLang,
    chunkStartSec,
    chunkEndSec,
    totalDurationSec,
  } = params;

  const promptText = `You are a verbatim audio/video transcriber for "Echo Language Learning".
Transcribe EVERY spoken sentence in this video clip window from ${formatMMSS(
    chunkStartSec
  )} (${chunkStartSec}s) to ${formatMMSS(chunkEndSec)} (${chunkEndSec}s) of the YouTube video "${title}" by "${authorName}" (Total video length: ${totalDurationSec}s).

CRITICAL RULES FOR COMPLETENESS:
1. Transcribe 100% of all spoken speech from ${chunkStartSec} seconds up to ${chunkEndSec} seconds without skipping, summarizing, or omitting any sentences.
2. Each segment MUST have accurate "startTime" and "endTime" in absolute video seconds (between ${chunkStartSec} and ${chunkEndSec}). Note: if your internal clip timer starts at 0, add ${chunkStartSec} so timestamps match the absolute video timeline [${chunkStartSec}, ${chunkEndSec}].
3. Each segment should be a natural sentence or phrase (typically 2.5 to 9 seconds long).
4. Write "text" strictly in the spoken language ("${inferredLang}" — ${
    inferredLang === 'ja'
      ? 'natural Japanese in Kanji and Kana only, NO romaji and NO English translation'
      : 'natural English only, NO Japanese translation'
  }).
5. If a portion of the window has only silence, applause, or music, simply omit silent gaps and transcribe all spoken lines.`;

  let lastError: any = null;
  for (const modelName of ['gemini-3.8-flash', 'gemini-flash-latest']) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [
          {
            role: 'user',
            parts: [
              {
                fileData: {
                  fileUri: youtubeUrl,
                  mimeType: 'video/mp4',
                },
                videoMetadata: {
                  startOffset: `${chunkStartSec}s`,
                  endOffset: `${chunkEndSec}s`,
                },
              } as any,
              { text: promptText },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: CHUNK_TRANSCRIPT_SCHEMA,
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          maxOutputTokens: 65536,
        },
      });

      if (response.text) {
        const parsed = JSON.parse(response.text);
        const rawSegs: Array<{
          startTime: number;
          endTime: number;
          text: string;
        }> = Array.isArray(parsed.segments) ? parsed.segments : [];

        // Normalize timestamps: if Gemini returned relative timestamps (starting near 0 when chunkStartSec > 30), shift by chunkStartSec
        const needsOffsetShift =
          chunkStartSec >= 30 &&
          rawSegs.length > 0 &&
          rawSegs[0].startTime < chunkStartSec * 0.4 &&
          rawSegs[rawSegs.length - 1].endTime <=
            chunkEndSec - chunkStartSec + 15;

        const normalizedSegments = rawSegs
          .map((s) => {
            const text = (s.text || '').trim();
            if (!text) return null;
            let st = Number(s.startTime) || 0;
            let et = Number(s.endTime) || st + 4;
            if (needsOffsetShift) {
              st += chunkStartSec;
              et += chunkStartSec;
            }
            st = Math.max(chunkStartSec, Math.min(chunkEndSec - 0.5, st));
            et = Math.max(st + 0.8, Math.min(chunkEndSec + 2, et));
            return {
              startTime: Number(st.toFixed(1)),
              endTime: Number(et.toFixed(1)),
              text,
            };
          })
          .filter(
            (
              s
            ): s is { startTime: number; endTime: number; text: string } =>
              Boolean(s)
          );

        const lang: 'en' | 'ja' =
          parsed.detectedLanguage === 'ja' ||
          detectJapaneseCharacters(normalizedSegments[0]?.text || '')
            ? 'ja'
            : inferredLang;

        return {
          detectedLanguage: lang,
          levelEstimate: parsed.levelEstimate || 'Intermediate',
          segments: normalizedSegments,
        };
      }
    } catch (err) {
      lastError = err;
      console.warn(
        `Chunk [${chunkStartSec}s-${chunkEndSec}s] warning with ${modelName}:`,
        err
      );
    }
  }

  throw (
    lastError ||
    new Error(
      `Failed to transcribe video time window ${chunkStartSec}s–${chunkEndSec}s`
    )
  );
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '25mb' }));

  // Pre-warm Kuromoji Japanese Morphological Analyzer on server startup
  getKuromojiTokenizer().catch((err) =>
    console.warn('Kuromoji warm-up warning:', err)
  );

  /**
   * 1. Automatically Fetch or Transcribe Complete YouTube Video Transcript
   * Supports streaming NDJSON (`stream: true`) so long videos never hit proxy timeouts
   * and progressive segments appear live in the UI as each time window completes.
   */
  app.post('/api/transcript/fetch', async (req: Request, res: Response) => {
    const { urlOrId, preferredLanguage, stream } = req.body as {
      urlOrId?: string;
      preferredLanguage?: 'en' | 'ja';
      stream?: boolean;
    };

    const videoId = extractYouTubeId(urlOrId || '');
    if (!videoId) {
      res.status(400).json({
        error:
          'Please enter a valid 11-character YouTube video URL or video ID.',
      });
      return;
    }

    if (stream) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
    }

    const sendStreamEvent = (payload: Record<string, any>) => {
      if (stream && !res.writableEnded) {
        res.write(JSON.stringify(payload) + '\n');
      }
    };

    // Keep-alive heartbeat every 2.5 seconds during long multimodal transcriptions
    const heartbeatTimer = stream
      ? setInterval(() => {
          sendStreamEvent({ type: 'heartbeat', ts: Date.now() });
        }, 2500)
      : null;

    const cleanupHeartbeat = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    };

    try {
      const [oembedMeta, captionResult] = await Promise.all([
        fetchYouTubeOEmbed(videoId),
        fetchYouTubeCaptionsAndDetails(videoId, preferredLanguage),
      ]);

      const title = captionResult.title || oembedMeta.title;
      const authorName = captionResult.authorName || oembedMeta.authorName;
      const durationSec = Math.max(15, captionResult.durationSec || 180);
      const inferredLang: 'en' | 'ja' = detectJapaneseCharacters(
        title + ' ' + captionResult.shortDescription
      )
        ? 'ja'
        : preferredLanguage || captionResult.language || 'en';

      sendStreamEvent({
        type: 'meta',
        videoId,
        title,
        channel: authorName,
        durationSec,
        language: inferredLang,
      });

      // Fast Path: Public caption track was directly extracted
      if (captionResult.lines.length > 0) {
        const rawSegments = mergeCaptionLinesIntoCompleteSegments(
          captionResult.lines,
          captionResult.language
        );
        const finalLang: 'en' | 'ja' = detectJapaneseCharacters(
          rawSegments[0]?.text || ''
        )
          ? 'ja'
          : captionResult.language;

        const annotatedSegments = await Promise.all(
          rawSegments.map(async (seg, idx) => {
            const tokens = await tokenizeSentenceServerSide(
              seg.text,
              finalLang
            );
            return {
              id: `yt-${videoId}-${idx}-${Date.now()}`,
              index: idx,
              startTime: Number(seg.startTime) ?? idx * 5,
              endTime: Number(seg.endTime) ?? (idx + 1) * 5,
              text: seg.text,
              tokens,
            };
          })
        );

        const finalVideo = {
          videoId,
          title,
          channel: authorName,
          language: finalLang,
          level: 'Intermediate',
          durationSec:
            annotatedSegments.length > 0
              ? Math.max(
                  durationSec,
                  Math.ceil(
                    annotatedSegments[annotatedSegments.length - 1].endTime
                  )
                )
              : durationSec,
          captionSource: captionResult.isAutoGenerated
            ? 'youtube_asr'
            : 'youtube_manual',
          captionNote: `Complete transcript (${annotatedSegments.length} segments across ${formatMMSS(
            durationSec
          )}) loaded. Click Edit on any line to make corrections directly.`,
          segments: annotatedSegments,
        };

        cleanupHeartbeat();
        if (stream) {
          sendStreamEvent({ type: 'complete', video: finalVideo });
          res.end();
        } else {
          res.json({ status: 'ok', video: finalVideo });
        }
        return;
      }

      // Full-Video Multimodal AI Transcription Path:
      // Partition total video duration [0, durationSec] into 210-second (3.5-minute) windows
      // so every single sentence from 0:00 to the end of the video is transcribed completely.
      const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const CHUNK_WINDOW_SEC = durationSec <= 240 ? durationSec : 210;
      const timeWindows: Array<{ start: number; end: number; index: number }> =
        [];

      for (let start = 0, idx = 0; start < durationSec; start += CHUNK_WINDOW_SEC, idx++) {
        let end = Math.min(durationSec, start + CHUNK_WINDOW_SEC);
        // Merge tiny trailing remainder (< 35s) into the last window
        if (durationSec - end > 0 && durationSec - end < 35) {
          end = durationSec;
        }
        timeWindows.push({ start, end, index: idx });
        if (end >= durationSec) break;
      }

      sendStreamEvent({
        type: 'progress',
        completedChunks: 0,
        totalChunks: timeWindows.length,
        message: `Transcribing full video audio (0:00 – ${formatMMSS(
          durationSec
        )}) across ${timeWindows.length} time ${
          timeWindows.length === 1 ? 'window' : 'windows'
        }...`,
      });

      const chunkResults: Array<{
        windowIndex: number;
        detectedLanguage: 'en' | 'ja';
        levelEstimate: string;
        segments: Array<{
          id: string;
          index: number;
          startTime: number;
          endTime: number;
          text: string;
          tokens: ServerWordToken[];
        }>;
      }> = [];

      let completedChunks = 0;
      let detectedVideoLang: 'en' | 'ja' = inferredLang;
      let detectedLevel = 'Intermediate';

      // Process up to 3 time windows concurrently for fast full-video completion
      const CONCURRENCY = 3;
      for (let i = 0; i < timeWindows.length; i += CONCURRENCY) {
        const batch = timeWindows.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async (win) => {
            const winResult = await transcribeVideoTimeWindowWithGemini({
              youtubeUrl,
              title,
              authorName,
              inferredLang,
              chunkStartSec: win.start,
              chunkEndSec: win.end,
              totalDurationSec: durationSec,
            });

            detectedVideoLang = winResult.detectedLanguage;
            if (win.index === 0 && winResult.levelEstimate) {
              detectedLevel = winResult.levelEstimate;
            }

            const tokenizedWinSegments = await Promise.all(
              winResult.segments.map(async (seg, localIdx) => {
                const tokens = await tokenizeSentenceServerSide(
                  seg.text,
                  winResult.detectedLanguage
                );
                return {
                  id: `yt-${videoId}-w${win.index}-${localIdx}-${Date.now()}`,
                  index: localIdx,
                  startTime: seg.startTime,
                  endTime: seg.endTime,
                  text: seg.text,
                  tokens,
                };
              })
            );

            chunkResults.push({
              windowIndex: win.index,
              detectedLanguage: winResult.detectedLanguage,
              levelEstimate: winResult.levelEstimate,
              segments: tokenizedWinSegments,
            });

            completedChunks += 1;

            // Sort all completed chunks so far in chronological order and stream progressive update
            const orderedSoFar = [...chunkResults]
              .sort((a, b) => a.windowIndex - b.windowIndex)
              .flatMap((c) => c.segments)
              .map((seg, globalIdx) => ({
                ...seg,
                index: globalIdx,
              }));

            sendStreamEvent({
              type: 'partial_segments',
              completedChunks,
              totalChunks: timeWindows.length,
              language: detectedVideoLang,
              level: detectedLevel,
              message: `Transcribed ${completedChunks} of ${
                timeWindows.length
              } time windows (${orderedSoFar.length} segments up to ${formatMMSS(
                win.end
              )})...`,
              segments: orderedSoFar,
            });
          })
        );
      }

      // Stitch all time windows in strict chronological order
      const allStitchedSegments = chunkResults
        .sort((a, b) => a.windowIndex - b.windowIndex)
        .flatMap((c) => c.segments)
        .map((seg, globalIdx) => ({
          ...seg,
          index: globalIdx,
        }));

      const finalDurationSec =
        allStitchedSegments.length > 0
          ? Math.max(
              durationSec,
              Math.ceil(
                allStitchedSegments[allStitchedSegments.length - 1].endTime
              )
            )
          : durationSec;

      const finalVideo = {
        videoId,
        title,
        channel: authorName,
        language: detectedVideoLang,
        level: detectedLevel,
        durationSec: finalDurationSec,
        captionSource: 'ai_generated',
        captionNote: `Complete full-video transcript (${
          allStitchedSegments.length
        } segments covering 0:00 – ${formatMMSS(
          finalDurationSec
        )}) generated. Click Edit on any line to refine text or timestamps.`,
        segments: allStitchedSegments,
      };

      cleanupHeartbeat();
      if (stream) {
        sendStreamEvent({ type: 'complete', video: finalVideo });
        res.end();
      } else {
        res.json({ status: 'ok', video: finalVideo });
      }
    } catch (error: any) {
      cleanupHeartbeat();
      console.error('Error in /api/transcript/fetch:', error);
      if (stream) {
        sendStreamEvent({
          type: 'error',
          error: error?.message || 'Failed to generate complete video transcript.',
        });
        res.end();
      } else {
        res.status(500).json({
          error: error?.message || 'Failed to generate complete video transcript.',
        });
      }
    }
  });

  // 2. Retokenize & Update Furigana When User Edits a Transcript Segment Inline
  app.post('/api/transcript/retokenize', async (req: Request, res: Response) => {
    try {
      const { text, language } = req.body as {
        text: string;
        language: 'en' | 'ja';
      };

      if (!text?.trim()) {
        res.status(400).json({ error: 'Segment text is required.' });
        return;
      }

      const tokens = await tokenizeSentenceServerSide(text.trim(), language);
      res.json({ tokens });
    } catch (error: any) {
      console.error('Error in /api/transcript/retokenize:', error);
      res.status(500).json({
        error: error?.message || 'Failed to re-annotate edited segment.',
      });
    }
  });

  // 3. Contextual Dictionary Lookup (English Free Dictionary API + Gemini Contextual Lexicon)
  app.post('/api/dictionary/lookup', async (req: Request, res: Response) => {
    try {
      const { word, sentence, language } = req.body as {
        word: string;
        sentence: string;
        language: 'en' | 'ja';
      };

      if (!word?.trim()) {
        res.status(400).json({ error: 'Word is required for lookup.' });
        return;
      }

      const cleanWord =
        word.replace(/[.,!?;:"'()「」『』、。！？]/g, '').trim() || word.trim();

      let freeDictHint = '';
      if (language === 'en') {
        try {
          const dictRes = await fetch(
            `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(
              cleanWord.toLowerCase()
            )}`
          );
          if (dictRes.ok) {
            const dictJson = (await dictRes.json()) as any[];
            const first = dictJson?.[0];
            if (first) {
              const phonetic =
                first.phonetic ||
                first.phonetics?.find((p: any) => p.text)?.text ||
                '';
              const defs =
                first.meanings
                  ?.slice(0, 2)
                  .map(
                    (m: any) =>
                      `${m.partOfSpeech}: ${m.definitions?.[0]?.definition || ''}`
                  )
                  .join('; ') || '';
              freeDictHint = `Verified FreeDictionary API reference: IPA=${phonetic}, Definitions=${defs}`;
            }
          }
        } catch {
          // Ignore Free Dictionary API timeout
        }
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: `You are an authoritative bilingual English-Japanese lexicographer and phonetics coach.
Target Word/Token: "${cleanWord}"
Full Context Sentence: "${sentence}"
Language: "${language}"
${freeDictHint}

Provide a precise contextual dictionary entry tailored to how "${cleanWord}" is used in the sentence above:
- For Japanese ("ja"):
  - "reading": Full Hiragana reading (Furigana) matching its exact usage in this sentence.
  - "romaji": Hepburn Romaji.
  - "ipa": Narrow IPA transcription (e.g., /ko.to.ba/).
  - "pitchAccent": Standard Tokyo pitch accent pattern (e.g., "Heiban [0] 平板型" or "Nakadaka [2] 中高型").
  - "contextualMeaning": Clear English explanation of what this word means specifically in this sentence.
- For English ("en"):
  - "reading": Syllable breakdown with primary stress (e.g., "uh-PROHCH").
  - "ipa": Standard IPA transcription (e.g., "/əˈproʊtʃ/").
  - "pitchAccent": Word stress pattern (e.g., "da-DUM (2nd syllable stress)").
  - "contextualMeaning": Clear explanation of the exact sense used in this sentence.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              word: { type: Type.STRING },
              lemma: { type: Type.STRING },
              language: { type: Type.STRING },
              reading: { type: Type.STRING },
              romaji: { type: Type.STRING },
              ipa: { type: Type.STRING },
              pitchAccent: { type: Type.STRING },
              partOfSpeech: { type: Type.STRING },
              contextualMeaning: { type: Type.STRING },
              dictionaryDefinitions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              usageExample: { type: Type.STRING },
              usageExampleTranslation: { type: Type.STRING },
              pronunciationTip: { type: Type.STRING },
            },
            required: [
              'word',
              'lemma',
              'language',
              'reading',
              'partOfSpeech',
              'contextualMeaning',
              'dictionaryDefinitions',
              'usageExample',
              'usageExampleTranslation',
              'pronunciationTip',
            ],
          },
        },
      });

      const result = JSON.parse(response.text || '{}');
      res.json(result);
    } catch (error: any) {
      console.error('Error in /api/dictionary/lookup:', error);
      res.status(500).json({
        error: error?.message || 'Dictionary lookup failed.',
      });
    }
  });

  // 4. Reference Pronunciation TTS via gemini-3.8-flash-lite-tts
  app.post('/api/tts/pronounce', async (req: Request, res: Response) => {
    try {
      const { text, language } = req.body as {
        text: string;
        language: 'en' | 'ja';
      };
      if (!text?.trim()) {
        res
          .status(400)
          .json({ error: 'Text is required for speech synthesis.' });
        return;
      }

      const stylePrompt =
        language === 'ja'
          ? 'Clear, natural standard Tokyo Japanese announcer pronunciation for language learners'
          : 'Clear, articulate, natural native English pronunciation for shadowing learners';

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: text.trim(),
                speechMetadata: {
                  style: stylePrompt,
                },
              } as any,
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

      const base64Audio =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!base64Audio) {
        res
          .status(500)
          .json({ error: 'No audio data returned from TTS model.' });
        return;
      }

      res.json({
        audioBase64: base64Audio,
        mimeType: 'audio/wav',
      });
    } catch (error: any) {
      console.error('Error in /api/tts/pronounce:', error);
      res.status(500).json({
        error:
          error?.message || 'Failed to synthesize reference pronunciation.',
      });
    }
  });

  // 5. Multimodal Shadowing Speech & Pronunciation Assessment
  app.post('/api/shadowing/evaluate', async (req: Request, res: Response) => {
    try {
      const {
        audioBase64,
        mimeType,
        targetText,
        language,
        mode,
        webSpeechTranscript,
        durationSec,
        targetDurationSec,
      } = req.body as {
        audioBase64?: string;
        mimeType?: string;
        targetText: string;
        language: 'en' | 'ja';
        mode: 'listen_repeat' | 'simultaneous';
        webSpeechTranscript?: string;
        durationSec: number;
        targetDurationSec: number;
      };

      if (!targetText?.trim()) {
        res.status(400).json({ error: 'Target transcript text is required.' });
        return;
      }

      const cleanMimeType = (mimeType || 'audio/webm').split(';')[0];
      let verbatimTranscript = webSpeechTranscript?.trim() || '';

      if (audioBase64) {
        try {
          const transcribeRes = await ai.models.generateContent({
            model: 'gemini-3.5-transcribe',
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: cleanMimeType,
                    data: audioBase64,
                  },
                },
                {
                  text:
                    language === 'ja'
                      ? 'Transcribe this spoken Japanese audio verbatim in Japanese characters (Kanji/Kana). Do not auto-correct omitted words or pronunciation slips. If silent, return empty string.'
                      : 'Transcribe this spoken English audio verbatim. Do not auto-correct omitted words or pronunciation slips. If silent, return empty string.',
                },
              ],
            },
          });
          if (transcribeRes.text && transcribeRes.text.trim()) {
            verbatimTranscript = transcribeRes.text.trim();
          }
        } catch (err) {
          console.warn(
            'gemini-3.5-transcribe fallback to multimodal flash:',
            err
          );
        }
      }

      const parts: any[] = [];
      if (audioBase64) {
        parts.push({
          inlineData: {
            mimeType: cleanMimeType,
            data: audioBase64,
          },
        });
      }

      parts.push({
        text: `You are an expert ${
          language === 'ja' ? 'Japanese (日本語)' : 'English'
        } phonetics, prosody, and shadowing coach.
Evaluate the learner's recorded shadowing performance against the target script.

Target Script: "${targetText}"
Language: "${language}"
Shadowing Mode: "${mode}"
Target Native Duration: ${Number(targetDurationSec || 6).toFixed(1)} seconds
Learner Recording Duration: ${Number(durationSec || 6).toFixed(1)} seconds
Verbatim Acoustic STT Transcript: "${
          verbatimTranscript || '(rely directly on the attached audio)'
        }"
Browser Web Speech Interim Transcript: "${
          webSpeechTranscript || '(not available)'
        }"

CRITICAL EVALUATION RULES:
1. Listen directly to the attached learner audio. If the audio is completely silent, pure background noise, or contains no recognizable attempt at the target language, set overallScore and all dimension scores to 0 and explain clearly in scoreExplanation that no clear speech was detected.
2. Separate the evaluation into 4 distinct dimensions (0-100):
   - contentAccuracy: Objective measure of how closely spoken words/morphemes match the Target Script.
   - pronunciation: Acoustic clarity of individual phonemes (for English: /θ/, /ð/, /r/, /l/, vowel quality, final consonants; for Japanese: moraic vowel clarity, long vowels 長音, double consonants 促音 'っ', nasal 'ん', /r/ flap).
   - fluency: Pacing consistency, absence of unnatural mid-phrase pauses/hesitations, and speech rate alignment relative to the native speaker duration.
   - prosody: Rhythm, stress timing (English) or isochronous mora timing & pitch accent contour (Japanese), and natural sentence intonation.
3. Word-by-word comparison (wordDiff):
   - Break the Target Script into words/tokens in sequential order.
   - Mark each token's status as:
     - "correct": Spoken clearly and accurately.
     - "omitted": Skipped or not spoken by the learner.
     - "substituted": Spoken with a different word or severe phonetic substitution.
     - "inserted": Extra unintended word added by the learner.
     - "stt_uncertain": The acoustic recording sounds close or acceptable, even if a standard speech-to-text transcript might misrecognize it due to homophones, accent, or microphone noise. ALWAYS use "stt_uncertain" when a discrepancy is likely an STT artifact rather than a genuine speaking error!
4. Provide 2 to 4 concrete, actionable pronunciationFeedback items pinpointing specific words/phonemes/moras from this sentence.
5. Calculate speechRateValue (in "WPM" for English, or "Moras/min" for Japanese) and targetRateValue.`,
      });

      const evalResponse = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: { parts },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              recognizedTranscript: { type: Type.STRING },
              overallScore: { type: Type.NUMBER },
              dimensions: {
                type: Type.OBJECT,
                properties: {
                  contentAccuracy: { type: Type.NUMBER },
                  pronunciation: { type: Type.NUMBER },
                  fluency: { type: Type.NUMBER },
                  prosody: { type: Type.NUMBER },
                },
                required: [
                  'contentAccuracy',
                  'pronunciation',
                  'fluency',
                  'prosody',
                ],
              },
              speechRateValue: { type: Type.NUMBER },
              targetRateValue: { type: Type.NUMBER },
              scoreExplanation: { type: Type.STRING },
              wordDiff: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    word: { type: Type.STRING },
                    expectedWord: { type: Type.STRING },
                    reading: { type: Type.STRING },
                    status: { type: Type.STRING },
                    explanation: { type: Type.STRING },
                  },
                  required: ['word', 'status'],
                },
              },
              pronunciationFeedback: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    targetWord: { type: Type.STRING },
                    readingOrIpa: { type: Type.STRING },
                    category: { type: Type.STRING },
                    observedIssue: { type: Type.STRING },
                    actionableTip: { type: Type.STRING },
                    severity: { type: Type.STRING },
                  },
                  required: [
                    'targetWord',
                    'readingOrIpa',
                    'category',
                    'observedIssue',
                    'actionableTip',
                    'severity',
                  ],
                },
              },
              improvementSuggestions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              recommendedRetryText: { type: Type.STRING },
            },
            required: [
              'recognizedTranscript',
              'overallScore',
              'dimensions',
              'speechRateValue',
              'targetRateValue',
              'scoreExplanation',
              'wordDiff',
              'pronunciationFeedback',
              'improvementSuggestions',
            ],
          },
        },
      });

      const data = JSON.parse(evalResponse.text || '{}');
      res.json(data);
    } catch (error: any) {
      console.error('Error in /api/shadowing/evaluate:', error);
      res.status(500).json({
        error: error?.message || 'Failed to evaluate shadowing session.',
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `Echo Language Learning server running on http://0.0.0.0:${PORT}`
    );
  });
}

startServer();
