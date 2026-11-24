# Map — Live voice in Chat

Product: both · Instance: `main` (Nultron Enterprise, `enterprise` lane). Live voice is **ON by default** unless `AGENTFORGE_VOICE=off|0|false`; to run the live smoke eval, start an isolated desk on its own port, never 3000 or 3200.

Last verified: 2026-11-24 on `chore/dfind-139-retire-desktop` (DFIND-139) merged with `main`: removed the retired `&& !isElectron()` guard from `apps/web/lib/voice-browser-deps.ts`, alongside `main`'s P0 fixes (barge-in unpause in `PlaybackQueue.drop`/`endTurn`, `ask_nultron` ack->thinking transition & separate answer playback window, push-to-talk immediate-onset VAD calibration & PTT barge-in commit), voice enabled by default (`AGENTFORGE_VOICE` kill-switch + optional `AGENTFORGE_VOICE_OWNERS` allowlist in server mode), `maskPii` on transcripts & `ask_nultron` answers, interactive controls (visualizer, Mute/Unmute, Stop/Interrupt, Done/Send, Spacebar PTT, card Dismiss), read-tool `onProgress` captions, ack backoff TTL & punctuation normalization, and transient talker error retry captions. Earlier: 2026-11-20 — voice delegation. Plan: [`../voice-mode-plan.md`](../voice-mode-plan.md). Feature recipe: [`../../../.cursor/skills/verify-agentforge/features/voice.md`](../../../.cursor/skills/verify-agentforge/features/voice.md).

## Overview

Live voice lets a person talk to their desk in Chat over one browser WebSocket and hear spoken answers in about 1 to 1.5 seconds, cut in at any time, and keep every finished or cut turn saved in the thread as text.

Three model calls share the work. All of them go from the host to the gateway; the browser never talks to a model.

- **The talker** (`packages/host/src/voice/talker.ts` is the contract, `packages/host/src/voice/talker-omni-http.ts` is the one implementation) is an HTTP speech-to-speech client: `POST <gateway>/chat/completions`, streaming, `modalities: ["text", "audio"]`, `audio: { voice, format: "wav" }` (`talker-omni-http.ts:530,723-745`). The model is `qwen3.5-omni-flash` (`VOICE_DEFAULT_MODEL`, `packages/host/src/voice/flag.ts:16`) and the voice is `Tina` (`VOICE_DEFAULT_VOICE`, `flag.ts:17`; the gateway refuses `cherry`). It speaks small talk and the answers it is given, and has one tool, `ask_nultron`. Its prompt is `talker-prompt.ts`.
- **The thinker** (`packages/host/src/voice/ask.ts`) runs when the talker calls `ask_nultron`. It is the thread's own Chat setup (`prepareChatRun`, `packages/host/src/runs.ts:158-279`) with a tool allow-list (`ask-tools.ts`): reads run, `delegate` runs (a hired mode or a `tb-` desk bot, inside the fenced delegated run), and a write, paid media or a generalist worker becomes a one-tap card instead of running.
- **The transcriber** (`packages/host/src/voice/transcriber-gateway.ts`) is `POST <gateway>/audio/transcriptions` with `muse-voice-transcribe-1.0` (`TRANSCRIBE_MODEL`, `transcriber-gateway.ts:12`). It runs beside the talker, off the reply's critical path, so the saved turn and the caption carry the person's exact words.

The host also finds speech and silence itself (`packages/host/src/voice/vad.ts`), because the gateway refused realtime WebSockets for this account type (`packages/host/src/voice/talker.ts:3-5`).

## Which file does what

In this page a file name with no directory is in `packages/host/src/voice/` (`protocol.ts` is `packages/core/src/voice/protocol.ts`). A bare `:N` line number belongs to the file named in the italic line under that section's heading; a cite of any other file always names it.

| Step | File |
| --- | --- |
| Open a session (H1) and end it (H3) | `packages/host/src/handlers/voice.ts`, routes at `packages/host/src/router.ts:372-373` |
| Socket upgrade (H2), every guard before the handshake | `packages/host/src/voice/upgrade.ts`, mounted by `apps/web/server.ts:74` |
| Talker, transcriber and key wiring | `packages/host/src/voice/wiring.ts` |
| Session registry and its timers | `packages/host/src/voice/sessions.ts` |
| One socket's turn loop, cut-ins, saving | `packages/host/src/voice/relay.ts` |
| Speech and silence detection | `packages/host/src/voice/vad.ts` |
| Turn timing, word rules, trimming a cut reply | `packages/host/src/voice/turns.ts` |
| The thinker | `packages/host/src/voice/ask.ts`, `ask-tools.ts`, `ask-speech.ts`, and `prepareChatRun` / `chatHistoryFromRows` in `packages/host/src/runs.ts` |
| Saving turns | `packages/host/src/voice/save-turns.ts` |
| Ledger rows | `packages/host/src/voice/metering.ts` |
| The contract (frames, limits, refusals) | `packages/core/src/voice/protocol.ts` |

## Ownership

