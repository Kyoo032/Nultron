# Live voice in Chat

Talk to the desk in a Chat thread and hear the answer, with every turn saved to the thread as text. Voice is off unless the host is told otherwise (`packages/host/src/voice/flag.ts:31-33`), and on the hosted server it is limited to the user ids in `AGENTFORGE_VOICE_OWNERS` (`packages/host/src/voice/flag.ts:34`). The talker is `qwen3.5-omni-flash` with the voice `Tina` (`flag.ts:16-17`); the gateway refuses a voice called Cherry. The first live run (2026-11-10 to 11, real gateway, Chromium with a fake microphone) is recorded in [`docs/internal/voice-mode-plan.md`](../../../../docs/internal/voice-mode-plan.md) under "First live run". Map: [`voice-mode.md`](../../../../docs/internal/maps/voice-mode.md).

Product: both · Instance: an isolated desk on its own port (never `:3000` or `:3200`)

## Sub-features

- `voice-mic` is `composer-mic` in the composer row, between the message box and Send. It is not rendered at all unless `GET /api/v1/settings` says `voice.enabled` (`apps/web/lib/voice-settings.ts:11-21`, `apps/web/components/voice/voice-mic-button.tsx:31-33,47`), the composer draws it at `apps/web/components/chat-composer.tsx:739`, and Chat passes `available` at `apps/web/components/chat-session.tsx:640`. There is no disclosure or consent dialog: the mic is the only way in.
- `voice-sheet` is `voice-view`, `role="dialog"`, with `data-phase` (`closed | opening | live | ended`) and `data-state` (`connecting | listening | hearing | thinking | speaking`), plus `data-mode` (`apps/web/components/voice/voice-view.tsx:93-96`, `apps/web/lib/voice-view-state.ts:50-74`). The state word is `voice-state` (`voice-view.tsx:130`) and the same change is announced in `voice-live`.
- `voice-states` move on the host's `state` frames: `ready` then `listening` (`packages/host/src/voice/relay.ts:184-190`), `thinking` when the reply is released (`relay.ts:530`), `speaking` on the first outgoing audio (`relay.ts:682`).
- `voice-captions` is the `voice-captions` log, one row per utterance with `voice-caption-user` or `voice-caption-assistant`; a reply the person cut carries `.voice-caption-cut` (`apps/web/components/voice/voice-captions.tsx:50,64,70`). With nothing said yet and the session live, `voice-captions-empty` shows.
- `voice-mode-hands-free` and `voice-mode-push-to-talk` switch turn-taking (`voice-view.tsx:183,192`). Push-to-talk shows `voice-hold`, which works by pointer and by Space or Enter held on the button (`apps/web/components/voice/voice-hold-button.tsx:47,56-67`); releasing flushes the final audio frame and sends one `{ type: "commit" }`. A mode change or stop cancels a pending commit (`apps/web/lib/voice-client.ts:303-339,362-371`). The host ends a hands-free turn itself (`packages/host/src/voice/turns.ts:21-42`).
- `voice-barge` is a cut-in. The browser's own detector needs 120 ms of speech above about `-38 dBFS` (`apps/web/lib/voice-barge-detector.ts:13-25`), pauses playback and sends `barge_in` (`apps/web/lib/voice-barge.ts:97-116`). The host interrupts once 700 ms of speech has been heard over the reply (`packages/host/src/voice/turns.ts:35-39`, `relay.ts:807-817`): it sends `stop_audio`, aborts the reply and captions what was actually heard (`relay.ts:847-882`). A short backchannel instead gets `resume_audio` (`relay.ts:837`).
- `voice-card` is a `{ type: "card" }` frame for a write or paid step (`packages/core/src/voice/protocol.ts:83`, `relay.ts:606`). `voice-card-run` ends voice and sends the card's prompt as a normal Chat turn, so the text path's own approval applies (`apps/web/components/voice/use-voice-session.ts:149-160`, wired at `apps/web/components/chat-session.tsx:618`). The card has no dismiss button; `voice-end` and `voice-close` end the session.
- `voice-saved` is a fixed note, not a counter (`voice-view.tsx:207-209`). After a finished turn the host sends `saved` (`relay.ts:733`) and the hook reloads the thread (`use-voice-session.ts:164-173`). Turns are stored as two text rows, user then assistant, through the same insert a typed turn uses (`packages/host/src/voice/save-turns.ts:38-53`).
- `voice-end` is `voice-end` (`voice-view.tsx:201`), `voice-close` (`:108`) or Escape (`use-voice-session.ts:196-208`), which calls `POST /api/v1/voice/sessions/:id/end` (`packages/host/src/handlers/voice.ts:116`). A session nobody connects to within 30 s is dropped (`packages/core/src/voice/protocol.ts:29-30`), and a new session for the same person ends the open one with `replaced`.

## How to get to it (user POV)

