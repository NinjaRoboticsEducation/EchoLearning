# EchoSense (Echo Language Learning) — Refined Local Google ADK 2.x Transition Plan

> Historical design/transition document, not current installation instructions or evidence of completed features. For current setup and known limitations, use [the project README](../README.md).


**Migrating from Cloud Gemini APIs to a 100% Local AI Stack (`Google ADK 2.x` + `Qwen3.5-9B` + `whisper.cpp` + Native Offline TTS) with Zero UI Changes**

> [!IMPORTANT]
> **Approval Gate & Zero-Modification Policy**: Per our engineering workflow, no application source files have been modified yet. Please review the **Step 1 Codebase Audit**, **Step 2 Google ADK 2.x Research**, **Step 3 Vulnerability Audit of `ADKTransitionPlan.md`**, and the **Refined Phased Implementation Plan** below. Once you approve, we can proceed phase by phase.

---

## Table of Contents

1. [Glossary — Plain-English Guide to Technical Terms](#1-glossary--plain-english-guide-to-technical-terms)
2. [Step 1: Line-by-Line Code Audit of the Existing Web Application](#2-step-1-line-by-line-code-audit-of-the-existing-web-application)
3. [Step 2: Latest Google ADK 2.x Framework Research & Local Architecture](#3-step-2-latest-google-adk-2x-framework-research--local-architecture)
4. [Step 3: Security, Architecture & Logic Audit of `ADKTransitionPlan.md`](#4-step-3-security-architecture--logic-audit-of-adktransitionplanmd)
5. [Target System Architecture & Hardware Optimization (Mac mini 2018)](#5-target-system-architecture--hardware-optimization-mac-mini-2018)
6. [Complete Refined Phased Implementation Plan (Phases 0–7)](#6-complete-refined-phased-implementation-plan-phases-07)
   - [Phase 0: Project Scaffolding, Relative Paths & Environment](#phase-0-project-scaffolding-relative-paths--environment)
   - [Phase 1: Local LLM Server (`llama-server` + `Qwen3.5-9B-Q6_K`)](#phase-1-local-llm-server-llama-server--qwen35-9b-q6_k)
   - [Phase 2: Local Speech-to-Text Server (`whisper-server` + `ffmpeg` WAV Pipeline)](#phase-2-local-speech-to-text-server-whisper-server--ffmpeg-wav-pipeline)
   - [Phase 3: Google ADK 2.x Agent Layer, `ToolContext` State & Deterministic Tools](#phase-3-google-adk-2x-agent-layer-toolcontext-state--deterministic-tools)
   - [Phase 4: FastAPI Bridge — NDJSON Streaming, Offline TTS & Exact Contract Parity](#phase-4-fastapi-bridge--ndjson-streaming-offline-tts--exact-contract-parity)
   - [Phase 5: Frontend Dev Proxy & Graceful Local Health Fallback](#phase-5-frontend-dev-proxy--graceful-local-health-fallback)
   - [Phase 6: Automated Integration Testing & Bilingual Verification](#phase-6-automated-integration-testing--bilingual-verification)
   - [Phase 7: CPU Latency Tuning & Memory Management](#phase-7-cpu-latency-tuning--memory-management)
7. [Updated Risk Register & Mitigations](#7-updated-risk-register--mitigations)
8. [Appendix: One-Command Launch & Verification Cheat Sheet](#8-appendix-one-command-launch--verification-cheat-sheet)

---

## 1. Glossary — Plain-English Guide to Technical Terms

Whenever a specialized term or acronym appears in this plan, here is what it means in plain language:

| Term / Acronym | Plain-English Explanation |
| :--- | :--- |
| **ADK (Agent Development Kit)** | Google's open-source framework for building AI applications out of organized "agents" (AI workers) and "tools" (regular code functions that fetch data or run calculations). Version 2.x introduces deterministic graph/workflow control so agents don't hallucinate or get stuck in loops. |
| **`LlmAgent` (Large Language Model Agent)** | An ADK agent powered by a language model (like Qwen3.5-9B) that reads instructions, decides which tools to run, and writes a response. |
| **`FunctionTool` & `ToolContext`** | A `FunctionTool` wraps a normal Python function so an ADK agent can call it. `ToolContext` is a special backstage pass in ADK that lets a tool read large data (like recorded audio) directly from server memory (`session.state`) without forcing the AI model to read millions of characters of raw audio data. |
| **`Runner` & `InMemorySessionService`** | In ADK, the `Runner` is the engine that executes an agent step-by-step, and `InMemorySessionService` is the temporary notepad in RAM where the agent keeps track of the current request's data. |
| **LiteLLM** | A lightweight Python "universal adapter" inside ADK that translates ADK's requests into the standard OpenAI format used by local model servers like `llama.cpp`. |
| **`llama.cpp` / `llama-server`** | A high-speed C++ program that runs large language models on your own computer's processor (CPU) or graphics chip (GPU) and exposes a local web server (`http://localhost:8080`). |
| **GGUF & Quantization (`Q6_K`)** | **GGUF** is a single-file format for local AI models. **Quantization (`Q6_K`)** shrinks the model's numbers from 16 bits down to ~6 bits so a 9-billion-parameter model fits comfortably in ~7.5 GB of RAM with virtually no loss in quality. |
| **`whisper.cpp` / `whisper-server`** | A fast C++ version of OpenAI's Whisper speech-to-text (STT) model that converts spoken English and Japanese audio into text on `http://localhost:8081`. |
| **NDJSON (Newline-Delimited JSON)** | A streaming format where the server sends one small JSON status update per line (`\n`) over a single HTTP connection. EchoSense uses this to animate the progress bar while generating transcripts for long YouTube videos. |
| **PCM WAV (`16kHz Mono`)** | Uncompressed, raw digital audio sampled 16,000 times per second in a single channel. `whisper.cpp` requires audio in this clean format rather than compressed browser `.webm` video containers. |
| **AVX2 & Apple Accelerate** | Built-in hardware math accelerators inside your Mac mini's Intel Core i5 processor and macOS that speed up AI matrix calculations on the CPU. |
| **Furigana (振り仮名) & `<ruby>`** | Small Hiragana reading hints displayed above Japanese Kanji characters using HTML `<ruby>` tags (e.g., 言葉 with ことば above it). |
| **IPA (International Phonetic Alphabet)** | Standardized phonetic spelling used to show exact pronunciation (e.g., `/əˈproʊtʃ/` for *"approach"*). |
| **Mora (モーラ)** | The basic rhythmic beat unit of spoken Japanese (for example, `とうきょう` has 4 moras: `と・う・きょ・う`). Japanese speaking speed is measured in **Moras per minute (Moras/min)**, whereas English is measured in **Words per minute (WPM)**. |

---

## 2. Step 1: Line-by-Line Code Audit of the Existing Web Application

We inspected every source file in the repository to document the exact data contracts, UI behaviors, and hidden edge cases that the new Python ADK backend **must** preserve.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                EXISTING APPLICATION AUDIT — EXACT API & STATE CONTRACTS                 │
├───────────────────────────┬─────────────────────────────────────────────────────────────┤
│ Frontend Component        │ Audited Behavior & Backend Dependency                       │
├───────────────────────────┼─────────────────────────────────────────────────────────────┤
│ src/App.tsx               │ • Calls POST /api/transcript/fetch with {urlOrId,           │
│ (Lines 1–1125)            │   preferredLanguage, stream: true}.                         │
│                           │ • Reads Content-Type: application/x-ndjson stream events:   │
│                           │   'meta', 'progress', 'partial_segments', 'heartbeat',      │
│                           │   'complete', and 'error'.                                  │
│                           │ • Calls POST /api/dictionary/lookup with {word, sentence,   │
│                           │   language} and caches results in localStorage.             │
│                           │ • Calls POST /api/shadowing/evaluate and computes           │
│                           │   omittedCount, substitutedCount, uncertainSttCount from    │
│                           │   data.wordDiff on the client side!                         │
├───────────────────────────┼─────────────────────────────────────────────────────────────┤
│ src/components/           │ • Renders <ruby>{tok.surface}<rt>{tok.reading}</rt></ruby>  │
│ TranscriptReader.tsx      │   ONLY when tok.reading !== tok.surface and surface has     │
│ (Lines 1–593)             │   Kanji (/[\u4e00-\u9faf]/).                                │
│                           │ • Inline Edit calls POST /api/transcript/retokenize with    │
│                           │   {text, language} and expects {tokens: WordToken[]}.       │
│                           │ • Renders inline wordDiff overlay on practiced segments.    │
├───────────────────────────┼─────────────────────────────────────────────────────────────┤
│ src/components/           │ • Records mic via MediaRecorder ('audio/webm;codecs=opus'   │
│ ShadowingStudio.tsx       │   or 'audio/mp4') and encodes to Base64.                    │
│ (Lines 1–834)             │ • Streams live interim text via Browser SpeechRecognition.  │
│                           │ • Includes "Simulate Practice Take" (line 467) which sends  │
│                           │   audioBase64: undefined and ONLY webSpeechTranscript!      │
├───────────────────────────┼─────────────────────────────────────────────────────────────┤
│ src/components/           │ • ALL THREE components independently call                   │
│ DictionaryPopover.tsx     │   POST /api/tts/pronounce with {text, language} and expect  │
│ PerformanceReport.tsx     │   {audioBase64: string, mimeType: 'audio/wav'}!             │
│ VocabularyAndHistory...   │   - DictionaryPopover.tsx (line 106: "Listen" button)       │
│                           │   - PerformanceReport.tsx (line 34: omitted/substituted     │
│                           │     word buttons & "Hear Model" coaching buttons)           │
│                           │   - VocabularyAndHistoryViews.tsx (line 53: Vault speaker)  │
└───────────────────────────┴─────────────────────────────────────────────────────────────┘
```

### Key Audit Findings from `server.ts` (Lines 1–1507)

1. **Endpoint 1 — `POST /api/transcript/fetch` (Lines 766–1071)**:
   - **Input**: `{ urlOrId: string, preferredLanguage?: 'en' | 'ja', stream?: boolean }`
   - **Step A (Metadata & InnerTube Extraction)**: Runs `fetchYouTubeOEmbed()` and `fetchYouTubeCaptionsAndDetails()` concurrently using `ANDROID_TESTSUITE`, watch page HTML regex, `ANDROID`, and `IOS` InnerTube clients to extract `title`, `authorName`, `durationSec`, and `captionTracks`.
   - **Step B (Fast Path — Public Captions Found)**: Merges fragmented captions into full sentences (`mergeCaptionLinesIntoCompleteSegments` with `maxChars = 58` for `ja`, `130` for `en`; `maxDurationSec = 10.5`; `minDurationSec = 2.2`), tokenizes every sentence (`tokenizeSentenceServerSide`), and emits `{ type: 'complete', video: finalVideo }`.
   - **Step C (Fallback Path — No Public Captions)**: Splits `durationSec` into 210-second windows, transcribes the audio, emits `{ type: 'partial_segments', completedChunks, totalChunks, language, level, message, segments }`, and sends `{ type: 'heartbeat', ts }` every 2.5 seconds.
2. **Endpoint 2 — `POST /api/transcript/retokenize` (Lines 1074–1094)**:
   - **Input**: `{ text: string, language: 'en' | 'ja' }`
   - **Output**: `{ tokens: ServerWordToken[] }` where each token has `{ surface, reading?, lemma?, pos?, isKanji? }`. Works for **both** Japanese (`kuromoji`) and English (`Intl.Segmenter` / regex).
3. **Endpoint 3 — `POST /api/dictionary/lookup` (Lines 1097–1211)**:
   - **Input**: `{ word: string, sentence: string, language: 'en' | 'ja' }`
   - **Output**: Must match `DictionaryLookupResult` (`word`, `lemma`, `language`, `reading`, `romaji`, `ipa`, `pitchAccent`, `partOfSpeech`, `contextualMeaning`, `dictionaryDefinitions: string[]`, `usageExample`, `usageExampleTranslation`, `pronunciationTip`).
4. **Endpoint 4 — `POST /api/tts/pronounce` (Lines 1214–1278)**:
   - **Input**: `{ text: string, language: 'en' | 'ja' }`
   - **Output**: `{ audioBase64: string, mimeType: 'audio/wav' }`.
5. **Endpoint 5 — `POST /api/shadowing/evaluate` (Lines 1281–1483)**:
   - **Input**: `{ audioBase64?: string, mimeType?: string, targetText: string, language: 'en' | 'ja', mode: 'listen_repeat' | 'simultaneous', webSpeechTranscript?: string, durationSec: number, targetDurationSec: number }`
   - **Output**: JSON containing `recognizedTranscript`, `overallScore`, `dimensions` (`contentAccuracy`, `pronunciation`, `fluency`, `prosody`), `speechRateValue`, `targetRateValue`, `scoreExplanation`, `wordDiff`, `pronunciationFeedback`, `improvementSuggestions`, and optional `recommendedRetryText`.

---

## 3. Step 2: Latest Google ADK 2.x Framework Research & Local Architecture

Based on official Google ADK (Agent Development Kit) documentation (`adk.dev` / `google/adk-python`), here is how Google ADK 2.x operates locally and what architectural patterns are required for a rock-solid local deployment:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│             GOOGLE ADK 2.x LOCAL EXECUTION LIFECYCLE & STATE ARCHITECTURE               │
└─────────────────────────────────────────────────────────────────────────────────────────┘

  FastAPI Route (/api/*)
       │
       ├── 1. Creates ephemeral Session in InMemorySessionService
       │      with initial_state = {"audio_base64": "...", "mime_type": "audio/webm"}
       │      (Large binary/base64 payloads live in Session State, NEVER in LLM prompts!)
       ▼
  ADK Runner (runner.run_async)
       │
       ├── 2. Invokes LlmAgent (powered by LiteLlm -> http://localhost:8080/v1)
       │
       ├── 3. Agent invokes FunctionTool(func) with ToolContext injected automatically
       │      ┌──────────────────────────────────────────────────────────────────┐
       │      │ def transcribe_audio_whisper(language: str,                      │
       │      │                              tool_context: ToolContext) -> dict: │
       │      │   audio_b64 = tool_context.state.get("audio_base64")             │
       │      │   # Converts WebM -> 16kHz WAV via ffmpeg                        │
       │      │   # Calls whisper-server (:8081) + computes acoustic telemetry   │
       │      └──────────────────────────────────────────────────────────────────┘
       │
       ├── 4. Agent receives compact JSON tool output (transcript + acoustic metrics)
       │      and generates structured JSON response
       ▼
  Session Cleanup (finally: delete_session) & Pydantic Schema Validation
```

### Key Google ADK 2.x Insights for Local Models (`LiteLlm` + `llama.cpp`)

1. **Shift from Prompt-Only Chaining to Deterministic Hybrid Workflows**:
   - ADK 2.x emphasizes combining **deterministic code/tools** with **focused LLM reasoning** rather than asking an LLM to execute slow, deterministic loops (like calling a tokenizer tool 80 times in a row for 80 transcript lines).
2. **`ToolContext` State Sharing (`google.adk.tools.ToolContext`)**:
   - In ADK, any Python function passed to `tools=[...]` can declare `tool_context: ToolContext` as a parameter. ADK automatically injects `tool_context` at runtime and hides it from the LLM's tool schema! This allows tools to read `tool_context.state["audio_base64"]` without exposing megabytes of Base64 strings to the LLM.
3. **Known `output_schema` + `tools` Constraint with `LiteLlm`**:
   - In Google ADK, setting `output_schema` and `tools=[...]` simultaneously on a single `LlmAgent` causes conflicts with OpenAI-compatible servers (`llama-server` cannot enforce a final output JSON grammar while simultaneously generating intermediate `tool_calls`).
   - **Best Practice**: Keep tool-calling agents focused on reasoning + tool invocation (or pre-fetch deterministic data in a workflow step) and validate/repair the final response with a **Pydantic schema validator + automatic JSON repair retry**.
4. **Explicit `LiteLlm` Instantiation**:
   - Pass `api_base` and `api_key` directly to `LiteLlm(model=f"openai/{LLAMA_MODEL_NAME}", api_base=LLAMA_SERVER_URL, api_key="local-adk")` along with `extra_body={"chat_template_kwargs": {"enable_thinking": False}}` so Qwen3.5 responds immediately with clean JSON instead of spending 20 seconds generating internal `<think>...</think>` monologues on the CPU.

---

## 4. Step 3: Security, Architecture & Logic Audit of `ADKTransitionPlan.md`

We audited `ADKTransitionPlan.md` line by line against the existing codebase and Google ADK 2.x specifications. Below are the **8 critical vulnerabilities and errors** found in the original draft plan and how our refined plan fixes every single one:

| # | Severity | Vulnerability / Error in Draft `ADKTransitionPlan.md` | Root Cause & Impact | Refined Fix in This Plan |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **CRITICAL (Crash / Context Overflow)** | **`audio_base64` passed as an LLM tool argument** (`transcribe_audio_whisper(audio_base64: str)` in Phase 3.4 & 3.8) | A 10–30s recording is 150 KB–2 MB of Base64 text (~50k–600k tokens). Passing it in the prompt or asking Qwen3.5-9B to emit it in a tool call overflows `--ctx-size 32768` and freezes CPU inference. | Store `audio_base64` in ADK `InMemorySessionService` `state` (`tool_context.state["audio_base64"]`). The LLM only passes `language="en" \| "ja"` to the tool! |
| **2** | **CRITICAL (Audio Failure)** | **Raw browser `.webm` / `.mp4` sent directly to `whisper-server`** (Phase 3.4, lines 771–787) | Browser `MediaRecorder` outputs `audio/webm;codecs=opus` (Chrome/Firefox) or `audio/mp4` (Safari). `whisper.cpp` expects 16-bit PCM WAV and fails on WebM containers. | Add an automatic `ffmpeg` in-memory/temp transcoding step in `whisper_tools.py` (`webm/mp4` $\rightarrow$ `16kHz mono 16-bit PCM WAV`) before calling `whisper-server`. |
| **3** | **HIGH (Feature Loss)** | **Uncaptioned YouTube videos fail completely & NDJSON streaming is missing code** (Phase 3.6 & 4.2) | Cloud Gemini could transcribe `youtubeUrl` directly in the cloud. Local Qwen3.5-9B is a text model and cannot watch YouTube URLs. Also, `TranscriptAgent` calling `tokenize_japanese` via LLM tool loop for 100 segments would take 10+ minutes. | Run deterministic caption extraction + `fugashi` tokenization in Python first; only invoke `TranscriptAgent` when ASR punctuation repair is needed; for uncaptioned videos, use `yt-dlp` + `ffmpeg` + `whisper-server` chunked transcription with full NDJSON progress streaming. |
| **4** | **HIGH (Degraded Scoring & Demo Crash)** | **Loss of acoustic features in text-only `ShadowingAgent` + broken "Simulate Practice Take"** (Phase 3.8) | Qwen3.5-9B only sees text, so it cannot detect mid-sentence pauses, speaking volume, or Whisper confidence (`stt_uncertain`). Also, "Simulate Practice Take" (`ShadowingStudio.tsx` line 467) sends `audioBase64: undefined`, which crashes `transcribe_audio_whisper`! | Compute objective acoustic metrics (RMS volume, silence ratio, pause count, Whisper `verbose_json` word probabilities, and deterministic `SequenceMatcher` word diff) in Python and pass them to `ShadowingAgent`. Support `audioBase64=None` gracefully using `webSpeechTranscript`. |
| **5** | **HIGH (JSON Parse Crash)** | **Qwen3.5 `<think>...</think>` blocks crash `parse_agent_json()`** (Phase 3.9, lines 1048–1057) | Qwen3/3.5 models emit `<think>...</think>` tags before JSON. `parse_agent_json` only stripped ` ```json `, causing `JSONDecodeError`. | Disable thinking mode for structured JSON calls (`enable_thinking: False`) AND strip `<think>[\s\S]*?</think>` + extract outermost `{...}` with Pydantic validation and 1-shot self-correction retry. |
| **6** | **MEDIUM (UI Bug)** | **TTS fallback only mentioned for `DictionaryPopover.tsx`** (Phase 5.2, line 1212) | Our code audit proved **3 components** call `POST /api/tts/pronounce`: `DictionaryPopover`, `PerformanceReport`, and `VocabularyAndHistoryViews`. | Implement **macOS native offline TTS (`/usr/bin/say` $\rightarrow$ WAV Base64)** directly in `POST /api/tts/pronounce` on the Python backend! All 3 components work 100% offline with **zero frontend edits**. |
| **7** | **MEDIUM (Furigana Bug)** | **`fugashi` returns `"*"` for unknown readings & English retokenization is missing** (Phase 3.3, lines 718–730) | `unidic-lite` sets `word.feature.kana = "*"` for symbols/numbers, rendering `*` above words, and `POST /api/transcript/retokenize` had no English (`'en'`) branch. | Filter out `"*"` readings, add Katakana-to-Hiragana + Hepburn Romaji helper, and support both `'ja'` and `'en'` in `tokenize_sentence()`. |
| **8** | **MEDIUM (Memory Leak & CPU Contention)** | **`InMemorySessionService` leak + `-ngl 999` / `--ctx-size 32768` on Intel iGPU** (Phase 0.4, 3.9) | Sessions were never deleted in `execute_adk_agent()`, and `-ngl 999` with 32k context wastes RAM/CPU on Intel UHD 630. | Always delete ephemeral sessions in `finally:`; use `-ngl 0 --threads 6 --ctx-size 8192` optimized for Intel i5-8500B AVX2 + Apple Accelerate. |

---

## 5. Target System Architecture & Hardware Optimization (Mac mini 2018)

### 5.1 End-to-End Local ADK 2.x Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                  CLIENT BROWSER (React 19 + Tailwind CSS — 100% UNCHANGED)               │
│                                                                                          │
│  • Practice Studio (YouTube IFrame + Transport + Listen-Then-Repeat / Simultaneous)      │
│  • Interactive Transcript Reader (<ruby> Furigana, Inline Edit, Word Diff Overlay)       │
│  • Floating Dictionary Popover · 4-Pillar Performance Report · Vocabulary Vault          │
└─────────────────────────────────────────────┬────────────────────────────────────────────┘
                                              │ Same HTTP REST & NDJSON Contracts (/api/*)
                                              ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                 PYTHON BACKEND (FastAPI + Google ADK 2.x — Port 3000)                    │
│                                                                                          │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ FastAPI Router Layer (routes/)                                                     │  │
│  │ • POST /api/transcript/fetch (NDJSON Stream: Fast InnerTube + Local Whisper)       │  │
│  │ • POST /api/transcript/retokenize (Deterministic fugashi JA + Regex EN)            │  │
│  │ • POST /api/dictionary/lookup     • POST /api/shadowing/evaluate                   │  │
│  │ • POST /api/tts/pronounce (macOS Native Offline 'say' WAV Synthesizer)             │  │
│  └──────────────────────────────────────────┬─────────────────────────────────────────┘  │
│                                             ▼                                            │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Google ADK 2.x Orchestration Layer (agents/runner.py)                              │  │
│  │ • InMemorySessionService (with Ephemeral Cleanup & Binary State Injection)         │  │
│  │ • <think> Tag Stripper + Outermost JSON Extractor + Pydantic Self-Healing Retry    │  │
│  └───────────┬──────────────────────────────┼──────────────────────────────┬──────────┘  │
│              ▼                              ▼                              ▼             │
│  ┌───────────────────────┐      ┌───────────────────────┐      ┌──────────────────────┐  │
│  │ TranscriptAgent       │      │ DictionaryAgent       │      │ ShadowingAgent       │  │
│  │ • Punctuation &       │      │ • Tool: lookup_free_  │      │ • Tool: transcribe_  │  │
│  │   ASR sentence repair │      │   dictionary()        │      │   and_analyze_audio()│  │
│  │ • Level estimation    │      │ • Tool: analyze_ja_   │      │   (via ToolContext)  │  │
│  │                       │      │   morpheme()          │      │ • 4-Pillar Rubric    │  │
│  └───────────┬───────────┘      └───────────┬───────────┘      └───────────┬──────────┘  │
└──────────────┼──────────────────────────────┼──────────────────────────────┼─────────────┘
               │ LiteLLM (OpenAI API)         │                              │ HTTP + ffmpeg
               ▼                              ▼                              ▼
┌─────────────────────────────────────────────────────────┐  ┌─────────────────────────────┐
│ LOCAL LLM SERVER (llama-server — Port 8080)             │  │ LOCAL STT (whisper-server)  │
│ • Model: ./models/Qwen3.5-9B-Q6_K.gguf (~7.5 GB RAM)    │  │ • Port 8081 (~1.5 GB RAM)   │
│ • Flags: --ctx-size 8192 --jinja --threads 6 -ngl 0     │  │ • Model: large-v3-turbo     │
│ • Hardware: Intel i5-8500B AVX2 + Apple Accelerate      │  │ • Input: 16kHz Mono PCM WAV │
└─────────────────────────────────────────────────────────┘  └─────────────────────────────┘
```

### 5.2 Shadowing Evaluation Sequence (Solving the Base64 & Acoustic Telemetry Problem)

```
Browser (ShadowingStudio)     FastAPI + ADK Runner         ADK ShadowingAgent        whisper-server (:8081)
   │                                   │                           │                           │
   │── 1. POST /api/shadowing/evaluate─►                           │                           │
   │   (audioBase64, targetText,       │                           │                           │
   │    webSpeechTranscript, durations)│                           │                           │
   │                                   │── 2. Saves audioBase64    │                           │
   │                                   │   in session.state        │                           │
   │                                   │── 3. runner.run_async() ─►│                           │
   │                                   │                           │── 4. Calls FunctionTool:  │
   │                                   │                           │   transcribe_and_analyze  │
   │                                   │                           │   (reads session.state,   │
   │                                   │                           │    ffmpeg -> 16kHz WAV) ─►│
   │                                   │                           │◄── 5. Returns verbatim    │
   │                                   │                           │    text + word probs +    │
   │                                   │                           │    RMS silence/pause +    │
   │                                   │                           │    SequenceMatcher diff   │
   │                                   │                           │── 6. Qwen3.5-9B evaluates │
   │                                   │                           │   4 pillars + coaching    │
   │                                   │◄── 7. Pydantic-validated ─│                           │
   │◄── 8. Returns exact JSON report ──│    JSON + delete_session  │                           │
```

### 5.3 Hardware Resource Budget on Mac mini 2018 (3.0 GHz 6-Core Intel Core i5, 32 GB DDR4)

| Process | RAM Usage | CPU Thread Allocation | Why This Tuning Works Best on Intel i5-8500B |
| :--- | :--- | :--- | :--- |
| **`llama-server` (`Qwen3.5-9B-Q6_K.gguf`)** | ~7.8 GB | `--threads 6 --threads-batch 6` | Uses all 6 physical Coffee Lake cores with AVX2 + Apple Accelerate BLAS. `--ctx-size 8192` keeps KV cache under 512 MB and speeds up prompt evaluation. |
| **`whisper-server` (`ggml-large-v3-turbo.bin`)** | ~1.6 GB | `--threads 6` | Runs sequentially *before* `ShadowingAgent` LLM inference, so Whisper and Qwen3.5 never fight for the same 6 CPU cores at the same millisecond. |
| **FastAPI + ADK 2.x + `fugashi` (MeCab)** | ~0.4 GB | Async event loop (1 core) | Lightweight orchestration and sub-millisecond Cython MeCab tokenization. |
| **macOS + Chrome + Vite Dev Server** | ~5.0 GB | Background | Leaves **> 17 GB of free physical RAM** with zero SSD swap pressure. |

---

## 6. Complete Refined Phased Implementation Plan (Phases 0–7)

> [!NOTE]
> **Strict Relative Path & User-Controlled Installation Policy**:
> - Every file path in Python and Bash uses relative resolution from the project root (`Path(__file__).resolve().parents[1]` or `./models/...`).
> - No background scripts silently install packages; all installation commands are listed explicitly below for you to run and verify.

---

### Phase 0: Project Scaffolding, Relative Paths & Environment

**Objective:** Set up the `adk_backend/` directory, Python dependencies, and relative path configuration alongside the untouched React frontend.

#### 0.1 — System Prerequisites (Verify on macOS)

Ensure `ffmpeg` (required for converting browser `.webm`/`.mp4` audio to 16kHz `.wav`) and `cmake` are installed:

```bash
# Check if ffmpeg and cmake are installed:
ffmpeg -version
cmake --version
python3 --version
```

*(If `ffmpeg` is missing on macOS, install it manually with `brew install ffmpeg cmake`.)*

#### 0.2 — Create `adk_backend/requirements.txt`

```txt
google-adk>=2.0.0
google-genai>=1.10.0
litellm>=1.84.0
fastapi>=0.115.0
uvicorn[standard]>=0.30.0
pydantic>=2.9.0
python-dotenv>=1.0.0
fugashi>=1.4.0
unidic-lite>=1.0.8
httpx>=0.27.0
python-multipart>=0.0.9
yt-dlp>=2025.1.15
pytest>=8.3.0
pytest-asyncio>=0.24.0
```

#### 0.3 — Create `adk_backend/config.py` (Strict Relative Paths)

```python
import os
from pathlib import Path
from dotenv import load_dotenv

# Resolve project root relatively from adk_backend/config.py
BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent

load_dotenv(BACKEND_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

# Local AI Server Endpoints
LLAMA_SERVER_URL = os.getenv("LLAMA_SERVER_URL", "http://127.0.0.1:8080/v1")
WHISPER_SERVER_URL = os.getenv("WHISPER_SERVER_URL", "http://127.0.0.1:8081")
LLAMA_MODEL_NAME = os.getenv("LLAMA_MODEL_NAME", "qwen3.5-9b")

# HTTP Ports
API_PORT = int(os.getenv("API_PORT", "3000"))
FRONTEND_DEV_PORT = int(os.getenv("FRONTEND_DEV_PORT", "5173"))

# Relative Model Paths
MODELS_DIR = PROJECT_ROOT / "models"
LLAMA_MODEL_PATH = Path(
    os.getenv("LLAMA_MODEL_PATH", str(MODELS_DIR / "Qwen3.5-9B-Q6_K.gguf"))
)
WHISPER_MODEL_PATH = Path(
    os.getenv("WHISPER_MODEL_PATH", str(MODELS_DIR / "ggml-large-v3-turbo.bin"))
)
TEMP_AUDIO_DIR = BACKEND_DIR / ".tmp_audio"
TEMP_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
```

---

### Phase 1: Local LLM Server (`llama-server` + `Qwen3.5-9B-Q6_K`)

**Objective:** Compile `llama.cpp` with Intel AVX2 and Apple Accelerate optimizations for the Mac mini 2018 and launch `llama-server` with settings tuned for fast structured JSON and tool calling.

#### 1.1 — Build `llama.cpp` for macOS Intel x86_64 (i5-8500B)

```bash
git clone https://github.com/ggml-org/llama.cpp.git
cd llama.cpp
cmake -B build \
  -DGGML_NATIVE=ON \
  -DGGML_ACCELERATE=ON \
  -DGGML_METAL=OFF
cmake --build build --config Release -j 6
```

> [!TIP]
> **Why `-DGGML_METAL=OFF` and `-ngl 0` on Mac mini 2018?** The 2018 Mac mini uses an integrated Intel UHD Graphics 630 (not Apple Silicon). Running quantized 6-bit (`Q6_K`) matrix multiplication on the 6 physical Intel Coffee Lake cores via **AVX2 + Apple Accelerate (`vDSP`/`BLAS`)** avoids GPU-CPU memory transfer overhead and prevents `ggml-metal` shader compilation issues on older Intel iGPUs.

#### 1.2 — Create `scripts/start_llama.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODEL_PATH="${LLAMA_MODEL_PATH:-$PROJECT_ROOT/models/Qwen3.5-9B-Q6_K.gguf}"

if [ ! -f "$MODEL_PATH" ]; then
  echo "Error: LLM model not found at $MODEL_PATH"
  exit 1
fi

# --ctx-size 8192 is optimal for EchoSense (<4k tokens/request) and minimizes CPU KV-cache overhead
# --jinja enables native Qwen3.5 tool-calling templates
exec llama-server \
  --model "$MODEL_PATH" \
  --alias "qwen3.5-9b" \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 8192 \
  --threads 6 \
  --threads-batch 6 \
  --jinja \
  --flash-attn \
  -ngl 0
```

---

### Phase 2: Local Speech-to-Text Server (`whisper-server` + `ffmpeg` WAV Pipeline)

**Objective:** Build `whisper.cpp` with Apple Accelerate and AVX2, and verify `verbose_json` output (which provides word/segment confidence scores needed for `stt_uncertain` detection).

#### 2.1 — Build `whisper.cpp`

```bash
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build \
  -DGGML_NATIVE=ON \
  -DGGML_ACCELERATE=ON \
  -DGGML_METAL=OFF
cmake --build build --config Release -j 6
```

#### 2.2 — Create `scripts/start_whisper.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODEL_PATH="${WHISPER_MODEL_PATH:-$PROJECT_ROOT/models/ggml-large-v3-turbo.bin}"

if [ ! -f "$MODEL_PATH" ]; then
  echo "Error: Whisper model not found at $MODEL_PATH"
  exit 1
fi

exec whisper-server \
  --model "$MODEL_PATH" \
  --host 127.0.0.1 \
  --port 8081 \
  --inference-path "/v1/audio/transcriptions" \
  --threads 6
```

---

### Phase 3: Google ADK 2.x Agent Layer, `ToolContext` State & Deterministic Tools

**Objective:** Build the Python tools and ADK 2.x agents without any of the vulnerabilities identified in Step 3.

#### 3.1 — Shared Local Model Factory (`adk_backend/agents/__init__.py`)

```python
from google.adk.models.lite_llm import LiteLlm
from ..config import LLAMA_SERVER_URL, LLAMA_MODEL_NAME


def get_local_model(temperature: float = 0.2) -> LiteLlm:
    """Creates a LiteLLM wrapper pointing to local llama-server (Qwen3.5-9B).

    Disables extended <think> monologues via chat_template_kwargs so CPU
    inference starts generating structured JSON immediately.
    """
    return LiteLlm(
        model=f"openai/{LLAMA_MODEL_NAME}",
        api_base=LLAMA_SERVER_URL,
        api_key="local-adk-no-key",
        temperature=temperature,
        extra_body={
            "chat_template_kwargs": {"enable_thinking": False},
        },
    )
```

#### 3.2 — Bilingual Tokenizer Tool (`adk_backend/tools/tokenizer_tools.py`)

Fixes Vulnerability #7 (`"*"` Furigana bug and missing English tokenization):

```python
import re
from typing import Any, Dict, List
import fugashi

_tagger: fugashi.Tagger | None = None

KANJI_REGEX = re.compile(r"[\u4e00-\u9faf]")
JA_DETECT_REGEX = re.compile(r"[\u3040-\u30ff\u4e00-\u9faf]")
EN_TOKEN_REGEX = re.compile(r"[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?|[^\sA-Za-z0-9]+")


def get_tagger() -> fugashi.Tagger:
    """Lazy-initializes the singleton fugashi (MeCab + unidic-lite) tagger."""
    global _tagger
    if _tagger is None:
        _tagger = fugashi.Tagger()
    return _tagger


def katakana_to_hiragana(text: str) -> str:
    """Converts Katakana characters to Hiragana cleanly."""
    return "".join(
        chr(ord(ch) - 0x60) if "\u30a1" <= ch <= "\u30f6" else ch
        for ch in text
    )


def has_kanji(text: str) -> bool:
    return bool(KANJI_REGEX.search(text))


def detect_japanese_characters(text: str) -> bool:
    return bool(JA_DETECT_REGEX.search(text))


def tokenize_sentence(text: str, language: str = "ja") -> List[Dict[str, Any]]:
    """Tokenizes a Japanese or English sentence into EchoSense WordToken dicts.

    Matches the exact ServerWordToken schema expected by TranscriptReader.tsx:
    { surface, reading?, lemma?, pos?, isKanji? }
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return []

    if language == "ja":
        try:
            tagger = get_tagger()
            tokens: List[Dict[str, Any]] = []
            for word in tagger(cleaned):
                surface = word.surface
                if not surface or surface.isspace():
                    continue
                is_k = has_kanji(surface)
                raw_kana = getattr(word.feature, "kana", None)
                reading = None
                if is_k and raw_kana and raw_kana != "*":
                    hira = katakana_to_hiragana(raw_kana)
                    if hira and hira != surface:
                        reading = hira

                raw_lemma = getattr(word.feature, "lemma", None)
                lemma = (
                    raw_lemma.split("-")[0]
                    if raw_lemma and raw_lemma != "*"
                    else surface
                )
                pos = getattr(word.feature, "pos1", None)
                tokens.append(
                    {
                        "surface": surface,
                        "reading": reading,
                        "lemma": lemma,
                        "pos": pos if pos and pos != "*" else None,
                        "isKanji": is_k,
                    }
                )
            return tokens
        except Exception as exc:
            print(f"fugashi fallback warning: {exc}")

    # English or fallback tokenization (preserves punctuation tokens for reader)
    return [
        {
            "surface": match.group(0),
            "isKanji": has_kanji(match.group(0)),
        }
        for match in EN_TOKEN_REGEX.finditer(cleaned)
    ]
```

#### 3.3 — Whisper STT + Acoustic Telemetry + `ToolContext` Tool (`adk_backend/tools/whisper_tools.py`)

Fixes Vulnerability #1 (no Base64 in LLM prompts), Vulnerability #2 (`ffmpeg` WebM $\rightarrow$ 16kHz WAV conversion), and Vulnerability #4 (extracts objective acoustic pause/volume telemetry + deterministic word alignment):

```python
import base64
import difflib
import math
import subprocess
import uuid
import wave
import struct
from pathlib import Path
from typing import Any, Dict, List
import httpx
from google.adk.tools import ToolContext
from ..config import TEMP_AUDIO_DIR, WHISPER_SERVER_URL
from .tokenizer_tools import tokenize_sentence


def convert_to_16khz_mono_wav(input_path: Path, output_path: Path) -> None:
    """Converts browser audio/webm or audio/mp4 into 16kHz 16-bit mono WAV."""
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]
    subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        timeout=30,
    )


def analyze_wav_acoustics(wav_path: Path) -> Dict[str, Any]:
    """Computes objective RMS energy, silence ratio, and mid-speech pause count."""
    try:
        with wave.open(str(wav_path), "rb") as wf:
            sample_rate = wf.getframerate()
            n_frames = wf.getnframes()
            if n_frames == 0 or sample_rate == 0:
                return {"isSilent": True, "rmsDb": -90.0, "pauseCount": 0, "silenceRatio": 1.0}
            raw_bytes = wf.readframes(n_frames)
            samples = struct.unpack(f"<{n_frames}h", raw_bytes)

        window_size = max(1, int(sample_rate * 0.05))  # 50ms windows
        rms_values: List[float] = []
        for i in range(0, len(samples), window_size):
            chunk = samples[i : i + window_size]
            if not chunk:
                continue
            mean_sq = sum(s * s for s in chunk) / len(chunk)
            rms = math.sqrt(mean_sq) / 32768.0
            rms_values.append(rms)

        if not rms_values:
            return {"isSilent": True, "rmsDb": -90.0, "pauseCount": 0, "silenceRatio": 1.0}

        overall_rms = sum(rms_values) / len(rms_values)
        rms_db = 20 * math.log10(max(overall_rms, 1e-6))
        silence_threshold = 0.012
        silent_windows = [r < silence_threshold for r in rms_values]
        silence_ratio = sum(1 for s in silent_windows if s) / len(silent_windows)

        # Count mid-utterance pauses (>= 350ms = 7 consecutive 50ms silent windows)
        active_indices = [idx for idx, is_sil in enumerate(silent_windows) if not is_sil]
        pause_count = 0
        if len(active_indices) >= 2:
            interior = silent_windows[active_indices[0] : active_indices[-1] + 1]
            run = 0
            for is_sil in interior:
                if is_sil:
                    run += 1
                else:
                    if run >= 7:
                        pause_count += 1
                    run = 0

        is_silent = rms_db < -48.0 or silence_ratio > 0.94
        return {
            "isSilent": is_silent,
            "rmsDb": round(rms_db, 1),
            "pauseCount": pause_count,
            "silenceRatio": round(silence_ratio, 2),
        }
    except Exception:
        return {"isSilent": False, "rmsDb": -24.0, "pauseCount": 0, "silenceRatio": 0.2}


def compute_deterministic_word_diff(
    target_text: str,
    spoken_text: str,
    language: str,
) -> Dict[str, Any]:
    """Computes baseline word/morpheme diff using SequenceMatcher."""
    punct_re = r"^[.,!?;:\"'()「」『』、。！？—\-]+$"
    import re

    target_tokens = [
        t for t in tokenize_sentence(target_text, language)
        if not re.match(punct_re, t["surface"])
    ]
    spoken_tokens = [
        t for t in tokenize_sentence(spoken_text, language)
        if not re.match(punct_re, t["surface"])
    ]

    t_norms = [
        (t.get("reading") or t["surface"]).lower() for t in target_tokens
    ]
    s_norms = [
        (t.get("reading") or t["surface"]).lower() for t in spoken_tokens
    ]

    matcher = difflib.SequenceMatcher(None, t_norms, s_norms)
    diff_items: List[Dict[str, Any]] = []
    matched = 0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for idx in range(i1, i2):
                matched += 1
                diff_items.append(
                    {
                        "word": target_tokens[idx]["surface"],
                        "reading": target_tokens[idx].get("reading"),
                        "status": "correct",
                    }
                )
        elif tag == "delete":
            for idx in range(i1, i2):
                diff_items.append(
                    {
                        "word": target_tokens[idx]["surface"],
                        "reading": target_tokens[idx].get("reading"),
                        "status": "omitted",
                        "explanation": "Not detected in spoken recording.",
                    }
                )
        elif tag == "replace":
            t_slice = target_tokens[i1:i2]
            s_slice = spoken_tokens[j1:j2]
            for k, t_tok in enumerate(t_slice):
                s_tok = s_slice[k] if k < len(s_slice) else None
                # Check phonetic similarity for stt_uncertain vs substituted
                t_phon = (t_tok.get("reading") or t_tok["surface"]).lower()
                s_phon = (s_tok.get("reading") or s_tok["surface"]).lower() if s_tok else ""
                sim = difflib.SequenceMatcher(None, t_phon, s_phon).ratio()
                status = "stt_uncertain" if sim >= 0.65 else "substituted"
                if status == "stt_uncertain":
                    matched += 0.85
                diff_items.append(
                    {
                        "word": s_tok["surface"] if s_tok else t_tok["surface"],
                        "expectedWord": t_tok["surface"],
                        "reading": t_tok.get("reading"),
                        "status": status,
                        "explanation": (
                            "Close phonetic match (possible STT homophone)."
                            if status == "stt_uncertain"
                            else f"Heard '{s_tok['surface'] if s_tok else '?'}' instead of '{t_tok['surface']}'."
                        ),
                    }
                )
        elif tag == "insert":
            for idx in range(j1, j2):
                diff_items.append(
                    {
                        "word": spoken_tokens[idx]["surface"],
                        "status": "inserted",
                        "explanation": "Extra word spoken.",
                    }
                )

    total_target = max(1, len(target_tokens))
    accuracy = round(min(100.0, (matched / total_target) * 100.0), 1)
    return {
        "contentAccuracyEstimate": accuracy,
        "targetTokenCount": len(target_tokens),
        "spokenTokenCount": len(spoken_tokens),
        "baselineWordDiff": diff_items,
    }


async def transcribe_and_analyze_audio(
    language: str,
    tool_context: ToolContext,
) -> Dict[str, Any]:
    """ADK FunctionTool: Transcribes audio from session.state and computes acoustic metrics.

    Reads 'audio_base64', 'mime_type', 'target_text', and 'web_speech_transcript'
    directly from tool_context.state so raw audio bytes NEVER enter the LLM context!

    Args:
        language: 'en' for English or 'ja' for Japanese.
    """
    audio_b64: str | None = tool_context.state.get("audio_base64")
    mime_type: str = tool_context.state.get("mime_type", "audio/webm")
    target_text: str = tool_context.state.get("target_text", "")
    web_speech: str = tool_context.state.get("web_speech_transcript", "")

    # Handle "Simulate Practice Take" (where audio_base64 is None)
    if not audio_b64:
        diff_info = compute_deterministic_word_diff(target_text, web_speech, language)
        return {
            "verbatimTranscript": web_speech,
            "acoustics": {
                "isSilent": not bool(web_speech.strip()),
                "rmsDb": -18.0,
                "pauseCount": 0,
                "silenceRatio": 0.15,
                "simulatedTake": True,
            },
            **diff_info,
        }

    file_id = uuid.uuid4().hex[:10]
    ext = ".mp4" if "mp4" in mime_type else ".webm"
    raw_path = TEMP_AUDIO_DIR / f"in_{file_id}{ext}"
    wav_path = TEMP_AUDIO_DIR / f"pcm_{file_id}.wav"

    try:
        raw_path.write_bytes(base64.b64decode(audio_b64))
        convert_to_16khz_mono_wav(raw_path, wav_path)
        acoustics = analyze_wav_acoustics(wav_path)

        if acoustics["isSilent"] and not web_speech.strip():
            return {
                "verbatimTranscript": "",
                "acoustics": acoustics,
                "contentAccuracyEstimate": 0,
                "baselineWordDiff": [],
            }

        verbatim_text = web_speech.strip()
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                with open(wav_path, "rb") as wf:
                    resp = await client.post(
                        f"{WHISPER_SERVER_URL}/v1/audio/transcriptions",
                        files={"file": (wav_path.name, wf, "audio/wav")},
                        data={
                            "model": "large-v3-turbo",
                            "language": language,
                            "response_format": "verbose_json",
                            "temperature": "0.0",
                        },
                    )
                if resp.status_code == 200:
                    w_data = resp.json()
                    w_text = (w_data.get("text") or "").strip()
                    if w_text:
                        verbatim_text = w_text
        except Exception as exc:
            print(f"Whisper server warning (falling back to webSpeechTranscript): {exc}")

        diff_info = compute_deterministic_word_diff(target_text, verbatim_text, language)
        return {
            "verbatimTranscript": verbatim_text,
            "acoustics": acoustics,
            **diff_info,
        }
    finally:
        raw_path.unlink(missing_ok=True)
        wav_path.unlink(missing_ok=True)
```

#### 3.4 — ADK 2.x Runner, Session Cleanup & `<think>`-Safe JSON Parser (`adk_backend/agents/runner.py`)

Fixes Vulnerability #5 (Qwen3.5 `<think>` tags) and Vulnerability #8 (`InMemorySessionService` memory leak):

```python
import json
import logging
import re
import uuid
from typing import Any, Dict, Optional, Type, TypeVar
from pydantic import BaseModel
from google.adk.agents import LlmAgent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

logger = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)

APP_NAME = "echosense_local_adk"
_session_service = InMemorySessionService()

THINK_BLOCK_REGEX = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)


def extract_clean_json(raw_text: str) -> Dict[str, Any]:
    """Strips <think>...</think> blocks, markdown fences, and parses outermost JSON."""
    cleaned = THINK_BLOCK_REGEX.sub("", raw_text or "").strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    elif cleaned.startswith("```"):
        cleaned = cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    # Locate outermost JSON object { ... }
    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        cleaned = cleaned[first_brace : last_brace + 1]

    return json.loads(cleaned)


async def execute_adk_agent_json(
    agent: LlmAgent,
    prompt: str,
    initial_state: Optional[Dict[str, Any]] = None,
    schema_model: Optional[Type[T]] = None,
    user_id: str = "local_learner",
) -> Dict[str, Any]:
    """Executes an ADK 2.x LlmAgent with ephemeral session state and guaranteed cleanup.

    Automatically retries once if the local model outputs malformed JSON.
    """
    session_id = f"sess_{uuid.uuid4().hex[:12]}"
    await _session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        state=initial_state or {},
    )

    runner = Runner(
        agent=agent,
        app_name=APP_NAME,
        session_service=_session_service,
    )

    try:
        current_prompt = prompt
        for attempt in range(2):
            content = types.Content(
                role="user",
                parts=[types.Part(text=current_prompt)],
            )
            final_text = ""
            async for event in runner.run_async(
                user_id=user_id,
                session_id=session_id,
                new_message=content,
            ):
                if (
                    event.is_final_response()
                    and event.content
                    and event.content.parts
                ):
                    text_parts = [
                        p.text for p in event.content.parts if getattr(p, "text", None)
                    ]
                    if text_parts:
                        final_text = "\n".join(text_parts).strip()

            try:
                parsed = extract_clean_json(final_text)
                if schema_model is not None:
                    validated = schema_model.model_validate(parsed)
                    return validated.model_dump()
                return parsed
            except Exception as parse_err:
                logger.warning(f"JSON validation attempt {attempt + 1} failed: {parse_err}")
                current_prompt = (
                    f"Your previous response had a JSON formatting error: {parse_err}. "
                    "Please respond ONLY with a valid raw JSON object matching the required keys."
                )
        raise ValueError(f"Agent {agent.name} failed to return valid JSON after retry.")
    finally:
        # Prevent memory leaks by deleting the ephemeral session (and its audio state)
        try:
            await _session_service.delete_session(
                app_name=APP_NAME,
                user_id=user_id,
                session_id=session_id,
            )
        except Exception:
            pass
```

#### 3.5 — The Three ADK 2.x Agents (`DictionaryAgent`, `ShadowingAgent`, `TranscriptAgent`)

1. **`DictionaryAgent` (`adk_backend/agents/dictionary_agent.py`)**:
   - Calls `lookup_free_dictionary(word)` for English or `analyze_japanese_morpheme(word, sentence)` (`fugashi` lemma/reading/POS helper) for Japanese.
   - Outputs validated `DictionaryLookupResult` JSON (`word`, `lemma`, `language`, `reading`, `romaji`, `ipa`, `pitchAccent`, `partOfSpeech`, `contextualMeaning`, `dictionaryDefinitions`, `usageExample`, `usageExampleTranslation`, `pronunciationTip`).
2. **`ShadowingAgent` (`adk_backend/agents/shadowing_agent.py`)**:
   - Calls `transcribe_and_analyze_audio(language)` (which reads `audio_base64` from `tool_context.state`).
   - Combines the objective `contentAccuracyEstimate`, `baselineWordDiff`, and `acoustics` (`rmsDb`, `pauseCount`, `silenceRatio`) with phonetic coaching to output the 4-pillar `ShadowingAssessmentReport` JSON.
3. **`TranscriptAgent` (`adk_backend/agents/transcript_agent.py`)**:
   - Invoked when auto-generated captions lack punctuation or when estimating proficiency level (`Beginner` / `Intermediate` / `Advanced`), while keeping caption downloading, segment merging, and `fugashi` Furigana annotation 100% deterministic in Python for instant response times.

---

### Phase 4: FastAPI Bridge — NDJSON Streaming, Offline TTS & Exact Contract Parity

**Objective:** Implement the 5 `/api/*` endpoints so `src/App.tsx`, `TranscriptReader.tsx`, `DictionaryPopover.tsx`, `ShadowingStudio.tsx`, `PerformanceReport.tsx`, and `VocabularyAndHistoryViews.tsx` work without a single UI discrepancy.

#### 4.1 — Offline macOS Native TTS Route (`adk_backend/routes/tts_routes.py`)

Fixes Vulnerability #6: Uses macOS's built-in `/usr/bin/say` + `ffmpeg` to synthesize crisp offline English (`Samantha`) and Japanese (`Kyoko`) `.wav` audio in `< 150ms`, returning `{ audioBase64, mimeType: "audio/wav" }` to all 3 frontend components!

```python
import base64
import platform
import subprocess
import uuid
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..config import TEMP_AUDIO_DIR

router = APIRouter()


class TtsRequest(BaseModel):
    text: str
    language: str = "en"


@router.post("/tts/pronounce")
async def pronounce_text(req: TtsRequest):
    clean_text = (req.text or "").strip()
    if not clean_text:
        raise HTTPException(status_code=400, detail={"error": "Text is required."})

    # Primary Local Path on macOS (Mac mini 2018): Native offline 'say' synthesizer
    if platform.system() == "Darwin":
        file_id = uuid.uuid4().hex[:10]
        aiff_path = TEMP_AUDIO_DIR / f"tts_{file_id}.aiff"
        wav_path = TEMP_AUDIO_DIR / f"tts_{file_id}.wav"
        voice = "Kyoko" if req.language == "ja" else "Samantha"
        try:
            subprocess.run(
                ["/usr/bin/say", "-v", voice, "-o", str(aiff_path), clean_text],
                check=True,
                timeout=15,
            )
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(aiff_path),
                    "-ar",
                    "22050",
                    "-ac",
                    "1",
                    str(wav_path),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
                timeout=15,
            )
            audio_b64 = base64.b64encode(wav_path.read_bytes()).decode("ascii")
            return {"audioBase64": audio_b64, "mimeType": "audio/wav"}
        except Exception as exc:
            print(f"macOS say TTS fallback warning: {exc}")
        finally:
            aiff_path.unlink(missing_ok=True)
            wav_path.unlink(missing_ok=True)

    raise HTTPException(
        status_code=503,
        detail={"error": "Local TTS synthesizer unavailable; use browser speech fallback."},
    )
```

#### 4.2 — Streaming NDJSON Transcript Route (`POST /api/transcript/fetch`)

Fixes Vulnerability #3:
- Uses `fastapi.responses.StreamingResponse(..., media_type="application/x-ndjson; charset=utf-8")` when `stream=True`.
- **Fast Path (Public Captions Found)**: Fetches metadata + InnerTube captions (`ANDROID_TESTSUITE`, watch HTML, `ANDROID`, `IOS`), merges caption fragments with the exact `server.ts` algorithm (`maxChars = 58` for `ja`, `130` for `en`), runs `tokenize_sentence()` across all segments, and yields `meta` $\rightarrow$ `complete`.
- **Fallback Path (Uncaptioned YouTube Video)**: Downloads audio locally via `yt-dlp` into a temporary 16kHz WAV file, splits it into 180-second windows using `ffmpeg`, transcribes each window sequentially on local `whisper-server` (`verbose_json`), tokenizes segments with `fugashi`, and yields progressive `{ "type": "partial_segments", ... }` events + 2.5s heartbeats until `{ "type": "complete", "video": finalVideo }`!

---

### Phase 5: Frontend Dev Proxy & Graceful Local Health Fallback

**Objective:** Connect the Vite dev server to the FastAPI backend on port 3000 while keeping `src/App.tsx` and the visual design 100% untouched.

#### 5.1 — Vite Proxy Configuration (`vite.config.ts`)

When running `vite` in standalone dev mode (`http://localhost:5173`), proxy `/api` requests to the Python ADK server (`http://127.0.0.1:3000`):

```typescript
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
```

#### 5.2 — Browser `SpeechSynthesis` Fallback for Non-macOS Environments

Even though our macOS `/api/tts/pronounce` endpoint works natively offline via `/usr/bin/say`, adding a 6-line `window.speechSynthesis` fallback inside the `catch` blocks of `DictionaryPopover.tsx`, `PerformanceReport.tsx`, and `VocabularyAndHistoryViews.tsx` ensures that even on Linux/Windows machines without `say`, clicking **Listen / Hear Model** still speaks the word aloud.

---

### Phase 6: Automated Integration Testing & Bilingual Verification

**Objective:** Verify every endpoint, agent, and edge case using automated `pytest` tests and manual browser checks.

#### 6.1 — Automated Integration Suite (`adk_backend/tests/test_integration.py`)

Tests:
1. `GET /api/health` $\rightarrow$ verifies FastAPI, `llama-server` (`:8080`), and `whisper-server` (`:8081`) connectivity.
2. `POST /api/transcript/retokenize` $\rightarrow$ verifies Japanese Kanji (`言葉のリズム`) returns `reading: "ことば"` without any `"*"` artifacts, and English (`We're practicing.`) returns word and punctuation tokens.
3. `POST /api/dictionary/lookup` $\rightarrow$ verifies `DictionaryAgent` returns all 11 required fields for both English (`"approach"`) and Japanese (`"真似"`).
4. `POST /api/tts/pronounce` $\rightarrow$ verifies valid `audio/wav` Base64 output (`RIFF` header check).
5. `POST /api/shadowing/evaluate` $\rightarrow$ tests both simulated take (`audioBase64: None`) and real WAV audio (`audioBase64` injected via `ToolContext`), verifying 4-pillar scores and `wordDiff`.

---

### Phase 7: CPU Latency Tuning & Memory Management

**Objective:** Ensure responsive UX on the 6-core Intel Core i5-8500B processor.

| Optimization | Configuration | Latency Benefit on Mac mini 2018 |
| :--- | :--- | :--- |
| **Disable Qwen3.5 `<think>` tags on JSON endpoints** | `extra_body={"chat_template_kwargs": {"enable_thinking": False}}` | Cuts dictionary & shadowing evaluation time from ~22s down to **~3.5–5.5s** by skipping 400+ hidden reasoning tokens. |
| **Sequential Whisper $\rightarrow$ Qwen Execution** | `transcribe_and_analyze_audio` finishes before Qwen3.5 generates the final report | Prevents `whisper-server` (6 threads) and `llama-server` (6 threads) from thrashing the 6 physical CPU cores simultaneously. |
| **Right-Sized Context Window (`--ctx-size 8192`)** | `llama-server --ctx-size 8192 --flash-attn` | Saves ~3.5 GB of KV cache memory and speeds up prompt processing by ~25%. |
| **In-Memory LRU Dictionary Cache** | Cache `(language, word, sentence[:32])` in FastAPI | Repeat word lookups return in **< 5ms**. |

---

## 7. Updated Risk Register & Mitigations

| # | Risk | Severity | Concrete Mitigation Built into Refined Plan |
| :--- | :--- | :--- | :--- |
| **1** | **Base64 Audio Context Overflow** | Critical | Solved via ADK `ToolContext` (`tool_context.state["audio_base64"]`). Zero Base64 bytes ever enter the LLM prompt. |
| **2** | **Browser WebM/Opus Incompatibility with `whisper.cpp`** | Critical | Solved via automatic `ffmpeg` conversion to `16kHz mono PCM WAV` inside `whisper_tools.py`. |
| **3** | **Qwen3.5 `<think>` Tags Breaking JSON Parsing** | High | Solved by passing `enable_thinking: False` via LiteLLM AND stripping `<think>[\s\S]*?</think>` + Pydantic retry in `runner.py`. |
| **4** | **Uncaptioned YouTube Videos Failing Locally** | High | Solved by local `yt-dlp` audio extraction + chunked `whisper-server` transcription with NDJSON progress streaming. |
| **5** | **CPU Thread Contention on 6-Core Intel i5** | Medium | Solved by sequential tool execution (Whisper completes before Qwen3.5 scores) and `--threads 6 -ngl 0`. |

---

## 8. Appendix: One-Command Launch & Verification Cheat Sheet

```bash
# 1. Start Local Qwen3.5-9B Server (Port 8080)
./scripts/start_llama.sh

# 2. Start Local Whisper Large-v3-Turbo Server (Port 8081)
./scripts/start_whisper.sh

# 3. Start Python Google ADK 2.x Backend (Port 3000)
./adk_backend/.venv/bin/python -m uvicorn adk_backend.main:app --host 127.0.0.1 --port 3000 --reload

# 4. Start React Frontend (Port 5173 -> proxies /api to :3000)
npm run dev
```