`lanes.json` maps these globs to this page, lane `tester`. Only the first is `protected` (a change needs the lead's word).

| Glob | Protected | What it holds |
| --- | --- | --- |
| `packages/core/src/voice/**` | yes | `protocol.ts` and its test |
| `packages/host/src/voice/**` | no | relay, upgrade, sessions, wiring, VAD, turn rules, talker, transcriber, thinker, metering, flag |
| `packages/host/src/handlers/voice.ts` | no | H1 and H3 |
| `packages/host/eval/voice/**` | no | the eval runner, its fixtures and `real-relay.test.ts` |
| `apps/web/components/voice/**` | no | the voice view, mic and hold buttons, `use-voice-session.ts` |
| `apps/web/lib/voice-*` | no | browser audio, socket client, cut-in rules, view reducer |
| `apps/web/locales/*/voice.json` | no | the voice copy, `en` and `id` |

Voice also touches files that other pages own: `packages/host/src/handlers/settings.ts`, `router.ts`, `http-adapter.ts`, `index.ts`, `runs.ts`, `packages/core/src/usage/metering.ts`, `apps/web/server.ts`, `chat-session.tsx`, `chat-composer.tsx`, `composer-bare.css`, `i18n.ts` and `settings-read.ts`. Keep a change there to the voice lines.

## End-to-end walk: from the mic tap to the saved turn

### 1. The tap, in the browser (before H1)

1. `GET /api/v1/settings` carries `voice: { enabled, model }` (`packages/host/src/handlers/settings.ts:146`, from `voiceSettingsFor`, `flag.ts:26-38`). `useVoiceSession` reads it once (`apps/web/components/voice/use-voice-session.ts:74-84`, `readVoiceEnabled` in `apps/web/lib/voice-settings.ts:17-24`), and the pane may forbid it: `ChatSession` takes `voiceEnabled` (default on) and passes it as the hook's `allowed`, so `available` is `enabled && allowed`. Only the orchestrator's Chat leaves it on — a specialist agent's pane passes `agent.generalist` and a team bot's pane passes `false` (`agent-chat-pane.tsx`, `team-bot-chat-pane.tsx`). With voice off or not allowed, `VoiceMicButton` renders nothing (`apps/web/components/voice/voice-mic-button.tsx:31-33`).
2. A tap on `composer-mic` calls `toggle()` (`use-voice-session.ts:120-130`) and then `begin()` (`use-voice-session.ts:97-118`) and `VoiceClient.start()` (`apps/web/lib/voice-client.ts:96-110`). A tap while a Chat reply streams does nothing (`use-voice-session.ts:125-127`); a tap while voice is open ends it.
3. Before the first `await`, `start()` checks the secure context and browser support and builds `new VoiceAudio()` (`voice-client.ts:98-105`). That constructor makes the `AudioContext` (24 kHz if the browser allows it) and calls `resume()` while the tap's user gesture is still live (`apps/web/lib/voice-audio.ts:75-85,115-119`).
4. `run()` makes sure the Chat thread exists (`voice-client.ts:115`, `ensureThread` in `apps/web/components/chat-session.tsx:240`), then opens the **microphone first** with `audio.start()` (`voice-client.ts:125`) and only then calls H1 (`voice-client.ts:132`). The host drops a session nobody connects to within `VOICE_LIMITS.connectMs` (30 s), and a permission prompt can take longer.
5. `audio.start()` asks for mono audio with echo cancellation, noise suppression and auto gain (`voice-audio.ts:126-128`), loads the one worklet module (`voice-audio.ts:138`, see "The browser voice view") and builds the graph (`voice-audio.ts:178`): microphone to the `voice-capture` processor, which emits 40 ms frames (1,920 bytes, `apps/web/lib/voice-pcm.ts:13-15`) and a loudness number every 20 ms (`apps/web/lib/voice-capture-core.ts:14`); agent audio goes to the `voice-playback` processor. If the browser will not join a 24 kHz context to the microphone (Firefox), `replaceContext()` rebuilds the context at the microphone's own rate and the worklets convert (`voice-audio.ts:137-147,164-172`).

### 2. H1 — `POST /api/v1/voice/sessions`

_Bare line numbers in this section are in `packages/host/src/handlers/voice.ts`; a cite of any other file names it._

`openVoiceSession` (`apps/web/lib/voice-session-api.ts:39-61`) posts `{ threadId }`, plus `mode` when it is not `hands_free`, through `apiFetch`, so H1 carries the CSRF header and the session cookie like any other mutating call. `handlePostVoiceSession` (`packages/host/src/handlers/voice.ts:53-104`) does, in this order:

1. `getTenant(request)` (`:55`): the desk comes from the workspace cookie.
2. A missing `threadId` or an unknown `mode` is `400 invalid_request` (`:59-62,106-110`).
3. The voice flag (`voiceSettingsFor`): off is `403 voice_disabled` (`:63-67`, `VOICE_REFUSALS.disabled`, `packages/core/src/voice/protocol.ts:230-236`).
4. `getThread` must find the thread on this desk, else `404 not_found` (`:68-71`).
5. `requireGatewayAllowedFor(tenant)` (`:72`): a closed gateway gate is passed through as `403 gateway_blocked`; the browser reads both the envelope and the gate's flat body (`apps/web/lib/voice-errors.ts`).
6. `voiceSessions().atCap(tenant)` (`:73-75`): `429 voice_session_limit` when `maxOpenPerProcess` (8) sessions are open and none is this owner's. Replacing your own session does not count.
7. `voiceWiring().modelsFor(tenant, model)` (`:76-79`) is `createVoiceModels` (`packages/host/src/voice/wiring.ts:45-61`). It returns `null`, so H1 answers `503 voice_model_unavailable`, when the desk is not on the live runtime (`resolveRuntimeMode`, `wiring.ts:47-52`) or has no key (`resolveProviderKeys(settings).openai`, `wiring.ts:53-54`). Otherwise it builds the talker and the transcriber with `resolvedGatewayBaseUrl()` and that key.
8. `voiceSessions().open(...)` (`handlers/voice.ts:80-92`, `packages/host/src/voice/sessions.ts:97-139`): it ends any open session of the same owner with `replaced` (`sessions.ts:102-106`; the owner is `tenantId`, `organizationId` and `userId`, `sessions.ts:51-53`), mints a 128-bit id (`randomBytes(16)` base64url, `sessions.ts:65-67`), and arms two timers: `connectMs` (30 s, ends the session as `dropped` if no socket attached, `sessions.ts:128-130`) and `maxSessionMs` (15 min, ends it as `max_length`, `sessions.ts:131-133`). H1 answers `201` with `{ sessionId, threadId, model, streamPath, endsAt }` (`handlers/voice.ts:93-100`). No key is in that body.

H3, `POST /api/v1/voice/sessions/:id/end` (`handlers/voice.ts:116-129`, route `router.ts:373`), is idempotent: it answers `{ minutes }`, and a missing session or another owner's session is the same `404 not_found`, also when voice is off.

### 3. H2 — the WebSocket upgrade (`GET /api/v1/voice/sessions/:id/stream`)

_Bare line numbers in this section are in `packages/host/src/voice/upgrade.ts`; a cite of any other file names it._

`attachVoiceUpgrade(server)` (`packages/host/src/voice/upgrade.ts:92`, exported at `packages/host/src/index.ts:13`, called at `apps/web/server.ts:74`) listens on the server's `upgrade` event. An upgrade never passes the HTTP router, so it redoes the checks a mutating request would have had, in this order:

1. **Path** (`upgrade.ts:94-102`): the path must match `VOICE_STREAM_PATH_PATTERN` (`protocol.ts:246`). Any other path is left untouched (the handler returns without writing to the socket), so Vite's dev WebSocket keeps working.
2. **Host** (`:112-117`): `hostRejection` from the HTTP adapter (`packages/host/src/http-adapter.ts:806-813`). Off server mode the Host must be loopback; in server mode it must be an allowed web host. Refused with `403`.
3. **Transport rules, server mode only** (`:118-132`): `transportRejection` (`http-adapter.ts:482-507`): `https` required (`X-Forwarded-Proto`), the request filter, and the per-IP and per-session rate buckets (`429` with `Retry-After`).
4. **Origin** (`:133-149`): a missing or blank `Origin` is `403 origin_forbidden` in **both** modes (the HTTP adapter would let a header-less local call through; a socket is only ever opened by the page). A present `Origin` must pass `isAllowedWebOrigin(origin, trustedOrigins())` in server mode or `isAllowedMutatingApiRequest(origin)` otherwise (`packages/host/src/local-request.ts:99-105,80-89`).
5. **Desk** (`:150-161`): the workspace id comes from the workspace cookie through `requestWorkspaceId` (`http-adapter.ts:538-540`), the function the adapter uses, so the socket resolves the desk H1 used.
6. **Session and tenant** (`:166-205`): in server mode `requireSessionFor` must find a signed-in session (`401` otherwise); then `getTenant` must give a tenant (`401`, `403` or `404` as the router would).
7. **Voice session** (`:206-210`): the id must exist, not be ended, not already have a socket, and `sameVoiceOwner` must match (`sessions.ts:55-62`: tenant, organisation, workspace and user). Every failure is the same `404 not_found`.
8. **Voice flag** (`:211-214`): `voiceSettingsFor(tenant).enabled`, else `403 voice_disabled`.
9. **Gateway gate** (`:215-220`): `requireGatewayAllowedFor(tenant)`, else `403 gateway_blocked`.
10. **Handshake** (`:221-224`): `WebSocketServer` with `maxPayload: VOICE_MAX_AUDIO_FRAME_BYTES` (48,000) and `perMessageDeflate: false` (`:39-43`) completes it and starts `new VoiceRelay(ws, voice).start()`. A relay that cannot `attach` (`sessions.ts:146-152`) closes the socket.

**Why no CSRF token:** a browser cannot set a header on a `new WebSocket()` handshake, so the double-submit token has nowhere to ride. The defence is the Origin allowlist (step 4), which a page cannot forge, plus the Host rule, the session cookie, and an unguessable single-use session id that H1 minted behind its full CSRF check and that is bound to the owner and desk (step 7).

**Refusals are a status line only** (`upgrade.ts:64-86`): `HTTP/1.1 <status> <stock reason>`, `Connection: close`, `Content-Length: 0` (and `Retry-After` on a `429`), then the socket is destroyed. No reason code, session id or path goes to the client. In server mode it logs `request_filtered` with the code, status, path length and IP, never the path, session id or cookie (`:57-73`).

### 4. The relay's turn loop (`packages/host/src/voice/relay.ts`)

_Bare line numbers in this section are in `packages/host/src/voice/relay.ts`; a cite of any other file names it._

1. **Start** (`VoiceRelay.start`, `relay.ts:172-199`): attaches to the registry, loads the thread's last 6 text messages (`recentVoiceHistory`, `save-turns.ts:9,25-35`), opens the talker session (`relay.ts:183`), sends `ready` then `state: listening` (`:184-190`), and replays any frame that arrived before it was ready. The idle timer starts here (`noteActivity`, `:1099-1104`) and is re-armed, not fired, while an ask is in flight (`askInFlight`, so a delegated run cannot idle the session out).
2. **Audio in** (`onMessage` and `feed`, `:244-317`): a binary frame is 16-bit little-endian mono PCM at 24 kHz; an odd length is dropped (`:248`); a frame over 48,000 bytes never reaches the relay: the `ws` library enforces `maxPayload` and closes the socket, so the session ends as `dropped` (`relay.ts:164-169`). More than 3 seconds of audio per second of wall time, measured over a window of at least 1 s, ends the session as `dropped` (`noteRate`, `:282-297`, `audioFasterThanRealtime`, `packages/host/src/voice/pcm.ts:16-19`). Audio is fed to the detector in 20 ms slices (`SLICE_MS`, `relay.ts:28`). The 420 ms before speech starts (`PRE_ROLL_MS`, `:27`) is kept, so the first word is not clipped.
3. **Speech start** (`onSpeechStart`, `:356-374`): the first speech of a turn moves the state to `hearing`, starts the utterance buffer, and numbers the turn (`u<n>`, `a<n>`, `ack<n>`, `beginTurnIds`, `:1043-1050`). The buffer keeps growing, silence included, until the reply is released. At 30 s (`VOICE_LIMITS.maxUtteranceMs`) the relay forces the turn to end as if `commit` had come (`:345-352`).
4. **How a turn ends in hands-free** (`consider`, `:392-406`; the numbers are in the `TURN_TIMING` table):
   - After `earlySendMs` (300 ms) of silence the relay sends the whole utterance to the talker (`startReply`, `:420-445`) but **holds every event it gets back** in `buffered` (`onTalkerEvent`, `:470-501`). The browser hears nothing yet.
   - The reply is released (`flush`, `:527-535`: state `thinking`, buffered events applied) once a text, audio or `ask` event has arrived and the silence has reached `endSilenceMs` (700 ms) (`canRelease`, `:408-410`).
   - If the person speaks again before the release, the speculative reply is dropped silently: its stream is aborted, its buffer and transcription are discarded (`abortEarly`, `:376-390`), and the longer utterance is sent when they stop. Nothing is sent to the browser.
   - The talker can say the sentence is unfinished with a `wait` event (the `keep_listening` tool, which ships off, see below). The relay also treats an `ask` whose question reads unfinished (`judgeTurnEnd`, `turns.ts:182-225`: ends on "yang", "and", a hesitation, "...") as a `wait` (`isUnfinished`, `relay.ts:503-510`). A `wait` aborts the reply, discards the buffer, goes back to `listening` and holds (`holdForWait`, `:512-525`). A held turn is answered only when silence reaches `maxSilenceMs` (2,500 ms), and then the talker is called with `mustAnswer` and may not wait again (`:397-399,522-524`).
   - In **push-to-talk** the detector never ends a turn (`:393`): the browser sends frames only while the button is held and `commit` on release (`apps/web/lib/voice-client.ts:275-280,327-339`). `commit` is ignored if the detector never heard speech (`relay.ts:413`); otherwise it sets `mustAnswer`, starts the reply and releases it when events arrive (`onCommit`, `:412-418`).
5. **The talker's events** (`apply`, `:538-572`): `audio` is forwarded to the browser in frames of at most 48,000 bytes (`forwardPcm`, `:663-690`; the first one moves the state to `speaking` and sets the latency number), `text` builds the assistant caption (at most one caption per 100 ms, `captionAssistant`, `:1028-1041`), `usage` is held for the ledger, `ask` diverts to the thinker (step 6), `done` ends the reply. A reply with no text, no audio and no ask goes back to `listening` without saving (`:473-479,560-563`).
6. **`ask_nultron`** (`handleAsk`, `:574-613`): the relay sends the question as the person's final caption, plays the cached acknowledgement (below) with its caption `ack<n>`, calls the thinker (`voiceWiring().ask`, 20 s limit that becomes 180 s once a `delegate` call starts, see section 6), captions each `delegating` progress label through `onProgress` (UI only, a fresh caption id per line, never saved), sends a `card` frame if it needs a tap, then calls the talker again with the thinker's text (`talkerSession.answer`, through `startReply(true)`, `:607-612`), and the talker speaks it. On an `ask` turn the saved words of the person are the question the talker passed on, and the transcriber is not started (`this.asked`, `:616`).
7. **Words and caption of the person** (`maybeTranscribe` and `runTranscribe`, `:615-661`): the transcriber starts on the first audio or text event of the reply, buffered or not (`:491,541,546`), on the whole utterance, with up to 2 tries of 15 s each (`relay.ts:635`, `transcriber-gateway.ts:13`). When it answers, the relay sends the person's final caption (`:658`). It takes 3 to 5 s, so the words arrive after the agent has started to answer; the browser puts them above that turn's reply (see "What the two live-run fixes changed"). If it fails the turn is saved with `Voice message` / `Pesan suara` (`PLACEHOLDER`, `:37`).
8. **Saving** (`tryFinalize` and `finalize`, `:704-738`): when the talker is done, the estimated playback time of the audio has passed (`schedulePlayback`, `:692-702`) and the person's words are known, the relay saves the turn (`saveVoiceTurn`: one user row then one assistant row through `insertMessage`; the assistant row leads with the ask's `tool_call` parts — today only `delegate` — then the text, `save-turns.ts:38-60`), tells the talker what was said (`remember`), records the talker's tokens, sends `saved` and `metrics`, resets, and sends `state: listening`. Saves go one at a time in order (`enqueueSave`, `:928-935`). The browser reloads the thread on `saved` (`use-voice-session.ts:163-173`, `refreshMessages` at `chat-session.tsx:395-401`).

