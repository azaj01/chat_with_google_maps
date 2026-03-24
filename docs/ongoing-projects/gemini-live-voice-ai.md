# Gemini Live Voice AI - Engineering Documentation

> Real-time bidirectional voice conversation system built on Google Gemini Live API

## Architecture Overview

This platform implements a production-grade voice AI system using **Google Gemini Live API** with WebSocket-based streaming. The architecture spans frontend (React/TypeScript) and backend (Node.js/Hono) components with fire-and-forget tracing and ephemeral token authentication.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CLIENT (Browser)                               │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────────┐  │
│  │ AudioRecorder│───▶│GenAILive   │───▶│ Google Gemini Live API     │  │
│  │ (Microphone) │    │  Client    │◀───│ (WebSocket)                 │  │
│  └─────────────┘    └─────────────┘    └─────────────────────────────┘  │
│         ▲                  │                                             │
│         │                  ▼                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────────┐  │
│  │AudioStreamer│◀───│useLiveApi  │───▶│ VoiceTraceClient            │  │
│  │ (Speakers)  │    │   Hook     │    │ (Fire-and-forget)           │  │
│  └─────────────┘    └─────────────┘    └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           SERVER (Hono API)                              │
│  ┌─────────────────────┐    ┌─────────────────────────────────────────┐ │
│  │ POST /api/live/token│    │ POST /api/live/trace/event              │ │
│  │ (Ephemeral tokens)  │    │ POST /api/live/trace/end                │ │
│  └─────────────────────┘    └─────────────────────────────────────────┘ │
│            │                              │                              │
│            ▼                              ▼                              │
│  ┌─────────────────────┐    ┌─────────────────────────────────────────┐ │
│  │ Google GenAI SDK    │    │ SessionTraceManager (Langfuse)          │ │
│  └─────────────────────┘    └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. GenAI Live Client

**File**: `src/lib/api/genai-live-client.ts`

Wraps the `@google/genai` SDK's Live API with a custom EventEmitter pattern for React integration.

```typescript
// Constructor accepts ephemeral token (browser-safe, single-use)
constructor(token: string, model?: string)

// Key methods
connect(config: LiveConnectConfig): Promise<void>
disconnect(): void
sendRealtimeInput(chunks: Blob[]): Promise<void>  // Audio from mic
sendRealtimeText(text: string): void              // Bypass speech-to-text
sendToolResponse(toolResponse): void              // Function call results
```

**Event Types Emitted**:
| Event | Payload | Description |
|-------|---------|-------------|
| `audio` | `ArrayBuffer` | PCM16 audio from model |
| `content` | `LiveServerContent` | Text/other content |
| `toolcall` | `LiveServerToolCall` | Function call request |
| `inputTranscription` | `(text, isFinal)` | User speech-to-text |
| `outputTranscription` | `(text, isFinal)` | AI speech-to-text |
| `turncomplete` | - | Model finished turn |
| `setupcomplete` | - | Session ready |

---

### 2. Audio Pipeline

#### Microphone Input: AudioRecorder

**File**: `src/lib/audio/audio-recorder.ts`

```
getUserMedia() → MediaStreamSource → AudioWorklet → Base64 PCM16 → WebSocket
```

- Uses Web Audio API with AudioWorklet for non-blocking capture
- **Format**: PCM16, 16kHz sample rate
- **Buffer size**: 2048 samples (~128ms)
- **Worklet**: `src/lib/worklets/audio-processing.ts` - Float32 → Int16 conversion

#### Speaker Output: AudioStreamer

**File**: `src/lib/audio/audio-streamer.ts`

```
WebSocket → ArrayBuffer → PCM16 → Float32 → AudioBuffer → BufferSource → Speakers
```

- **PCM16 → Float32 conversion**: `int16 / 32768` normalized to [-1.0, 1.0]
- **Buffer strategy**: 7680 samples (320ms at 24kHz output)
- **Scheduling**: Lookahead of 200ms, initial buffer 100ms
- **Volume control**: GainNode with `linearRampToValueAtTime()` for smooth transitions

---

### 3. Authentication Flow

**Strategy**: Ephemeral tokens - API key never exposed to browser