- Save the desk's gateway key in that desk's Settings. A desk on the stub runtime has no live voice (`packages/host/src/voice/wiring.ts:45-55`).
- Open a Chat thread. The mic sits beside the message box.
- Tap the mic and speak. The sheet shows the state word, the captions as they are revised, and the reply's audio.
- Speak over the reply to cut in (hands-free), or hold `voice-hold` (push-to-talk).
- When the agent asks for a go-ahead, `voice-card` appears; `voice-card-run` starts the work as a text turn.
- Tap `voice-end`, `voice-close`, or press Escape, then check the thread holds the exchange as text.

## Driving it with the Nultron harness

Preconditions:

- A free port such as `3300`, a fresh data folder in `AGENTFORGE_DATA_DIR`, and never `:3000` or `:3200`: `FORBIDDEN_PORTS` refuses both with no override (`packages/host/eval/voice/args.ts:11-12`).
- Start the desk, then save its gateway key in that desk's Settings page; the key is never put on a command line.

```bash
cd apps/web
PORT=3300 AGENTFORGE_DATA_DIR="$(mktemp -d)" AGENTFORGE_RUNTIME=ai AGENTFORGE_VOICE=on npx tsx server.ts
```

- Doctor it: `node .cursor/skills/verify-agentforge/scripts/doctor.mjs --base http://127.0.0.1:3300`.
- **By hand.** Drive the journey above with a real microphone, and keep the screen recording: the state words, a cut reply's cut caption, the card, and the thread after a reload.
- **Fake microphone.** Chromium can play a fixture into `getUserMedia`:

```text
--use-fake-ui-for-media-stream
--use-fake-device-for-media-stream
--use-file-for-fake-audio-capture=<absolute path>/packages/host/eval/voice/fixtures/smalltalk.wav
```

  The seven fixtures are 24 kHz 16-bit mono WAV: `smalltalk`, `fact`, `task`, `unfinished`, `backchannel`, `stop`, `long` (`packages/host/eval/voice/fixtures/`).
- **The runner.** Fourteen cases over the real voice routes; `--repeat` (default 5) applies to the latency cases and `barge-in-stops` (`packages/host/eval/voice/README.md:74-89`). Run it from `packages/host`:

```bash
cd packages/host
npx tsx eval/voice/run.ts --base-url http://127.0.0.1:3300
npx tsx eval/voice/run.ts --base-url http://127.0.0.1:3300 --list
```

  The table's columns are `case`, `status`, `runs`, `numbers` (`packages/host/eval/voice/report.ts:126-127`). Statuses are `PASS`, `FAIL`, `SKIPPED_UNAVAILABLE`, `BLOCKED_NO_RUNTIME`, `ERROR_TRANSIENT`, `ERROR` (`packages/host/eval/voice/report.ts:4-5`); a skipped case is never a pass.
- **Turn-mode check.** Start in push-to-talk. Delay the voice WebSocket until after the session POST, then pick **Hands-free** while the view still says **Connecting**. Let the socket connect and speak without holding a button. The host should answer after you stop speaking. Repeat in the other direction: the host should wait for you to hold and release the button. `apps/web/lib/voice-client.test.ts:513-530` checks that the selected mode reaches the host before the first audio frame.
- **The runner's own tests.** `cd packages/host && npx vitest run --root eval/voice` (the package config does not include this folder).
- **Evidence.** Screenshots of the mic in the composer, each state, a cut reply's caption, a card, and the thread after a reload, under `evidence/voice/<run-id>/`.

## Gotchas

- **Off unless told.** `AGENTFORGE_VOICE` must be `on`, `1` or `true` (the `ON` set at `packages/host/src/voice/flag.ts:23`); anything else, including blank or a typo, is off (`packages/host/src/voice/flag.ts:31-33`). Off, the mic has count 0.
- **Hosted needs the user id.** In server mode the person's user id must also be in `AGENTFORGE_VOICE_OWNERS`; it holds user ids only, no e-mails, and unset means nobody (`flag.ts:40-46`). A non-owner gets no mic and H1 answers `403 voice_disabled` (`packages/host/src/handlers/voice.ts:63-67`).
- **One session per person.** A second `POST /api/v1/voice/sessions` for the same owner replaces the open one, and the first socket is told `ended: replaced` (`packages/host/src/voice/sessions.ts:97-106`). `429 voice_session_limit` is the whole process's cap of 8 open sessions (`packages/core/src/voice/protocol.ts:31-34`, `handlers/voice.ts:73-75`).
- **A desk with no key has no voice.** H1 answers `503 voice_model_unavailable` (`handlers/voice.ts:76-79`), even with the flag on.
- **`keep_listening` ships off.** `OFFER_KEEP_LISTENING.on` is `false` (`packages/host/src/voice/talker-prompt.ts:15`; the tool's name at `packages/host/src/voice/talker-prompt.ts:9`), so an unfinished sentence is judged by the relay's own word rules, not by a second talker tool.
- **`voice-saved` proves nothing by itself.** It is a fixed note; the proof is the thread after a reload.
- **Tester branch only.** Voice is not on `main` and not deployed (2026-11-11).
- **The voice sheet is not a modal.** It takes focus when it opens and Escape ends it (`apps/web/components/voice/voice-view.tsx:80-83`), but the thread stays behind it.