**Acknowledgement.** While the thinker works, the relay plays a fixed sentence (`ACK_SENTENCE`, `talker-prompt.ts:41-44`: "One moment, let me check." / "Sebentar, saya cek dulu."). The audio is made once per process for each (model, voice, locale) by asking the talker to read it, started when a talker session opens (`startAck`, `talker-omni-http.ts:534-547`, `runAcknowledgement`, `talker-omni-http.ts:799-860`). It is cached only if the model's transcript matches the sentence word for word (`sameWords`, `talker-omni-http.ts:283-285,841`). Until it is cached, `acknowledgement()` returns `null` and nothing plays (`talker-omni-http.ts:707-713`).

**Failures.** A talker error goes back to `listening` and the turn is dropped; the third failure in a row ends the session as `error` (`failTalker`, `relay.ts:1002-1011`, `FAILURES_BEFORE_END`, `relay.ts:33`).

**Talker history.** The relay loads the last 6 text messages of the thread (`save-turns.ts:9`); the talker then keeps the last 12 turns, adding each turn as it is saved (`talker-omni-http.ts:39,637-652`).

### 5. The talker (`talker-omni-http.ts`, `talker-prompt.ts`)

_Bare line numbers in this section are in `packages/host/src/voice/talker-omni-http.ts`; a cite of any other file names it._

