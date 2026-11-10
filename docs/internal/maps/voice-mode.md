# Map — Voice mode

Product: both (off unless `AGENTFORGE_VOICE` is on) · Instance: none yet, no server driven

Last verified: 2026-11-10 on `voice/relay` over `f2cd9dc7`, for the contract commit only. This page is a stub the docs worker finishes. Nothing here has been driven in a browser or on `:3000`.

## Overview

Voice mode is live voice in Chat (`docs/internal/voice-mode-plan.md`, week one: Rizky only). The browser sends 24 kHz PCM frames over a WebSocket and the host answers over the same socket, speaking the shape in `packages/core/src/voice/protocol.ts`. The gateway refuses realtime WebSockets for this account, so the talker is HTTP: the host runs its own voice detection on the PCM (`packages/host/src/voice/vad.ts`), applies the turn-taking rules (`turns.ts`), sends the whole utterance to `qwen3.5-omni-flash` on streaming `POST /v1/chat/completions`, streams the reply audio back, and aborts that stream on a real interruption. Facts and tasks go through `ask_nultron` (`ask.ts`), which runs the thread's normal Chat turn. Every spoken turn is saved to the thread as text.

## Touches / Do not touch

| Path | Owner |
| --- | --- |
| `packages/core/src/voice/protocol.ts` | Contract. Closed after this commit; a change needs the lead's word. |
| `packages/host/src/voice/turns.ts`, `vad.ts`, their tests | Turn-taking lane |
| `packages/host/src/voice/ask.ts`, the read-only tool set, `ask.test.ts` | Thinker lane |
| Everything else in `packages/host/src/voice/`, `packages/host/src/handlers/voice.ts`, `packages/host/src/router.ts` (voice routes), `packages/host/src/index.ts` (voice export), `packages/host/src/tenancy-harness.test.ts` (voice rows), `packages/core/src/usage/metering.ts` (the `voice` mode), `apps/web/server.ts` (the upgrade hook) | Relay lane |
| `packages/host/src/handlers/settings.ts`, `packages/host/src/voice/flag.ts` | Contract commit, then the relay lane |
| `apps/web/components/voice/**`, `apps/web/lib/voice-*`, `apps/web/lib/i18n.ts`, `apps/web/locales/*/voice.json`, `apps/web/components/chat-session.tsx`, `apps/web/components/chat-composer.tsx` | Voice view lane |
| `packages/host/eval/voice/**` | Eval lane |
| `lanes.json`, `nix/pkgs/pnpm-deps.nix`, `pnpm-lock.yaml` | Contract commit, then the integration worker only |
| `docs/**` | Docs worker only |