```
Client                        Server                      Google
  │                             │                            │
  ├─POST /api/live/token───────▶│                            │
  │                             ├─authTokens.create()───────▶│
  │                             │  uses: 1                   │
  │                             │  expireTime: 30min         │
  │                             │◀───────────────────────────┤
  │◀─{token, sessionId}─────────┤                            │
  │                             │                            │
  ├─WebSocket(token)────────────────────────────────────────▶│
```

**Backend Implementation**: `api/_routes/live.ts:51-57`

```typescript
const tokenResponse = await client.authTokens.create({
  config: {
    uses: 1, // Single-use
    expireTime: addMinutes(30), // 30-minute expiry
    newSessionExpireTime: addMinutes(1),
  },
});
```

---

### 4. React Integration

#### useLiveApi Hook

**File**: `src/hooks/use-live-api.ts`

Primary hook managing the voice session lifecycle:

```typescript
const {
  client, // GenAILiveClient instance
  connected, // Boolean connection state
  connect, // Start voice session
  disconnect, // End voice session
  audioStreamer, // For playback control
  volume, // Current output volume
  userTranscript, // Real-time user speech
  aiTranscript, // Real-time AI speech
} = useLiveAPIContext();
```

**Session Setup Sequence**:

1. `fetchLiveToken()` → Get ephemeral token + session ID
2. `new GenAILiveClient(token, model)` → Create client
3. Register 10+ event handlers → Audio, transcription, tools, tracing
4. `client.connect(config)` → Initiate WebSocket
5. `onSetupComplete()` → Send hello message, ready for conversation

#### Context Provider

**File**: `src/contexts/LiveAPIContext.tsx`

Distributes client across entire app with error boundary for auth failures.

---

### 5. Tool Execution Pattern

When Gemini requests a function call:

```typescript
// In use-live-api.ts, lines 227-325
const onToolCall = async (toolCall: LiveServerToolCall) => {
  const responses: FunctionResponse[] = [];

  for (const fc of toolCall.functionCalls) {
    const tool = toolRegistry[fc.name];
    const result = await tool.execute(fc.args, toolContext);

    recordToolCall(turnNumber, fc.name, fc.args); // Trace
    responses.push({ name: fc.name, response: result });
    recordToolResult(turnNumber, fc.name, result); // Trace
  }

  client.sendToolResponse({ functionResponses: responses });
};
```

**Tool Context Provided**:

- Google Map instance
- Geocoder service
- Elevation service
- Search libraries

---

### 6. Observability & Tracing

**Design Principle**: Fire-and-forget - never block voice session

#### Frontend Trace Client

**File**: `src/lib/tracing/voice-trace-client.ts`

```typescript
// All methods fire-and-forget (void this.postEvent())
recordTurnStart(turnNumber, userTranscript);
recordTurnComplete(turnNumber, aiTranscript, durationMs);
recordToolCall(turnNumber, toolName, toolArgs);
recordToolResult(turnNumber, toolName, result, durationMs);
```

#### Backend Session Manager

**File**: `api/_lib/session-trace-manager.ts`

- In-memory session tracking with 30-minute timeout
- Langfuse integration for traces and spans
- Automatic cleanup every 5 minutes
- Cost calculation for audio minutes and tokens

**API Endpoints**:
| Endpoint | Response | Purpose |
|----------|----------|---------|
| `POST /api/live/trace/event` | `204` | Record session event |
| `POST /api/live/trace/end` | `{traceId, summary}` | Finalize session |

---

## Data Flow Diagrams

### Voice Input (Mic → Model)

```
Microphone
    │
    ▼
AudioRecorder.start()
    │
    ├─ getUserMedia({audio: true})
    ├─ MediaStreamAudioSourceNode
    ├─ AudioWorklet (audio-processing.ts)
    │      └─ Float32 → Int16, buffers 2048 samples
    │
    ▼
'data' event: base64 PCM16
    │
    ▼
client.sendRealtimeInput([{
  mimeType: 'audio/pcm;rate=16000',
  data: base64String
}])
    │
    ▼
WebSocket to Google Gemini
```

### Voice Output (Model → Speakers)