- **Request:** the system prompt (`TALKER_INSTRUCTIONS`, `talker-prompt.ts:17-38`: one or two short sentences, call `ask_nultron` for any fact or task, never name a tool), the history, then the utterance as an `input_audio` part holding a WAV data URI (`inputAudioPart`, `packages/host/src/voice/talker-wav.ts:39-48`). Tools come from `gatewayTools(mustAnswer)` (`talker-prompt.ts:90-95`), `tool_choice: "auto"` (`talker-omni-http.ts:723-745`).
- **Output:** text deltas, base64 PCM aligned to whole samples, tool calls, a final `usage` chunk. `decide` turns the finished stream into speak, `ask`, `wait` or a failure (`:260-281`).
- **Limits:** 8 s to the first byte, 10 s of silence mid-stream (`TALKER_FIRST_BYTE_MS`, `TALKER_SILENCE_MS`, `:35-36`).
- **Errors:** 401 and 403 are `refused`, 5xx and timeouts are `unavailable`; the response body never goes into the message (`failureFor`, `:150-164`).
- **`keep_listening` ships off.** The tool exists (`KEEP_LISTENING_GATEWAY_TOOL`, `talker-prompt.ts:74-87`, parsed in `decide`, `talker-omni-http.ts:262-266`) but `OFFER_KEEP_LISTENING = { on: false }` (`talker-prompt.ts:15`), so `gatewayTools` offers only `ask_nultron`. In the talker's live check on 2026-11-10 an unfinished sentence waited in only 2 of 3 runs and was answered in the third (`talker-prompt.ts:11-14`, `packages/host/eval/voice/talker-live.mts`). So the talker never sends `wait` today; the only holds are the `ask` rule above and speech resuming before the release.
- **`hearShort`** (`:654-705`) is a text-only call (`modalities: ["text"]`, `hearBody`, `:786-797`) on a short overlap, with a 2 s limit (`HEAR_SHORT_MS`, `:37`).

### 6. The thinker (`ask.ts`, `ask-tools.ts`, `ask-speech.ts`)

_Bare line numbers in this section are in `packages/host/src/voice/ask.ts`; a cite of any other file names it._

`askNultron` (`ask.ts:181-433`) never throws. It returns `answer` (with `toolCalls`, the `delegate` calls it made, `:65-81`), `needs_tap`, or `refused` with a reason (`gateway_blocked`, `busy`, `timeout`, `failed`) and a fixed sentence the talker reads (`ASK_COPY`, `ask-speech.ts:26-47`, whose `delegating(label)` line captions a hand-off). It does, in order:

1. **Gates and run slot** (`:185-205`): the gateway gate again; one ask at a time per (organisation, thread) (`inFlight`, `:124,198-200`); then `admitVoiceSlot` (`:136-146`), which takes one of the company's run slots without waiting and refuses when the company is at `cap - 1` runs, **so the last slot is always left for a typed Chat turn**. Off server mode there is no cap (`packages/host/src/run-limits.ts:71-74`); on the hosted server the default is 6 (`DEFAULT_MAX_RUNS_PER_TENANT`, `packages/host/src/run-limits.ts:36`, read at `packages/host/src/run-limits.ts:76`).
2. **Chat setup** (`:274-307`): `prepareChatRun` with `{ content: question, thinking: false }` (`:276-283`) gives the agent, model, prompt, Knowledge Base and tools; `chatHistoryFromRows` (`:294`, `packages/host/src/runs.ts:286-314`) gives the thread's earlier messages (the question is not sent twice if it is already the last row, `:287-292`). The system prompt gets `voiceNote(locale)` (`ask-speech.ts:55-63`: answer aloud in at most three short sentences, no markup, and `delegate` for the desk's agents) appended (`ask.ts:364`), the budget is `VOICE_BUDGET` (5 steps, 6 tool calls, `delegate` at `DELEGATE_PER_TURN`, `:114-118`), and the run sits inside the same outbound guard as a typed turn (`createOutboundGuard`, `:301-307`).
3. **Tools** (`ask-tools.ts:37-98,134-148`): `voiceBindings` keeps the bindings on `VOICE_READ_TOOLS` and `VOICE_DELEGATE_TOOLS` and adds `request_tap`.
   - `VOICE_READ_TOOLS`: `calculator`, `datetime`, `knowledge_search`, `past_sessions`, `list_files`, `read_file`, `search_files`, `self_check`, `web_search`, `web_fetch`.
   - `VOICE_DELEGATE_TOOLS`: `delegate` alone. It runs because the run it starts is already fenced (`packages/host/src/delegation/run-delegation.ts`: no picture or clip tools, the desk's files only, a tainted egress guard, `DELEGATE_BUDGET`, the eight-minute worker ceiling), so a spoken request can hand work to a hired mode or a `tb-` bot without the tap a write or a worker would need.
   - `VOICE_TAP_TOOLS` (a request for one becomes a card): `write_file`, `edit_file`, `delete_file`, `image_generate`, `video_generate`, `build_deck`, `run_code`, and `GENERALIST_WORKER_TOOLS` (the generalist's workers; `delegate` left this list, `packages/core/src/agents/virtual-agents.ts:90,96`).
   - A Chat tool on none of the lists is a failing test (`unclassifiedChatTools`, `ask-tools.ts:95-98`, `ask-tools.test.ts:44-49`).
4. **The worker channel** (`ask.ts:342-380`): the execute call runs inside `withWorkerChannel({ emit, signal: run.signal })`, so a delegated run reads the ask's own abort — a cut-in, the session ending, the clock, a tap — as its cancel, and its `job.phase { phase: "delegating", label }` progress reaches `AskInput.onProgress` (deduplicated by label, `:345-357`). Everything else the channel could carry is ignored.
5. **The tap:** when the model starts `request_tap`, `ask.ts:313-316` stops the run, and the result is `needs_tap` with a card `{ prompt: question, summary }` (`:392-398`; `tapSummary`, at most 200 characters, `ask-speech.ts:70-82`). The relay sends `{ type: "card", card }` (`relay.ts:606`); the talker then speaks `ASK_COPY[locale].needsTap` through the answer leg.
6. **The clocks:** 20 s (`ASK_TIMEOUT_MS`, `ask.ts:97,219`) for a plain ask; the first `tool.started` for `delegate` replaces it with 180 s measured from when the ask started (`ASK_DELEGATE_TIMEOUT_MS`, `armDelegateClock`, `:104,222-231`), because a delegated run is real work — the delegated run's own `WORKER_MAX_MS` ceiling still bounds it underneath. Then `refused` with `timeout`. The answer is stripped of markdown for speech (`speakable`, `ask-speech.ts:94-126`).
7. **The delegate calls it keeps** (`ask.ts:257-259,317-335`): on `tool.started`/`tool.completed` for `delegate` only, the run builds `ToolCallPart`s exactly as `runs.ts` persists a typed turn's (`:781-807` there): redacted input on `started`, the matching entry completed with redacted output. They ride the `answer` result to the relay, which saves them ahead of the spoken text (`save-turns.ts`), so the desk's delegate card renders the hand-off unchanged.
8. **It saves nothing.** No message, run row, title or card is written by the ask itself (`ask.ts:6-9,174-176`, tested in `ask.test.ts`). The relay saves the spoken turn — with the tool parts.
9. **Usage is recorded here, under the Chat mode** (`recordChatRunUsage(tenant, runId, true, usage)` at `ask.ts:268`, or an unknown-size `recordTokenUsage(..., { mode: "chat", runId })` for a run stopped after it reached the model, `:414-424`). A delegated run's own spend joins the same ledger inside `run-delegation.ts`. The relay never records the thinker.

### 7. Ending the session

_Bare line numbers in this section are in `packages/host/src/voice/relay.ts`; a cite of any other file names it._

The browser ends voice with `{ type: "stop" }` (`voice-client.ts:362-371`) or H3. Both go to `voiceSessions().end` (`sessions.ts:158-180`), which calls the relay's `shutdown` (`relay.ts:202-229`): it aborts work, saves any released but unsaved turn (`persistPartial`, `:753-768`, waiting up to 20 s for the person's words), sends `ended { reason }`, closes the socket, closes the talker session and writes the session-seconds ledger row.

End reasons (`VOICE_END_REASONS`, `protocol.ts:58`): `user` (stop frame or H3); `max_length` (15 minutes, `sessions.ts:131-133`); `idle` (2 minutes with no speech and no control frame, `relay.ts:1099-1104`); `dropped` (no socket in 30 s, the socket closed or errored, audio too fast, or a listener 3 seconds behind: `sessions.ts:128-130`, `relay.ts:164-169,286-289,1109-1112`); `error` (three talker failures in a row, or a failed start, `relay.ts:197,1010`); `replaced` (a newer H1 from the same owner, `sessions.ts:104`).

## How a cut-in is decided and trimmed

_Bare line numbers in this section are in `packages/host/src/voice/relay.ts`; a cite of any other file names it._

1. **Browser pause** (`apps/web/lib/voice-barge-detector.ts`, `voice-barge.ts`): while agent audio is playing, `BargeDetector` watches 20 ms microphone levels against a floor it learns (`minRms` 0.012, `ratio` 3, `warmupMs` 400, `voice-barge-detector.ts:39-45`). Loudness sustained for `BARGE_SUSTAIN_MS` (120 ms, `voice-barge-detector.ts:25`) — or the hold button pressed over the agent in push-to-talk (`BargeCoordinator.onHoldStart`, `voice-barge.ts:70-74`) — makes `bargeIn` (`voice-barge.ts:97-117`) pause playback, send `{ type: "barge_in" }`, and send `{ type: "played", ms }` with what was heard. If the host sends neither `resume_audio` nor `stop_audio` within `BARGE_RESUME_TIMEOUT_MS` (3 s, `voice-barge.ts:19`), the browser resumes by itself.
2. **The host opens an overlap** only after a reply has been released (from `thinking` until the turn is saved): either the browser's `barge_in` frame (`onBargeFrame`, `relay.ts:770-780`; if no speech is heard within `BARGE_SILENCE_MS`, 600 ms, the relay clears the overlap and sends `resume_audio`) or the detector's own `speech_start` at that time (`onSpeechStart`, `:371-373`; `armOverlap`, `:782-787`). The overlap keeps the audio and measures real speech: from where the detector says speech began to the last speech window, not the quiet it waits out (`overlapSpeechMs`, `:795-797`, `lastSpeechMs`, `vad.ts:60-65`).
3. **Decision:**
   - Speech reaches `interruptAfterMs` (700 ms): interrupt at once, no model call (`feedSlice`, `relay.ts:338-344`).
   - Speech ends sooner (`onOverlapEnd`, `:807-817`): `talkerSession.hearShort` (2 s, text only) gets rough words and `judgeBargeIn` decides (`judgeShort`, `:819-838`, `turns.ts:294-325`). With no words it is a **backchannel**. A stop word (`stop`, `tunggu`, `sebentar`, `berhenti`, `bukan`, `wait`, `no`, `enough`, "hold on", ...) is an **interrupt**. More than 3 words is an interrupt. Otherwise it is a backchannel only if every word is a listening word (`iya`, `ya`, `oke`, `sip`, `lanjut`, `terus`, `hmm`, `yeah`, `okay`, "uh huh", "go on", ...), else an interrupt. On a backchannel the relay clears the overlap and sends `resume_audio` (`relay.ts:836-837`).
4. **On an interrupt** (`doInterrupt`, `relay.ts:847-925`): send `stop_audio` (`:851`); abort the talker and the thinker (`:855-856`; a transcription still running is kept, see "What the two live-run fixes changed"); wait up to `playedWaitMs` (300 ms) for the browser's `played` (`waitPlayed`, `:987-1000`), falling back to the host's own estimate of audio sent since the first frame (`:865-870`); trim the assistant text to what was heard (`trimToHeard`, `turns.ts:344-367`); send the final assistant caption with `interrupted: true` (`:875-882`); save the turn; then send `state: listening` and, if the overlap held speech, start the next turn from that audio in `hearing` (`:916-922`).
5. **Subtracting the acknowledgement.** The browser's `played` counts every sample played since the last `state: listening`, the acknowledgement included (`PlaybackQueue.endTurn`, `apps/web/lib/voice-playback-core.ts:118-124`, called from `voice-client.ts:241-244`; the browser also takes off the speaker's output latency, at most 250 ms, `voice-audio.ts:362-368`). `assistantText` holds only the answer. So the relay subtracts the acknowledgement's duration from both the audio total and `played` before trimming: `totalMs = allMs - ackMs`, `playedMs = (played ?? estimate) - ackMs` (`relay.ts:862-870`). The relay therefore sends `listening` after every cut reply, before `hearing` (`:913-916`): without it the browser would carry this reply's heard time into the next one's.
6. **Trimming** (`trimToHeard`, `turns.ts:344-367`): the text is cut at the share `playedMs / totalMs` of its characters, then moved **back** to the start of the word it cut (never forward). Nothing played gives an empty text; everything played gives the whole text and no interruption. If no answer audio had been sent yet (`totalMs` 0: nothing, or only the acknowledgement), the relay does not call it and saves no assistant text (`relay.ts:871-872`).

