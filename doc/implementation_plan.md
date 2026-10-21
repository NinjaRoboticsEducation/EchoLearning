# EchoSense — English & Japanese AI YouTube Shadowing Studio

EchoSense transforms authentic English and Japanese YouTube videos into an interactive language-learning studio where learners read synchronized bilingual transcripts with contextual vocabulary lookup and Japanese Furigana, practice speaking in Simultaneous or Listen-Then-Repeat shadowing modes, and receive multimodal AI audio and transcript feedback on their pronunciation, prosody, fluency, and content accuracy.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural and product choices have been confirmed from your answers and anchor the technical feasibility assessment and phased implementation plan below:

- **Confirmed Decision 1 — Transcript Acquisition & Fallback Strategy**: **Hybrid YouTube Caption Extraction with AI & Interactive Manual Fallback**. The backend extracts public English (`en`) and Japanese (`ja`) caption tracks from YouTube's InnerTube/caption endpoints when available, repairs sentence boundaries and punctuation via server-side Gemini processing (`gemini-3.8-flash`), and provides an interactive transcript editor/importer plus a curated bilingual starter library when third-party videos disable captions or restrict scraping.
- **Confirmed Decision 2 — Shadowing Practice Workflows**: **Dual-Mode Shadowing Studio (Simultaneous & Listen-Then-Repeat)**. Learners can switch seamlessly between **Listen-Then-Repeat Mode** (plays one sentence segment, automatically pauses the YouTube player, records the learner's repetition, and advances) and **Simultaneous Mode** (continuous playback while recording overlapping speech for advanced rhythm and speed training).
- **Confirmed Decision 3 — Speech Recognition & Assessment Engine**: **Multimodal Gemini Audio Analysis (`gemini-3.8-flash` & `gemini-3.5-transcribe`) + Browser Web Speech API**. Real-time interim word tracking is powered by the browser's `SpeechRecognition` API during practice, while recorded audio (`MediaRecorder` WebM/WAV) is sent to the backend so Gemini's native audio understanding evaluates spoken delivery, phoneme/syllable clarity, pitch/intonation contour, rhythm, and pausing alongside objective transcript diffing.
- **Confirmed Decision 4 — Data Persistence & Portability**: **Local Browser Storage (`IndexedDB` + `localStorage`) with JSON & Anki-Ready CSV Export**. Saved vocabulary cards (with contextual sentences, IPA/Furigana, and timestamps), custom transcripts, and shadowing performance history are persisted locally in the browser with one-click JSON backup/restore and CSV export.

---

## 1. Overview & Core Concept (Product Understanding & Scope)

### What It Does
EchoSense bridges the gap between passive video watching and active spoken fluency. Users load any English or Japanese YouTube video (or select from a built-in curated library of TED talks, interviews, anime/drama clips, and NHK-style news segments), follow a time-synced interactive transcript with instant word-level dictionary lookups and Furigana readings, record themselves shadowing either sentence-by-sentence or continuously, and receive a multi-dimensional diagnostic report separating objective transcript match from acoustic pronunciation, fluency, and prosody estimates.

### Target Audience / Personas
- **Intermediate to Advanced English Learners**: Focusing on connected speech, word stress, intonation contours, and shadowing native speakers at natural speed.
- **Beginner to Advanced Japanese Learners (JLPT N5–N1)**: Needing accurate morphological word boundaries, Kanji Furigana (振り仮名) readings, pitch-accent/moraic rhythm awareness, and contextual definitions without leaving the video.
- **Self-Directed Polyglots & Educators**: Using authentic YouTube media for daily deliberate speaking practice and exporting vocabulary decks to spaced-repetition tools (Anki/CSV).

### Key User Journeys
1. **Video & Transcript Onboarding**: Paste a YouTube URL or pick a curated English/Japanese video $\rightarrow$ inspect auto-detected language and caption quality badge $\rightarrow$ launch synchronized reader (or paste/edit custom SRT/text if captions are restricted).
2. **Active Listening & Lexical Discovery**: Watch the video as active sentences highlight automatically $\rightarrow$ click any sentence to loop or seek $\rightarrow$ hover/tap any English word (IPA + contextual meaning) or Japanese compound (Furigana + Hiragana/Romaji + JLPT/part-of-speech) $\rightarrow$ save to personal Vocabulary Vault.
3. **Guided Shadowing Session**: Choose **Listen-Then-Repeat** (single-segment auto-pause loop) or **Simultaneous** (continuous range) $\rightarrow$ verify microphone level meter $\rightarrow$ speak along with live visual waveform and real-time Web Speech interim text.
4. **Diagnostic Review & Targeted Retry**: View multi-dimensional assessment (Content Accuracy, Pronunciation & Articulation, Fluency & Pacing, Prosody & Intonation) $\rightarrow$ inspect word-by-word diff (omissions, substitutions, insertions, vs. likely STT noise) $\rightarrow$ compare recorded user audio side-by-side with original YouTube segment $\rightarrow$ click **"Retry Difficult Phrase"** to immediately re-practice weak segments.

### Scope Matrix

| Requirement Tier | Capabilities Included |
| :--- | :--- |
| **Essential (MVP Launch)** | • YouTube URL ingestion + curated English/Japanese starter library<br>• Server-side caption extraction + sentence boundary re-segmentation + manual/AI fallback<br>• Synchronized YouTube IFrame Player with auto-scrolling, click-to-seek, and A–B segment looping<br>• Japanese Furigana rendering (`<ruby>` tags), morphological word segmentation, and contextual bilingual dictionary popover<br>• Dual Shadowing Modes (Listen-Then-Repeat auto-pause & Simultaneous continuous)<br>• Browser microphone recording (`MediaRecorder`) + live waveform + Web Speech API real-time preview<br>• Server-side multimodal audio + transcript assessment (`gemini-3.5-transcribe` & `gemini-3.8-flash`) with 4-dimension scoring, word diff, and phoneme/mora coaching<br>• Local persistence (`IndexedDB`/`localStorage`) for Vocabulary Vault & Practice History with JSON/CSV export |
| **Optional Enhancements** | • Playback speed fine-tuning ($0.5\times$ to $1.5\times$) and auto-loop delay timer ($1\text{s}$–$5\text{s}$ pause before recording)<br>• Native TTS reference pronunciation playback (`gemini-3.8-flash-lite-tts`) for isolated vocabulary words or difficult sentences<br>• Pitch/energy contour visualization comparing user recording envelope against speech pacing |
| **Future Possibilities (Post-MVP)** | • Cloud sync & multi-device accounts (Firebase Auth + Firestore)<br>• Integration with commercial phoneme-scoring APIs (Azure AI Speech Pronunciation Assessment) for enterprise deployments<br>• Spaced-repetition flashcard quiz mode built directly from saved vocabulary |

---

## 2. Technical Feasibility Assessment

> [!NOTE]
> The assessment below separates **verified technical facts** (grounded in official API documentation) from **architectural recommendations** and **engineering trade-offs**.

### 2.1 YouTube Integration & Caption Acquisition
- **Video Embedding & Synchronization (Verified Fact)**: The official [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference) supports programmatic embedding, playback control (`playVideo`, `pauseVideo`, `seekTo`, `setPlaybackRate`), and current-time polling (`getCurrentTime()`). While the IFrame API does not emit a native high-frequency time-update event, polling `player.getCurrentTime()` via a `requestAnimationFrame` or $100\text{ms}$ interval when `PlayerState === PLAYING` achieves sub-$100\text{ms}$ sentence synchronization.
- **Official YouTube Data API v3 Restriction (Verified Fact)**: Per [Google's YouTube Data API v3 `captions.download` documentation](https://developers.google.com/youtube/v3/docs/captions/download), downloading caption tracks via the official REST endpoint requires OAuth 2.0 authorization **and** restricts downloads strictly to videos owned by the authenticated channel (`403 Forbidden` for third-party videos). Furthermore, the IFrame Player API cannot programmatically extract caption text from the player DOM due to cross-origin `<iframe>` sandboxing.
- **Practical Feasibility & Hybrid Solution (Recommendation)**:
  1. **Primary Path (Server-Side InnerTube Caption Extraction)**: Our Express backend extracts publicly available manual and auto-generated (`asr`) caption tracks (`en`, `ja`) via YouTube's public player/timedtext responses. Because YouTube auto-captions are often fragmented into arbitrary 2–4 second visual lines without punctuation, the backend passes raw fragments to `gemini-3.8-flash` to merge broken lines into natural grammatical sentences while preserving exact start/end timestamps.
  2. **Resilient Fallback Path**: Cloud datacenter IPs can occasionally encounter YouTube rate-limiting, or a video creator may disable captions altogether. To guarantee 100% reliability:
     - The app ships with a **Pre-Verified Curated Library** (English & Japanese videos with high-precision pre-cached transcripts).
     - If a user-supplied URL lacks extractable captions, the UI clearly explains the restriction and offers a **Smart Transcript Paste / SRT Upload & AI Timestamp Aligner** (users can paste the transcript from YouTube's "Show transcript" panel or upload audio/subtitles, and Gemini segments and timestamps it).

### 2.2 English & Japanese Language Processing (Tokenization, Furigana & Dictionary)
- **Japanese Morphological Challenge (Verified Fact)**: Unlike English, written Japanese has no spaces between words, mixes Kanji, Hiragana, and Katakana, and relies on context for Kanji readings (On'yomi vs. Kun'yomi, e.g., 生 has over 10 readings).
- **Feasible Architecture (Recommendation)**:
  - **Baseline Tokenization**: Use `Intl.Segmenter('ja', { granularity: 'word' })` (natively supported in all modern evergreen browsers and Node.js 18+) for zero-latency client-side word boundary detection, paired with server-side morphological & contextual enrichment via `gemini-3.8-flash` (or `kuromoji` / `kuroshiro` dictionary analysis).
  - **Furigana Generation**: When a Japanese transcript is loaded or processed, the backend annotates Kanji tokens with exact sentence-contextual Hiragana readings (`ruby` base + `rt` reading) and Romaji, preventing homograph misreadings that static rules make.
  - **Contextual Dictionary Lookup**: Combining free lexical APIs ([Free Dictionary API](https://dictionaryapi.dev/) for English IPA/definitions) with a server-side Gemini contextual lexicon endpoint (`/api/dictionary/lookup`) ensures that clicking a word in either English or Japanese returns:
    1. **Exact meaning in the current sentence** (solving polysemy/idioms),
    2. **Base dictionary form (lemma)**, part of speech, IPA (English) or Furigana + Pitch Accent hint + Romaji (Japanese),
    3. **Optional Reference Audio** via `gemini-3.8-flash-lite-tts` so learners can hear the isolated word or phrase spoken clearly.

### 2.3 Browser Audio Capture & Dual Shadowing Modes
- **Browser Audio Capabilities (Verified Fact)**:
  - `navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })` captures clean microphone input across desktop and mobile browsers.
  - `MediaRecorder` records compressed audio (`audio/webm;codecs=opus` on Chrome/Firefox/Edge or `audio/mp4` on Safari) suitable for base64 transmission to the backend and instant client-side `<audio>` replay.
  - `AudioContext` + `AnalyserNode` provides real-time frequency/time-domain data for a live 60fps microphone waveform and silence/clipping detection.
- **Acoustic Bleed Consideration in Simultaneous Mode**: When a user shadows simultaneously without headphones, the microphone may pick up the computer speaker's YouTube audio.
  - *Mitigation*: Enable browser `echoCancellation: true` by default, display a polite **"Headphones Recommended for Simultaneous Mode"** indicator, and make **Listen-Then-Repeat Mode** (which automatically pauses the YouTube video while the user speaks) the default recommended mode for clean acoustic capture.

### 2.4 Speech Recognition & Pronunciation Assessment Feasibility
- **Critical Distinction — Text STT vs. Acoustic Pronunciation Assessment**:
  - Standard Speech-to-Text (STT) models (such as Web Speech API or OpenAI Whisper) are trained to **correct** pronunciation errors using strong language model priors. If a learner mispronounces *"think"* as *"sink"* in context, an STT model often transcribes *"think"* anyway, masking the pronunciation error. Conversely, if an STT model fails to recognize a word due to background noise, a naive diff marks it as a speaking error.
  - **Specialized Phoneme APIs (Verified Fact)**: Microsoft's [Azure AI Speech Pronunciation Assessment](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment) ($1.32/hour standard real-time audio) provides phoneme-level IPA scores for `en-US`, **but** according to Microsoft's official documentation and Q&A disclosures, its `ja-JP` (Japanese) locale evaluates at the syllable level and returns empty strings for individual phoneme arrays unless gated enterprise tiers are approved.
- **Our Chosen Multimodal Architecture (`gemini-3.5-transcribe` + `gemini-3.8-flash` Native Audio)**:
  1. **Real-Time Visual Feedback**: Browser `webkitSpeechRecognition` / `SpeechRecognition` (`lang: 'en-US'` or `'ja-JP'`, `interimResults: true`) streams live recognized words on screen as the user speaks (zero API cost, $<200\text{ms}$ latency).
  2. **Verbatim Acoustic Transcription**: Upon finishing a segment or session, the recorded audio blob is sent to the server and transcribed with `gemini-3.5-transcribe` prompted for verbatim acoustic transcription (without auto-correcting grammatical or phonetic slips).
  3. **Multimodal Native Audio Evaluation**: The server passes **both** the raw user audio (`inlineData` base64 audio) **and** the target transcript + timestamps to `gemini-3.8-flash` with a structured `responseSchema`. Because `gemini-3.8-flash` processes raw audio tokens directly rather than just text, it evaluates:
     - **Content Accuracy (Objective)**: Exact word/morpheme match, omissions, insertions, and substitutions via deterministic Levenshtein/token alignment.
     - **Pronunciation & Articulation (AI Acoustic Estimate)**: Specific English phonemes (e.g., `/θ/` vs `/s/`, `/r/` vs `/l/`, vowel reduction) or Japanese moraic/consonant clarity (long vowels 長音, geminate consonants 促音 `っ`, `/r/` flap) heard in the audio.
     - **Fluency & Pacing (Objective + Acoustic)**: Speech rate (Words/Moras Per Minute vs. original video duration), unnatural mid-clause pauses, and hesitation fillers.
     - **Prosody & Intonation (AI Acoustic Estimate)**: Sentence stress, rhythm timing (stress-timed English vs. mora-timed Japanese), and pitch contour naturalness.
     - **Confidence & Error Attribution**: Explicitly flags whether a mismatch is a **Likely Pronunciation Issue** vs. **Possible Microphone/Recognition Noise**, satisfying pedagogical transparency.

---

## 3. Technology Comparison & Recommendations

### 3.1 Transcript Acquisition Alternatives

| Approach | EN/JA Support | Accuracy & Timestamps | Cost | Limitations & Platform Risk | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **YouTube Data API v3 (`captions.download`)** | High | Exact creator/ASR tracks | Quota-based (200 units/call) | **Fails (`403`) on any video not owned by the authenticated OAuth user** ([Google Docs](https://developers.google.com/youtube/v3/docs/captions/download)). | ❌ Not viable for general YouTube URLs |
| **Server-Side InnerTube / TimedText Extraction + Gemini Sentence Re-segmentation** | Native (`en`, `ja`) | Word/phrase timestamps merged into grammatical sentences | Free extraction + ~$0.001 Gemini token cost | Fails if video has no captions or if cloud IP is throttled by YouTube. | ✅ **Selected Primary Path** |
| **Direct Audio Download (`ytdl`) + Cloud STT (Whisper / Gemini Transcribe)** | High (50+ languages) | High accuracy | ~$0.003–$0.006 / min | Downloading YouTube audio streams violates YouTube ToS Section 5.B and is aggressively blocked on cloud IPs. | ⚠️ Use only for user-uploaded audio/files |
| **Curated Bilingual Library + Interactive Transcript Paste/SRT Aligner** | 100% Guaranteed | Verified sentence timestamps | Free | Requires manual paste if user picks an uncaptioned external video. | ✅ **Selected Fallback & Onboarding Path** |

### 3.2 Japanese NLP, Tokenization & Furigana Alternatives

| Approach | Accuracy on Context Readings | Bundle / Setup Overhead | Licensing & Cost | Trade-Offs | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`Intl.Segmenter` + Gemini Contextual Morphological Annotation** | **Very High** (resolves sentence-level Kanji homographs) | Zero client bundle bloat | Built-in Web API + low Gemini token cost | Requires brief async call on transcript load (cached locally in `IndexedDB`). | ✅ **Selected Primary Architecture** |
| **`kuromoji.js` + `kuroshiro`** ([kuroshiro.org](https://kuroshiro.org/)) | Good (IPADIC static dictionary) | ~18 MB compressed dictionary files in browser/server | MIT / Apache-2.0 (Free) | Static dictionary occasionally misreads context-dependent Kanji or modern slang/proper nouns. | ✅ **Useful Server-Side Deterministic Helper** |
| **Pure Regex / Kanji-to-Kana Lookup Table** | Poor (cannot disambiguate On'yomi vs. Kun'yomi) | Minimal | Free | Produces frequent incorrect readings in real Japanese sentences. | ❌ Rejected |

### 3.3 Speech Recognition & Pronunciation Assessment Alternatives

| Technology | English & Japanese Support | Granularity (Phoneme / Prosody / Fluency) | Latency | Operating Cost | Privacy & Integration | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Browser Web Speech API (`SpeechRecognition`)** | `en-US`, `en-GB`, `ja-JP` | Text transcript + confidence only (no phoneme/prosody) | **Real-time ($<200\text{ms}$)** | **Free ($0)** | Browser-dependent (best in Chrome/Edge; limited in Firefox). Audio routed to browser vendor. | ✅ **Selected for Live Interim Feedback** |
| **Gemini Multimodal (`gemini-3.5-transcribe` + `gemini-3.8-flash` Audio)** | Native `en` & `ja` audio understanding | Verbatim transcript + acoustic evaluation of phonemes/moras, pacing, stress, and pitch | $1.5\text{s}$–$3.5\text{s}$ post-recording | Covered by configured `GEMINI_API_KEY` (~$0.002/session) | Unified server-side SDK (`@google/genai`), no extra 3P credentials required. | ✅ **Selected Core Assessment Engine** |
| **Azure AI Speech Pronunciation Assessment** ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment)) | `en-US` (IPA phonemes), `ja-JP` (syllable-level only; phoneme strings empty by default) | Objective GOP (Goodness of Pronunciation) phoneme scores for EN; limited phoneme detail for JA | $<1\text{s}$ streaming | **$1.32 / hour** ([Azure Pricing](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/)) | Requires separate Azure subscription key and cloud provisioning. | 🔄 Documented as Optional Enterprise Upgrade |
| **OpenAI Whisper API (`gpt-4o-mini-transcribe` / `whisper-1`)** | 50+ languages (`en`, `ja`) | High-accuracy text & word timestamps; **no acoustic pronunciation/prosody scoring** | $1\text{s}$–$3\text{s}$ | $0.003–$0.006 / min | Requires separate OpenAI API key; auto-corrects pronunciation errors into valid text. | ❌ Redundant given `gemini-3.5-transcribe` |

---

## 4. Proposed System Architecture & Data Strategy

### 4.1 High-Level Architecture & Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                        CLIENT BROWSER (React 19 + Tailwind CSS)                          │
│                                                                                          │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Top Navigation Bar: [EchoSense] ── [Studio · Vocabulary · History · Guide] ── [CTA]│  │
│  └────────────────────────────────────────────────────────────────────────────────────┘  │
│               │                                                    │                     │
│               ▼                                                    ▼                     │
│  ┌─────────────────────────────────────────┐   ┌──────────────────────────────────────┐  │
│  │ LEFT STAGE (60% Desktop Width)          │   │ RIGHT CONTROL & READER DECK (40%)    │  │
│  │                                         │   │                                      │  │
│  │ • Video Ingestion Bar & Curated Picker  │   │ • Synchronized Transcript Reader     │  │
│  │ • Embedded YouTube IFrame Player        │   │   - Auto-scroll & Click-to-Seek      │  │
│  │ • Transport & Loop Bar (Speed, A-B Loop)│   │   - <ruby> Furigana & Token Hover    │  │
│  │ • Shadowing Recorder & Live Waveform    │   │ • Contextual Dictionary Popover      │  │
│  │   - Mode: Listen-Then-Repeat / Simult.  │   │   - IPA / Furigana / Pitch / Save    │  │
│  │   - Web Speech API Live Interim Stream  │   │ • Multi-Dimensional Feedback Drawer  │  │
│  │   - User Audio vs. Video A/B Replay     │   │   - 4-Pillar Score & Word Diff       │  │
│  └───────────────────┬─────────────────────┘   └───────────────────┬──────────────────┘  │
│                      │                                             │                     │
│                      └──────────────────────┬──────────────────────┘                     │
│                                             ▼                                            │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Local Persistence Layer (IndexedDB + localStorage + JSON/CSV Exporter)             │  │
│  │ • Saved Vocabulary Vault   • Practice Session History   • Cached Video Transcripts │  │
│  └────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────┬────────────────────────────────────────────┘
                                              │ HTTP REST JSON (/api/*)
                                              ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                         BACKEND SERVER (Node.js + Express)                               │
│                                                                                          │
│  ┌──────────────────────────┐  ┌──────────────────────────┐  ┌────────────────────────┐  │
│  │ POST /api/transcript     │  │ POST /api/dictionary     │  │ POST /api/shadowing    │  │
│  │ • InnerTube Caption Fetch│  │ • Contextual Definition  │  │   /evaluate            │  │
│  │ • Sentence Segmentation  │  │ • EN IPA + FreeDict API  │  │ • Audio Transcription  │  │
│  │ • JA Furigana Annotation │  │ • JA Lemma, Reading &    │  │ • Multimodal Acoustic  │  │
│  │ • Manual Text Aligner    │  │   Pitch Accent Notes     │  │   & Prosody Assessment │  │
│  └────────────┬─────────────┘  └────────────┬─────────────┘  └───────────┬────────────┘  │
│               │                             │                            │               │
│               └─────────────────────────────┼────────────────────────────┘               │
│                                             ▼                                            │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Shared Server-Side @google/genai Client (User-Agent: 'aistudio-build')             │  │
│  │ • gemini-3.8-flash (Multimodal Audio Coaching, Furigana & Contextual Lexicon)      │  │
│  │ • gemini-3.5-transcribe (Verbatim Speech-to-Text Transcription)                    │  │
│  │ • gemini-3.8-flash-lite-tts (Reference Pronunciation Audio Synthesis)              │  │
│  └────────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Core Workflow Sequence — Listen-Then-Repeat Shadowing & Multimodal Assessment

```
Learner                  YouTube IFrame         Browser Audio/STT          Express Backend (@google/genai)
  │                            │                        │                                │
  │── 1. Start Segment Loop ──►│                        │                                │
  │                            │── Plays Segment (t0-t1)│                                │
  │                            │── Auto-Pauses at t1 ──►│                                │
  │                            │                        │── 2. Starts Mic Capture        │
  │   Speaks sentence aloud ───┼───────────────────────►│   (MediaRecorder + Analyser)   │
  │◄── Live waveform & interim Web Speech words ────────│                                │
  │── 3. Stops / Auto-Finishes─┼───────────────────────►│                                │
  │                            │                        │── 4. POST /api/shadowing/eval ─►│
  │                            │                        │   (Base64 Audio + Target Seg   │
  │                            │                        │    + Web Speech Interim Text)  │
  │                            │                        │                                │── 5. gemini-3.5-transcribe
  │                            │                        │                                │   (Verbatim acoustic STT)
  │                            │                        │                                │── 6. gemini-3.8-flash
  │                            │                        │                                │   (Multimodal audio + diff
  │                            │                        │                                │    + phoneme/mora rubric)
  │◄── 7. Renders 4-Pillar Score, Word Diff, Error Attribution & Replay Controls ────────│
```

### 4.3 Data Model & Local Storage Entities
- **`VideoMaterial`**: `videoId`, `title`, `channel`, `language` (`'en' | 'ja'`), `captionSource` (`'youtube_manual' | 'youtube_asr' | 'curated' | 'user_custom'`), `durationSec`, `segments: TranscriptSegment[]`.
- **`TranscriptSegment`**: `id`, `index`, `startTime` (seconds), `endTime` (seconds), `text`, `translation` (optional helper), `tokens: WordToken[]` (surface form, `readingHiragana`, `romaji`, `ipa`, `lemma`, `partOfSpeech`).
- **`ShadowingAttempt`**: `id`, `videoId`, `segmentIds: string[]`, `mode` (`'listen_repeat' | 'simultaneous'`), `timestamp`, `audioDataUrl` (stored in `IndexedDB`), `recognizedText`, `metrics` (`overallScore`, `contentAccuracy`, `pronunciationScore`, `fluencyScore`, `prosodyScore`, `wpmOrMpm`), `wordDiff: DiffToken[]` (`status: 'correct' | 'omitted' | 'substituted' | 'inserted' | 'stt_uncertain'`), `phoneticFeedback: PhonemeTip[]`, `improvementSuggestions: string[]`.
- **`SavedVocabularyItem`**: `id`, `word`, `lemma`, `language` (`'en' | 'ja'`), `reading` (IPA or Hiragana/Romaji), `partOfSpeech`, `contextualMeaning`, `dictionaryDefinition`, `sourceSentence`, `videoId`, `timestampSec`, `createdAt`, `reviewCount`.

---

## 5. UI/UX Design & User Journey

### 5.1 Aesthetic Direction & Domain Design Rules
Following the **Education & Interactive Simulations** design guidelines:
- **Two-Zone Sandbox Layout (1440px Desktop Baseline)**:
  - **Left Zone (60% Width — Interactive Media & Recording Stage)**: Houses the URL/Curated Video Selector, 16:9 YouTube IFrame Player, Playback & Loop Transport Bar ($0.75\times\text{–}1.25\times$ speed, segment prev/next, A–B loop), and the active **Shadowing Studio Deck** (Mode switcher, live 60fps microphone canvas waveform, recording timer, and side-by-side "Play Original Video" vs. "Play My Recording" comparison controls).
  - **Right Zone (40% Width — Synchronized Reader & Diagnostic Deck)**: Houses the auto-scrolling interactive transcript reader with Furigana toggle, inline word-diff overlays after a practice attempt, the floating **Contextual Dictionary Card**, and the expandable **Performance Analysis Report**.
- **Color Palette (60-30-10 Discipline)**:
  - **60% Dominant Canvas**: Crisp Alabaster Slate (`#F8FAFC`) for comfortable long-form bilingual reading without eye strain.
  - **30% Structural Surfaces**: Pure White (`#FFFFFF`) elevated panels with `1px solid #E2E8F0` hairline borders and Deep Ink (`#0F172A`) primary typography.
  - **10% Semantic Focal Accents** (always paired with explicit text/icon labels—never color alone):
    - *Primary Interactive / Active Sync*: Studio Indigo (`#0284C7` Cerulean / `#2563EB` Royal Blue).
    - *Nominal / Accurate Match*: Emerald (`#059669`) paired with `✓ Matched` label.
    - *Attention / Pronunciation Tip*: Warm Amber (`#D97706`) paired with `▲ Articulation Tip` label.
    - *Omitted / Substituted Word*: Coral Red (`#DC2626`) paired with strikethrough/underline and explicit diff tag.
- **Typography (2+1 Font Rule)**:
  - *Display & Section Headings*: `Plus Jakarta Sans` (SemiBold 600, tight tracking, `text-wrap: balance`).
  - *Bilingual Body & Transcript Prose*: `DM Sans` paired with system CJK fonts (`Hiragino Sans`, `Noto Sans JP`) at generous `18px` transcript size (`line-height: 2.1` in Japanese mode to provide vertical clearance for `<ruby>` Furigana annotations without line collisions).
  - *Timestamps, Metrics & IPA/Phonetics*: `IBM Plex Mono` with `tabular-nums` for vertical timestamp alignment (`01:24.5`).
- **Top Bar Contract**:
  - Strictly one row with three zones separated by `gap-8`:
    1. **Brand Wordmark**: `EchoSense`
    2. **Navigation Links**: `Practice Studio` · `Curated Library` · `Vocabulary Vault` · `Session History`
    3. **Primary Action CTA**: `Export Study Data`

### 5.2 Conceptual Screen Layout (Studio Workspace)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ EchoSense             Practice Studio · Curated Library · Vocabulary Vault · History     │
├───────────────────────────────────────────────────┬──────────────────────────────────────┤
│ [YouTube URL Input ....................] [Load]   │ TRANSCRIPT & DICTIONARY   [Furigana] │
│ Curated: EN: TED Talk · JA: Daily NHK · JA: Anime │                                      │
│ ┌───────────────────────────────────────────────┐ │ 00:04.2                              │
│ │                                               │ │ We often underestimate how much      │
│ │         YOUTUBE IFRAME VIDEO PLAYER           │ │ daily rhythm shapes our fluency.     │
│ │                  (16:9 Stage)                 │ │                                      │
│ │                                               │ │ 00:08.7  [ACTIVE SEGMENT · LOOPING]  │
│ └───────────────────────────────────────────────┘ │ 言葉(ことば) の リズム を そのまま   │
│ [|< Prev] [Play/Pause] [Next >|]  Speed: [1.0x]   │ 真似(まね) して 声(こえ) に 出(だ)す │
│                                                   │                  ▲                   │
│ ┌─ SHADOWING STUDIO ────────────────────────────┐ │   ┌─ Contextual Dictionary ────────┐ │
│ │ Mode: [Listen-Then-Repeat] [Simultaneous]     │ │   │ 真似 (まね · mane)  · Noun/Suru│ │
│ │ ████████▒▒▒▒▓▓▓▓████░░░░  Mic Ready · 00:04.5 │ │   │ In this sentence: "Imitating   │ │
│ │ [ ● Record Shadowing ]  [ ↺ Replay My Voice ] │ │   │ or mimicking a model closely." │ │
│ │ Live STT: "ことば の りずむ を そのまま..."   │ │   │ [🔊 Listen]  [+ Save to Vault] │ │
│ └───────────────────────────────────────────────┘ │   └────────────────────────────────┘ │
└───────────────────────────────────────────────────┴──────────────────────────────────────┘
```

---

## 6. Phased Implementation Plan

### Phase 1: Technical Proof of Concept (High-Risk Capabilities Validation)
- **Objectives & Scope**: Validate the three highest-risk technical pipelines—server-side YouTube caption ingestion, Japanese Furigana/token segmentation, and multimodal Gemini audio assessment—before building complex UI views.
- **Tasks**:
  1. Set up the Express API server (`server.ts`) and shared `@google/genai` client (`User-Agent: 'aistudio-build'`).
  2. Implement `/api/transcript/fetch` to retrieve English and Japanese caption tracks from YouTube URLs, falling back cleanly when restricted, and re-segmenting fragmented captions via `gemini-3.8-flash`.
  3. Implement `/api/shadowing/evaluate` accepting base64 audio + target sentence and returning a structured JSON rubric (`responseSchema`) using `gemini-3.5-transcribe` and `gemini-3.8-flash`.
- **Deliverables**: Working backend API endpoints verified with English and Japanese payloads.
- **Acceptance Criteria**: Valid captioned YouTube URLs return timestamped sentences; audio payloads return structured content accuracy, pronunciation, fluency, and prosody scores.
- **Estimated Effort & Risks**: ~15% of build effort. *Risk*: YouTube cloud IP blocking $\rightarrow$ *Mitigation*: Built-in curated bilingual transcripts + custom transcript paste/alignment endpoint.

### Phase 2: Application Foundation & YouTube Video Stage
- **Objectives & Scope**: Establish the responsive 1440px Two-Zone Studio layout, Top Bar navigation, Curated Bilingual Video Library, and YouTube IFrame Player controller.
- **Tasks**:
  1. Build the 3-zone header (`EchoSense` wordmark, view navigation tabs, and data export trigger).
  2. Create the YouTube IFrame wrapper with programmatic `seekTo`, `playVideo`, `pauseVideo`, `setPlaybackRate` ($0.5\times\text{–}1.5\times$), and $100\text{ms}$ `getCurrentTime()` synchronization hook.
  3. Include a Curated Starter Library (3 English + 3 Japanese videos with verified high-accuracy transcripts and Furigana) so users can test every feature immediately on load.
- **Acceptance Criteria**: Selecting a curated video or entering a valid YouTube URL loads the embedded player, updates playback state accurately, and supports segment A–B looping.

### Phase 3: Synchronized Transcript Reader & Custom Transcript Fallback
- **Objectives & Scope**: Deliver the interactive transcript panel synchronized with video playback, plus graceful handling for videos without native captions.
- **Tasks**:
  1. Render timestamped sentence segments alongside the video with active segment highlighting and smooth auto-scroll.
  2. Wire segment clicks to jump the YouTube player directly to `segment.startTime`.
  3. Build the **Transcript Fallback & Editor Modal** so users can paste raw transcript text or upload SRT/VTT when a third-party YouTube video disables captions, using Gemini to segment and align timestamps.
  4. Display clear transcript source & confidence indicators (`Verified Captions`, `Auto-Generated Captions (AI Punctuated)`, or `Custom User Transcript`).
- **Acceptance Criteria**: Clicking any transcript line seeks the video within $<150\text{ms}$; seeking the video updates the highlighted transcript line; uncaptioned URLs display a clear explanation and one-click fallback editor.

### Phase 4: Interactive Bilingual Dictionary, Japanese Furigana & Vocabulary Vault
- **Objectives & Scope**: Enable instant, unobtrusive word lookup for English and Japanese directly inside the transcript reader.
- **Tasks**:
  1. Render Japanese segments with toggleable `<ruby>` Furigana annotations above Kanji compounds and optional Romaji sub-lines.
  2. Tokenize English and Japanese sentences into interactive word spans supporting desktop hover/click and mobile tap.
  3. Implement `/api/dictionary/lookup` + client cache returning contextual sentence meaning, dictionary definition, part of speech, English IPA or Japanese Hiragana/Romaji/Pitch Accent note, and optional reference TTS audio (`gemini-3.8-flash-lite-tts`).
  4. Build the **Vocabulary Vault** view backed by `localStorage`/`IndexedDB` with search, language filter, source video jump link, and Anki-ready CSV / JSON export.
- **Acceptance Criteria**: Japanese Kanji display accurate contextual Furigana; clicking any English or Japanese word opens the contextual dictionary popover in $<1\text{s}$ (instant on cached words) and allows saving to the Vocabulary Vault.

### Phase 5: Dual-Mode Shadowing Studio & Browser Audio Capture
- **Objectives & Scope**: Build the recording studio supporting both **Listen-Then-Repeat** and **Simultaneous** shadowing workflows.
- **Tasks**:
  1. Implement **Listen-Then-Repeat Mode**: plays the selected sentence on YouTube, automatically pauses at `segment.endTime`, triggers microphone recording for the target duration (plus configurable buffer), and lets the user advance or retry.
  2. Implement **Simultaneous Mode**: plays a selected range or full video continuously while recording overlapping user speech.
  3. Build the Web Audio `AnalyserNode` live waveform visualizer, microphone permission/error handler, and real-time `SpeechRecognition` (`en-US` / `ja-JP`) interim transcript stream.
  4. Provide instant post-recording A/B playback (`Play Original Video Segment` vs. `Play My Recorded Voice`).
- **Acceptance Criteria**: Microphone denial, muted input, or unsupported Web Speech browsers degrade gracefully with clear instructions; recorded audio plays back cleanly in the browser.

### Phase 6: Multimodal AI Performance Analysis & Diagnostic Report
- **Objectives & Scope**: Compare the user's spoken audio and transcript against the original segment and generate an actionable, pedagogically sound report.
- **Tasks**:
  1. Compute deterministic token-level alignment (matches, omissions, substitutions, insertions) combined with Gemini's acoustic uncertainty check (distinguishing likely STT misrecognitions from genuine pronunciation slips).
  2. Render the **4-Dimension Performance Scorecard**:
     - **Content Accuracy** (Objective word/morpheme match %)
     - **Pronunciation & Articulation** (Multimodal acoustic assessment of phonemes/moras)
     - **Fluency & Pacing** (Objective WPM/MPM speech rate & pause continuity)
     - **Prosody & Intonation** (Multimodal acoustic assessment of stress, rhythm & pitch contour)
  3. Display transparent methodology notes explaining how the overall score is weighted ($35\%$ Content, $30\%$ Pronunciation, $20\%$ Fluency, $15\%$ Prosody) and clearly labeling objective metrics vs. AI acoustic estimates.
  4. Provide **Targeted Phrase Retry** buttons that jump straight back into Listen-Then-Repeat practice for specific problem words or segments.
- **Acceptance Criteria**: Completing a shadowing session produces a structured 4-pillar report, highlights word-level diffs directly in the transcript, lists specific phoneme/mora tips, and saves the attempt to Session History.

### Phase 7: Session History, Progress Analytics & Data Portability
- **Objectives & Scope**: Enable learners to track improvement over time and export their learning data.
- **Tasks**:
  1. Build the **Session History** view listing past shadowing attempts with scores, dates, language tags, and audio/report review.
  2. Add JSON backup/restore and CSV vocabulary export handlers.
- **Acceptance Criteria**: Users can reload the page and retain all saved vocabulary and session reports, replay past recordings from `IndexedDB`, and download valid CSV/JSON files.

### Phase 8: Comprehensive Validation, Accessibility & Polish
- **Objectives & Scope**: Run end-to-end automated compilation, lint checks, responsive layout verification (desktop, tablet, mobile), and manual test documentation.

---

## 7. Testing & Quality Assurance Strategy

### Automated & Technical Checks
- **TypeScript & Build Verification**: Zero compilation or type errors via `compile_applet` and `lint_applet`.
- **API Contract Validation**: Verify `/api/transcript`, `/api/dictionary`, `/api/tts`, and `/api/shadowing/evaluate` handle malformed URLs, missing captions, empty audio blobs, and network timeouts with structured JSON error messages.

### Bilingual & Edge-Case Test Scenarios

| Test Area | English (`en-US`) Scenario | Japanese (`ja-JP`) Scenario | Edge Case / Failure Handling |
| :--- | :--- | :--- | :--- |
| **Transcript & Sync** | Load English talk; verify sentence boundaries, click-to-seek, and $100\text{ms}$ active highlight tracking. | Load Japanese clip; verify `<ruby>` Furigana alignment and multi-clause sentence timestamps. | Enter invalid URL or video with disabled captions $\rightarrow$ verify fallback paste/align modal triggers cleanly. |
| **Dictionary Lookup** | Click polysemous English word (e.g., *"run"* or *"bank"*); verify contextual meaning + IPA `/rʌn/`. | Click conjugated Japanese verb/Kanji (e.g., 走っている); verify lemma (走る), Hiragana (はしる), Romaji, and contextual meaning. | Rapidly click multiple words or offline state $\rightarrow$ verify cached lookups and clean loading indicator. |
| **Shadowing & Mic** | Record in Listen-Then-Repeat mode; verify video auto-pauses at sentence end and mic starts automatically. | Record Japanese sentence in Simultaneous mode; verify `ja-JP` live speech recognition and audio capture. | Deny microphone permission in browser $\rightarrow$ verify clear recovery banner explaining how to re-enable mic access. |
| **Assessment Accuracy** | Intentionally omit 2 words and mispronounce a `/θ/` sound; verify omission badge + phonetic tip. | Speak with unnatural pauses or drop a particle (`を` / `は`); verify particle omission diff + moraic rhythm feedback. | Submit very short ($<1\text{s}$) or silent audio $\rightarrow$ verify system flags "No clear speech detected" instead of hallucinating a score. |

---

## 8. Cost & Operational Considerations

### Recurring Service Cost Breakdown (Per 1,000 Active Practice Sessions)
Assuming an average shadowing session processes a 3-minute YouTube transcript once and evaluates five 10-second spoken audio recordings:

| Component | Recommended Stack (MVP) | Estimated Cost per 1,000 Sessions | Production / Alternative Stack | Alternative Cost per 1,000 Sessions |
| :--- | :--- | :--- | :--- | :--- |
| **Video Playback** | YouTube IFrame Player API | **$0.00** (Free) | Self-hosted video CDN | $15–$50+ (Bandwidth) |
| **Transcript Extraction & Furigana** | InnerTube + `gemini-3.8-flash` | **~$0.40 – $0.80** | Paid scraping proxy + NLP server | $5.00 – $15.00 |
| **Live Speech Preview** | Browser `SpeechRecognition` API | **$0.00** (Free in browser) | Deepgram Nova-2 Streaming ($0.35/hr) | ~$4.85 |
| **Multimodal Audio Assessment & Feedback** | `gemini-3.5-transcribe` + `gemini-3.8-flash` | **~$1.50 – $2.50** (via `GEMINI_API_KEY`) | Azure Speech Pronunciation ($1.32/hr) + LLM | ~$18.30 (Azure) + $1.50 (LLM) |
| **Storage & Persistence** | Browser `IndexedDB` + `localStorage` | **$0.00** (Client-side) | Cloud SQL / Firestore | $0.50 – $5.00 |
| **Total Operating Cost** | **Recommended Hybrid MVP** | **~$1.90 – $3.30 / 1k sessions** | **All-Cloud Commercial APIs** | **~$30.00 – $40.00+ / 1k sessions** |

### Privacy, Licensing & Maintenance Considerations
- **Audio Privacy**: User voice recordings are kept strictly in the user's local browser (`IndexedDB`) for replay and transmitted ephemerally to the server-side Gemini endpoint only when the user requests AI evaluation. No third-party analytics or permanent cloud audio buckets are used.
- **YouTube Platform Compliance**: Videos are played strictly through the official embedded YouTube IFrame Player (preserving creator views and platform attribution) rather than ripping or hosting copyrighted video/audio streams.
- **API Key Security**: All `@google/genai` calls execute strictly on the Express backend using `process.env.GEMINI_API_KEY`; keys are never exposed in client bundles.

---

## 9. Risks, Open Questions & Final MVP Recommendations

### Key Technical Risks & Mitigations
1. **YouTube Caption Availability & Cloud IP Throttling**: Third-party caption scraping can fail if a creator disables subtitles or if YouTube rate-limits datacenter IPs.
   - *Mitigation*: Combine multi-strategy server caption extraction with a **Pre-Loaded Curated Bilingual Video Library** (guaranteed instant onboarding) and an **Interactive Transcript Paste/Align Drawer**.
2. **Distinguishing Pronunciation Errors from Acoustic/STT Noise**: Background noise or non-native accents can cause speech-to-text models to hallucinate word substitutions.
   - *Mitigation*: Feed raw audio directly to `gemini-3.8-flash` alongside the verbatim transcript so the model can hear whether the phoneme was actually articulated, and label uncertain tokens as `Possible Mic/STT Noise` rather than penalizing the learner unfairly.
3. **Browser Compatibility for Live Web Speech API**: `SpeechRecognition` is supported in Chrome, Edge, and Safari, but restricted in Firefox.
   - *Mitigation*: Use `MediaRecorder` + server-side `gemini-3.5-transcribe` as the universal source of truth across all browsers, treating client-side `SpeechRecognition` as a progressive real-time visual enhancement.

### Recommended Minimum Viable Product (MVP) Execution Order
To minimize technical risk and deliver immediate learning value, we recommend executing **Phases 1 through 7** as a unified, production-ready full-stack application:
1. Build the Express backend (`/api/transcript`, `/api/dictionary`, `/api/tts`, `/api/shadowing/evaluate`) first to lock in reliable bilingual NLP and multimodal audio assessment.
2. Pair it with the synchronized YouTube IFrame Studio, Curated EN/JA Starter Library, Furigana & Contextual Dictionary Popover, Dual-Mode Shadowing Recorder, and 4-Pillar Diagnostic Report backed by local browser storage and CSV/JSON export.