```
Google Gemini Response
    │
    ▼
modelTurn.parts[].inlineData
    │ (audio/pcm, base64)
    │
    ▼
GenAILiveClient extracts audio
    │
    ▼
Emits 'audio' event (ArrayBuffer)
    │
    ▼
audioStreamer.addPCM16(Uint8Array)
    │
    ├─ PCM16 → Float32 conversion
    ├─ Queue in audioQueue[]
    │
    ▼
scheduleNextBuffer()
    │
    ├─ Create AudioBuffer objects
    ├─ Schedule via source.start(time)
    │
    ▼
GainNode → Speakers
```

---

## Configuration

### Environment Variables

```env
GOOGLE_GENAI_API_KEY=<your-key>
LANGFUSE_PUBLIC_KEY=<optional>
LANGFUSE_SECRET_KEY=<optional>
```

### Model Options

**File**: `src/lib/constants.ts`

| Model ID                                        | Notes                  |
| ----------------------------------------------- | ---------------------- |
| `gemini-2.5-flash-native-audio-preview-12-2025` | Default, latest        |
| `gemini-2.5-flash-native-audio-latest`          | Stable latest          |
| `gemini-live-2.5-flash-preview`                 | Preview channel        |
| `gemini-2.0-flash-live-001`                     | Legacy, limited voices |

### Voice Options

30 voices available for native audio models (mythology-themed names):

- Default: **Zephyr** (bright, higher pitch)
- Options include: Puck, Charon, Kore, Fenrir, Aoede, Orbit, etc.

---

## Key Engineering Decisions

### 1. Ephemeral Token Pattern

- API key never exposed to browser
- Single-use tokens prevent replay attacks
- 30-minute expiry limits exposure window

### 2. EventEmitter for Loose Coupling

- GenAILiveClient uses `eventemitter3`
- React hooks attach/detach listeners dynamically
- Multiple components can subscribe to same events

### 3. AudioWorklet for Real-time Processing

- Main thread never blocks on audio processing
- Worklet thread handles continuous sampling
- Critical for smooth 16kHz recording

### 4. Fire-and-Forget Tracing

- Voice latency is critical (100ms delay noticeable)
- All trace events posted without await
- Errors logged but never thrown

### 5. Turn Tracking with useRef

- Turn numbers and transcripts tracked with refs
- Avoids React re-renders during active conversation
- Improves perceived latency

---

## File Manifest

| Component         | Path                                    | Purpose                   |
| ----------------- | --------------------------------------- | ------------------------- |
| Core Client       | `src/lib/api/genai-live-client.ts`      | WebSocket wrapper, events |
| React Hook        | `src/hooks/use-live-api.ts`             | Session management, tools |
| Context           | `src/contexts/LiveAPIContext.tsx`       | App-wide provider         |
| Mic Input         | `src/lib/audio/audio-recorder.ts`       | Web Audio capture         |
| Speaker Output    | `src/lib/audio/audio-streamer.ts`       | Playback scheduling       |
| Recording Worklet | `src/lib/worklets/audio-processing.ts`  | Format conversion         |
| Volume Worklet    | `src/lib/worklets/vol-meter.ts`         | Level monitoring          |
| Token Service     | `src/lib/api/token-service.ts`          | Client token fetch        |
| Backend Tokens    | `api/_routes/live.ts`                   | Token generation          |
| Trace Client      | `src/lib/tracing/voice-trace-client.ts` | Event posting             |
| Trace Hook        | `src/hooks/use-voice-tracing.ts`        | React wrapper             |
| Backend Trace     | `api/_routes/live-trace.ts`             | Trace endpoints           |
| Session Manager   | `api/_lib/session-trace-manager.ts`     | Langfuse integration      |
| UI Controls       | `src/components/ControlTray.tsx`        | Play/Mic/Volume           |
| Constants         | `src/lib/constants.ts`                  | Models, voices            |

---

## Dependencies

```json
{
  "@google/genai": "^1.34.0",
  "eventemitter3": "^5.0.1",
  "langfuse": "^3.38.6"
}
```

---

## Potential Optimizations

| Current State                         | Possible Optimization       |
| ------------------------------------- | --------------------------- |
| Base64 audio encoding (~33% overhead) | Binary WebSocket protocol   |
| Fire-and-forget may lose order        | Message queue with ordering |
| In-memory sessions                    | Database persistence        |
| Uncompressed PCM                      | Opus/WebM compression       |