## What the two live-run fixes changed

Both came from the first live run. _Bare line numbers in this section are in `packages/host/src/voice/relay.ts`; a cite of any other file names it._

- **`6f7837cc` — a cut or ended turn saves the person's words, not the placeholder** (`packages/host/src/voice/relay.ts`). The transcriber needs 3 to 5 s and starts when the reply's first audio arrives, so a cut (or an end) in the first seconds aborted it and saved `Pesan suara` in place of what the person said; every cut turn had no words of theirs in the thread. Now a cut keeps its transcription running and lets the next turn go on at once (`doInterrupt`, `relay.ts:854-858`); the turn is saved, with the person's caption and `saved`, when the words arrive, up to 20 s (`saveCutTurnWhenHeard`, `:963-985`, `LATE_WORDS_WAIT_MS`, `:43`). Saves go through one in-order chain, so the next turn lands behind it (`enqueueSave`, `:928-935`). An ended session waits for the words the same way (`shutdown`, `:208-209`, `persistPartial`, `:753-768`).
- **`4fbbe0d2` — the person's words show above the reply to them** (`apps/web/lib/voice-view-state.ts`). The transcript arrives after the agent has started to answer, and a late caption was appended, so every turn read "agent, then you". A new user caption is now put above its own turn's first reply (ids `u3`, `a3`, `ack3` name turn 3); a revision still replaces in place, and an id with no turn, or a turn with no reply yet, appends (`applyCaption`, `apps/web/lib/voice-view-state.ts:109-140`, `turnOf`, `apps/web/lib/voice-view-state.ts:103-106`).

## Timing and protocol constants

### `TURN_TIMING` (`packages/host/src/voice/turns.ts:21-42`)

| Constant | Value | What the relay does with it |
| --- | --- | --- |
| `earlySendMs` | 300 ms | Silence after speech at which the utterance is sent to the talker and the reply held (`relay.ts:401-403`). |
| `endSilenceMs` | 700 ms | Silence at which a held reply is released, once an event has arrived (`relay.ts:408-410`). |
| `maxSilenceMs` | 2,500 ms | Silence at which a turn the talker would not answer is answered anyway, with `mustAnswer` (`relay.ts:397-399,522-524`). |
| `interruptAfterMs` | 700 ms | Speech over the agent that counts as a cut-in without reading the words (`relay.ts:340,810,830`). |
| `playedWaitMs` | 300 ms | How long `doInterrupt` waits for the browser's `played` (`relay.ts:998`). |
| `waitAfterUnfinishedMs` | 1,200 ms | Defined and tested in `turns.ts:32`, **not read by the relay**. |

### Detector (`packages/host/src/voice/vad.ts`)

_Bare line numbers in this section are in `packages/host/src/voice/vad.ts`; a cite of any other file names it._

It reads 16-bit PCM in **10 ms windows** (`WINDOW_MS`, `vad.ts:84`) and gives each one a level (RMS with the mean removed). The relay feeds it 20 ms slices. The first 5 windows of a stream set the room's floor (`:102`); after that the floor falls fast and rises slowly, capped at 0.03 (`:92-94`).

| `VAD_DEFAULTS` field | Value | Meaning (`vad.ts:71-81`) |
| --- | --- | --- |
| `threshold` | 0.01 | The lowest level that can count as speech. The bar is `max(threshold, floor * noiseRatio)`. |
| `noiseRatio` | 3 | Speech must be this many times the floor to start. |
| `releaseRatio` | 0.5 | Once speaking, a window carries on above this share of the start bar. |
| `minSpeechMs` | 120 | A run of loud windows shorter than this (a click) starts nothing. Gaps up to 40 ms inside a run do not break it. |
| `hangoverMs` | 300 | Silence that ends speech. It must not exceed `earlySendMs`: `silenceMs` is 0 until `speech_end` fires (`:25-26,316-318`). |
| `floorRiseMs` | 1,000 | About how long a rise in the room's level takes to be learned. |
| `steadyMs` | 1,500 | A level that stays within a ratio of 1.8 for this long is the room, not speech (`:96`). |

`speech_start.atMs` is moved back to the start of a soft opening consonant (up to 30 windows, `:98,172-191`). `lastSpeechMs` is where the last speech window ended (`:60-65`).

### Relay constants (`packages/host/src/voice/relay.ts:26-43`)

`PRE_ROLL_MS` 420; `SLICE_MS` 20; `CAPTION_MIN_GAP_MS` 100; `BARGE_SILENCE_MS` 600; `FAILURES_BEFORE_END` 3; `LATE_WORDS_WAIT_MS` 20,000.

### `VOICE_LIMITS` and frame sizes (`packages/core/src/voice/protocol.ts:11-37`)

_Bare line numbers in this section are in `packages/core/src/voice/protocol.ts`; a cite of any other file names it._

| Constant | Value | Meaning |
| --- | --- | --- |
| `VOICE_SAMPLE_RATE` | 24,000 Hz | Mono, 16-bit little-endian PCM (`:11-13`). |
| `VOICE_FRAME_MS` | 40 ms | The browser's frame: 960 samples, 1,920 bytes (`:16`, `apps/web/lib/voice-pcm.ts:13-15`). |
| `VOICE_MAX_AUDIO_FRAME_BYTES` | 48,000 | The largest binary frame either way: 1 s of audio. Also the socket's `maxPayload` (`:19`, `upgrade.ts:41`). |
| `VOICE_MAX_TEXT_FRAME_BYTES` | 4,096 | The largest JSON frame from the browser; a larger one is dropped (`:21,113`). |
| `maxSessionMs` | 900,000 (15 min) | Ends the session as `max_length` (`:26`). |
| `idleMs` | 120,000 (2 min) | No speech and no control frame ends it as `idle` (`:28`). |
| `connectMs` | 30,000 (30 s) | H1 to socket attached, else `dropped` (`:30`). |
| `maxOpenPerOwner` | 1 | A new H1 ends the owner's older session as `replaced` (`:32`). |
| `maxOpenPerProcess` | 8 | A 9th owner gets `429 voice_session_limit` (`:34`). |
| `maxUtteranceMs` | 30,000 (30 s) | Longest utterance sent to the talker; the relay then ends the turn (`:36`). |

Outbound audio is also bounded: a socket with more than 3 s of audio (144,000 bytes) waiting ends the session as `dropped` (`VOICE_OUTBOUND_BACKLOG_BYTES`, `packages/host/src/voice/pcm.ts:22-26`, `relay.ts:668-671,1109-1112`).

## Feature flags and environment variables (`packages/host/src/voice/flag.ts`)

_Bare line numbers in this section are in `packages/host/src/voice/flag.ts`; a cite of any other file names it._

`voiceSettingsFor(tenant, env, serverMode)` (`flag.ts`) says whether voice is offered and admitted (the settings answer, H1 and H2 all call it):

- `AGENTFORGE_VOICE`: **ON by default**. Explicit kill-switch `off`, `0`, or `false` (case-insensitive) disables voice.
- `AGENTFORGE_VOICE_OWNERS`: **user ids**, comma-separated, case-insensitive, server mode only (`flag.ts`). When unset or blank, all authenticated users on desks with a live key are allowed. When explicitly set, access is restricted to the listed `userId`s.
- `AGENTFORGE_VOICE_MODEL`: the talker model; defaults to `qwen3.5-omni-flash`.
- The talker needs the live runtime and a key on the desk (`createVoiceModels`), else H1 is `503 voice_model_unavailable`.

## Where the gateway key lives and where it must never go

- `createVoiceModels` (`packages/host/src/voice/wiring.ts:45-61`) reads the key on the host with `resolveProviderKeys(loadSettings(tenant)).openai` (`wiring.ts:53`), the same call a Chat turn uses. Hosted, that is the tenant's own key; the gateway gate has already approved it.
- It goes only into the two `Authorization: Bearer` headers: `talker-omni-http.ts:331` and `transcriber-gateway.ts:72`.
- It is never in an H1 body (`handlers/voice.ts:93-100`), never in a frame (none of the frame types in `protocol.ts:70-109` has a field for it), and never in a log: the talker logs only counts and timings (`voice_talker`, `talker-omni-http.ts:512-524`), an error message never carries the gateway's body (`failureFor`, `talker-omni-http.ts:150-164`), and the host logger drops any field with a credential word in its name and runs `redactSecrets` over strings (`packages/host/src/log.ts:8-14`).
- **The test that proves it** is `"keeps the gateway key out of every log line, frame, response, saved row and ledger row"` (`packages/host/src/voice/relay.test.ts:1466-1595`). It sets `OPENAI_API_KEY` to the sentinel `voice-sentinel-key-6b1f0c9d2e47a83b` (`relay.test.ts:1467,1531`), runs a normal turn, a backchannel, an `ask_nultron` turn and a turn where the gateway answers 500 with a body that echoes the sentinel (`relay.test.ts:1498`), and asserts the sentinel appears only in the `Authorization` header of the calls to `/audio/transcriptions` and `/chat/completions` (`relay.test.ts:1574-1576`), and nowhere in log lines, text frames, binary frames, the H1 response, the thread's messages or the ledger rows (`relay.test.ts:1582-1588`).

## Metering

`USAGE_MODES` includes `"voice"` (`packages/core/src/usage/metering.ts:20-35`). A session writes up to four kinds of row:

| What | Mode | Unit | Model id on the row | Where |
| --- | --- | --- | --- | --- |
| Talker reply tokens | `voice` | `tokens` | the talker model (`session.model`: `qwen3.5-omni-flash` or `AGENTFORGE_VOICE_MODEL`) | `recordVoiceReplyUsage` (`metering.ts:12-18`), called when a turn is saved (`relay.ts:729-731`) and when the thinker's result returns (`relay.ts:602-605`). Priced from the token catalog (`recordTokenUsage`, `packages/host/src/usage-record.ts:182-199`). |
| Transcriber audio | `voice` | `seconds` (rounded up) | the transcriber (`muse-voice-transcribe-1.0`, `session.transcriberModel`) | `recordVoiceSeconds` (`metering.ts:25-37`), called when a transcript comes back (`relay.ts:652`). |
| Session length, H1 to end | `voice` | `seconds` (rounded up) | the talker model (`session.model`) | `SessionRegistry.meter` (`sessions.ts:183-189`), called once when the relay shuts down or, with no socket, from `end` (`sessions.ts:170-177`, `relay.ts:226`). The clock starts at H1 (`createdAt`), not at the socket. |
| Thinker (`ask_nultron`) | **`chat`** | `tokens` | the model the run reports (the thread's model; `prepared.version.model` on the stopped-run path) | `ask.ts:221,332-343`; the relay never records it. |

Seconds rows go through `priceSecondsUsage` (`usage-record.ts:102-108`): with no per-second list price for the model id they are unpriced, `unpricedReason: "no_list_price"`. A reply that is cut, or a session that ends mid-reply, records no talker token row: that path never reaches `recordVoiceReplyUsage` (`metering.ts:1-5`, [SR-213](../security-register.md#sr-213)).

## The browser voice view (`apps/web/components/voice/`, `apps/web/lib/voice-*`)

- **One worklet module, same origin.** `apps/web/lib/voice-worklet.ts` registers both processors, `voice-capture` and `voice-playback` (`voice-worklet.ts:144-145`). `apps/web/lib/voice-worklet-url.ts:12-14` imports it as `./voice-worklet?worker&url`, so Vite emits a hashed same-origin asset that `audioWorklet.addModule` loads under `script-src 'self'` (`packages/host/src/security-headers.ts:37`). Never change it to `?worker&inline`: a `blob:` or `data:` module URL is not allowed by `script-src`.
- **Microphone before H1:** see step 4 of the walk (`voice-client.ts:122-132`).
- **Reducer and buddy:** `voiceViewReducer` (`apps/web/lib/voice-view-state.ts:170-203`) turns every host frame and local event into one screen value. While voice is open and running, the view claims the desk buddy at `VOICE_BUDDY_PRIORITY` 61 (`voice-view-state.ts:225`, `apps/web/components/voice/voice-view.tsx:78`), above Chat's job priority 60 (`apps/web/lib/desk-buddy-state.ts:12`). The view keeps at most 80 captions (`VOICE_MAX_CAPTIONS`, `voice-view-state.ts:27`).
- **Tapping a card ends voice and sends the prompt through the composer.** `runCard` (`use-voice-session.ts:149-160`) calls `stopClient()` first, which sends `stop`, closes the socket and stops every microphone track, and then sends `card.prompt` as an ordinary typed Chat turn (`sendPrompt`, `chat-session.tsx:409-415`, through the composer's `continueSendRef`, `chat-composer.tsx:651-655`). The card then reads "Started in Chat" and the view closes after `VOICE_CARD_STARTED_MS` (2,400 ms, `use-voice-session.ts:27,224-231`). Voice never runs the work.
- **Voice stands down for Chat.** A Chat reply that starts streaming closes voice (`use-voice-session.ts:188-192`); so does opening another session in the rail (`use-voice-session.ts:177-185`); Escape closes the view (`use-voice-session.ts:197-208`).
- **Phone backgrounding.** `watchBackground` (`apps/web/lib/voice-browser-deps.ts:32-44`) stops voice on `pagehide` everywhere and on a hidden tab only when `isPhoneLike()` (`voice-browser-deps.ts:13-25`), so a desktop tab switch keeps the conversation going and locking a phone releases the microphone. A context that goes `suspended` or `interrupted` after it ran stops voice too (`voice-client.ts:282-291`).
- **The packaged desktop app reports voice unsupported.** `browserVoiceDeps` sets `supported.webSocket` to `typeof WebSocket !== "undefined" && !isElectron()` (`voice-browser-deps.ts:52`): that app reaches the host over IPC from a `file:` page with no origin to open a socket on, so a tap shows `error.unsupported` (`voice-client.ts:101-103`).
- **Mode:** `localStorage` keeps the last choice of hands-free or push-to-talk (`apps/web/lib/voice-settings.ts:26-40`). The session POST carries the starting mode. If the choice changes before `ready`, the browser sends the latest mode before it starts sending microphone frames (`voice-client.ts:132-141,233-240`). In push-to-talk, a release flushes the final audio frame and sends one `commit`. A mode change or stop cancels the pending commit (`voice-client.ts:303-339,362-369`).

## How to test it

The host, web, and eval suites ran again on 2026-11-18 for the browser mode fix. Run each command from its package. The repo root has no Vitest config.

1. **Host voice suites** (no gateway call; `relay.test.ts` drives the relay and `attachVoiceUpgrade` on a real loopback socket, `relay.test.ts:335-336`): 13 files, 547 tests.
   ```bash
   cd packages/host
   npx vitest run src/voice
   ```
2. **The contract:** 1 file, 40 tests.
   ```bash
   cd packages/core
   npx vitest run src/voice
   ```
3. **Web voice suites:** 11 files, 300 tests.
   ```bash
   cd apps/web
   npx vitest run lib/voice-
   ```
4. **The eval's own tests**, which include `real-relay.test.ts` (the eval's cases against the real routes and relay, with scripted models and no network): 13 files, 168 tests. `--root eval/voice` is required because the host's own config only scans `src/**/*.test.ts`:
   ```bash
   cd packages/host
   npx vitest run --root eval/voice
   ```
5. **Live smoke eval** against an isolated desk. Start a desk on its own port with its own data folder (the commands are in [`packages/host/eval/voice/README.md`](../../../packages/host/eval/voice/README.md)); the runner refuses ports 3000 and 3200 on any host (`FORBIDDEN_PORTS`, `packages/host/eval/voice/args.ts:12`). The README's `3300` is only its example port.
   ```bash
   cd packages/host
   npx tsx eval/voice/run.ts --base-url http://127.0.0.1:<port>
   ```
   The runner has 14 cases (`packages/host/eval/voice/cases.ts:933-948`) and 7 synthetic WAV fixtures. See also the feature recipe [`voice.md`](../../../.cursor/skills/verify-agentforge/features/voice.md).

## Known weaknesses and open items

- **`keep_listening` is off** (`OFFER_KEEP_LISTENING`, `packages/host/src/voice/talker-prompt.ts:15`): an unfinished sentence waited in only 2 of 3 runs of the talker's live check. So the talker never holds a turn today. A pause of 700 ms or more in the middle of a sentence can end the turn (a shorter one never does), unless the person resumes before the reply is released, and the only other hold is an `ask` whose question reads unfinished (`relay.ts:503-510`).
- **`waitAfterUnfinishedMs` is dead:** it is in `TURN_TIMING` and its test but the relay does not read it.
- **On an `ask` turn the saved words of the person are the talker's rendering** of the request (the `question` it passed to `ask_nultron`), not the transcriber's words: the transcriber is not started for that turn (`relay.ts:616`).
- **HTTP per turn, not a realtime socket:** the gateway refused realtime WebSockets for this account type; HTTP speech-to-speech on `/v1/chat/completions` works, so each turn is one request with the utterance as a WAV (`talker.ts:3-5`). The host therefore runs its own detector and turn rules.
- **Audio is unmasked and partly unpriced:** raw audio and spoken answers go to the gateway without text PII masking ([SR-210](../security-register.md#sr-210)); a reply cut before the gateway's `usage` chunk records no talker row ([SR-213](../security-register.md#sr-213)); seconds rows are unpriced unless the catalog has a per-second price.
- **`web_search` and `web_fetch` are on `VOICE_READ_TOOLS`** (`ask-tools.ts:45-46`), behind the outbound guard (`ask.ts:254-260`); whether voice should reach the public web at all is an open owner decision ([SR-212](../security-register.md#sr-212)).
- **`upgrade.ts` has no test file of its own;** its guards are covered through `relay.test.ts` and `real-relay.test.ts`.
- **The fixtures are smoke only:** 7 synthetic clips (`packages/host/eval/voice/fixtures/`); the plan's 200-utterance recorded set does not exist yet.
- **Not verified:** the hosted server (server mode, the transport rules and the session in the upgrade), Safari, a phone, a real microphone with echo on speakers.

## Touches / Do not touch

### Touches

- `packages/core/src/voice/protocol.ts`, `packages/core/src/voice/protocol.test.ts` (protected: needs the lead's word)
- `packages/host/src/voice/**`
- `packages/host/src/handlers/voice.ts`
- `packages/host/eval/voice/**`
- `apps/web/components/voice/**`
- `apps/web/lib/voice-*.ts`, `apps/web/lib/voice-*.test.ts`, `apps/web/lib/voice-view.test.tsx`
- `apps/web/locales/en/voice.json`, `apps/web/locales/id/voice.json`
- Voice lines only in: `packages/host/src/handlers/settings.ts`, `packages/host/src/router.ts`, `packages/host/src/http-adapter.ts`, `packages/host/src/index.ts`, `packages/host/src/runs.ts` (`prepareChatRun`, `chatHistoryFromRows`), `packages/core/src/usage/metering.ts`, `apps/web/server.ts`, `apps/web/components/chat-session.tsx`, `apps/web/components/chat-composer.tsx`, `apps/web/components/composer-bare.css`, `apps/web/lib/i18n.ts`, `apps/web/lib/settings-read.ts`

### Do not touch

- `packages/host/src/threads.ts`: voice saves turns through `insertMessage` and `listMessages` (`packages/host/src/voice/save-turns.ts`); do not add a voice table or change thread storage.
- `packages/host/src/security-headers.ts` and `webapp-deploy/Caddyfile`: the worklet loads from `'self'` through `?worker&url` (`apps/web/lib/voice-worklet-url.ts`); do not loosen `script-src` to allow `blob:` or `data:` for it.
- `packages/host/src/gateway-gate.ts` and `packages/host/src/settings-store.ts`: voice reads the key and the gate through the existing helpers (`loadSettings`, `requireGatewayAllowedFor`) and stores or exposes no key of its own.
