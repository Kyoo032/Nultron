# Voice eval (dev only, never ships)

A runner that plays recorded speech into a running desk over the real voice protocol, as a browser would,
and reports three things with numbers: how fast the answer started, whether the turn-taking was right, and
whether the turns were saved. It is the "does live voice do what the plan says" check for
[`docs/internal/voice-mode-plan.md`](../../../../docs/internal/voice-mode-plan.md), section "Expected outcome
and acceptance tests".

It sits beside `eval/harness` and `eval/finance`, outside `packages/host/src`, so the host's tsconfig and
vitest config never see it and no build bundles it. It speaks only the contract in
`packages/core/src/voice/protocol.ts`; it shares no code with the relay.

**This is a smoke set, not the acceptance set.** The plan's 200-utterance recorded test set (about an hour of
speech, made with consent, never a customer's voice) does not exist yet. The seven clips in `fixtures/` are
synthetic, spoken by the gateway's own speech model, and cover one utterance of each kind. They prove the
runner and the turn rules work and give first latency numbers. They do not prove the plan's rows: the routing
accuracy (90% of 100 labelled utterances), the 40 pause-mid-sentence clips, the 30 interruptions and 30
backchannels all need the recorded set. Report numbers from this runner as "smoke", never as "acceptance".

## What it measures

- **Latency.** From the *real* end of speech (found with the host's own `createVad` on the clip, not the end of
  the file) to the first agent audio frame, as the client saw it, next to the host's own `metrics` number
  (`speechEndToFirstAudioMs`). The client number is measured from when the host really got the frame that
  holds the last sound, so it includes the up to 40 ms a browser waits to fill a frame. Pass: 1.5 s at p50 and
  2.5 s at p90 over `--repeat` runs (default 5). A percentile is the nearest rank, so with five runs p90 is the
  slowest run.
- **Turn-taking.** A sentence that stops on "yang" gets no answer; a pause mid-sentence gets one reply after the
  second part; speech over the reply for 700 ms stops it within 300 ms of that line; a short "iya" does not.
- **Saving.** `saved` arrives, and the thread holds the person's words and the agent's words, in order, as text.
  A cut reply is saved as only the words that were heard.

The microphone stream is paced in real time (40 ms frames, silence included, as a browser in hands-free sends
them) and each frame's real send time is recorded. A latency run whose stream fell more than 150 ms behind real
time fails its own check, because a stream that bursts makes the host's silence timer run short and flatters it.

## Start an isolated desk

The runner never starts or stops a desk and refuses ports 3000 and 3200 on any host, with no override: those
are Rizky's own desks (webdev and the tester). Start a second desk on another port with its own data folder.
`PORT` is the supported way (`apps/web/server.ts`, the comment above `const port`); `AGENTFORGE_DATA_DIR` keeps
it off the operator's data.

```bash
cd apps/web
PORT=3300 \
AGENTFORGE_DATA_DIR="$(mktemp -d)" \
AGENTFORGE_RUNTIME=ai \
AGENTFORGE_VOICE=on \
OPENAI_API_KEY=<the gateway key> \
npx tsx server.ts
```

- `AGENTFORGE_VOICE=on` turns voice on (`packages/host/src/voice/flag.ts`). Off server mode the flag alone is
  enough. In server mode the signed-in user must also be in `AGENTFORGE_VOICE_OWNERS`, and the runner needs that
  user's session: pass its `Cookie` header value in the environment variable `AGENTFORGE_VOICE_EVAL_COOKIE`. The
  runner sends it, never prints it and never writes it to a file.
- The desk needs a live gateway key (`AGENTFORGE_RUNTIME=ai`; saved in its Settings or as `OPENAI_API_KEY` in
  the environment of that desk process). The runner itself never reads, sends or stores a key. A desk with no
  key reports `runtime: "stub"`: the cases that need the thinker are then skipped with that reason, and the
  rest are blocked when H1 answers `gateway_blocked`.
- The runner needs `GET /api/v1/settings` to say `voice.enabled: true`, and stops with a clear message if not.

## Run it

```bash
cd packages/host
npx tsx eval/voice/run.ts --base-url http://127.0.0.1:3300
npx tsx eval/voice/run.ts --base-url http://127.0.0.1:3300 --case latency-smalltalk --case barge-in-stops --repeat 10
npx tsx eval/voice/run.ts --base-url http://127.0.0.1:3300 --compare eval/voice/results/<earlier-run>.json
npx tsx eval/voice/run.ts --list
```

| Flag | Meaning |
| --- | --- |
| `--base-url <url>` | The desk to drive. Required. |
| `--case <name>` | Run only this case. Repeat the flag, or comma-separate, for more. Default: all fourteen. |
| `--repeat <n>` | Runs of each latency case and of `barge-in-stops` (default 5). The other cases run once. |
| `--out <file>` | Where the JSON result goes (default `eval/voice/results/<run-id>.json`, gitignored). |
| `--compare <file>` | After the run, list what differs from an earlier result: status and the p50 and p90 of every number. |
| `--locale id\|en` | Sent as `Accept-Language` and checked against the desk's own language (a note is printed if they differ). The fixtures are Indonesian either way. |
| `--show-text` | Print captions and saved text. Without it only their length and a short hash are shown. |
| `--no-cleanup` | Keep the threads the run created (by default each is deleted). |

A run prints one table (case, status, runs passed over runs, numbers with run count and spread), then each
unhappy case's reason, and writes the JSON result. Exit code: `0` no case failed (skipped cases do not fail a
run, and are never counted as passed), `1` a case failed, errored or was blocked, `2` the run could not start.
Statuses are the words of `eval/finance/runner/verdict.mjs`: `PASS`, `FAIL`, `SKIPPED_UNAVAILABLE`,
`BLOCKED_NO_RUNTIME`, `ERROR_TRANSIENT`, `ERROR`.

The runner never prints or stores a key, a cookie, audio or a full transcript. A caption is reported as its
length and the first 8 hex digits of its hash (`41 chars #a1b2c3d4`), so two runs can be compared without the
words being anywhere.

## The cases

Each opens a session (H1, then the socket, H2) on a fresh thread, streams the clip(s) with silence around them,
and ends the session (H3). A case that cannot run says so and is never a pass.

| Case | What it proves |
| --- | --- |
| `latency-smalltalk`, `latency-fact`, `latency-long` | First audio within 1.5 s at p50 and 2.5 s at p90 of the real end of speech, client and host numbers side by side. The agent must also have waited for the person to finish. For a fact the first audio is the acknowledgement. |
| `fact-routes-to-desk` | `fact.wav` gives `state: thinking`, an acknowledgement, then an answer, and the person's caption carries the question. |
| `task-becomes-card` | `task.wav` gives a `card` whose `prompt` is the request, and no write happened: the thread holds only the spoken turn, as text. |
| `unfinished-waits` | `unfinished.wav` ("Saya mau pesan yang") then silence gets no agent audio for 2 s after the end of speech. |
| `pause-mid-sentence` | `unfinished.wav`, about 500 ms of silence, then `fact.wav` gets exactly one reply, after the second part. |
| `barge-in-stops` | Over the reply to `smalltalk.wav`, `stop.wav` with `barge_in` gets `stop_audio` within 300 ms of the 700 ms line (the real number is reported), the cut reply's final caption is `interrupted`, the saved assistant text is shorter than the full reply, and the next turn answers `stop.wav`'s words. |
| `backchannel-resumes` | Over a reply, `backchannel.wav` with `barge_in` gets `resume_audio`, no `stop_audio`, and the reply is saved whole. |
| `push-to-talk` | In `push_to_talk` a clip and a long silence get no reply; `commit` gets it. |
| `turns-saved` | After an answered turn `saved` arrives and the thread holds the person's words then the agent's, as text. |
| `second-session-replaces` | A second H1 for the same person gives the first socket `ended: replaced`. |
| `upgrade-needs-origin` | The socket handshake with no `Origin`, and with a foreign one, is refused before any frame. A control then opens the same session with the right `Origin`, so the refusals were about the `Origin`. |
| `end-is-idempotent` | H3 twice answers 200 both times. |

`barge-in-stops` and `backchannel-resumes` need a reply still playing when the person cuts in. If the reply was
over first the case is `SKIPPED_UNAVAILABLE` with the reply length, not a pass and not a failure.

## What the client assumes

The client is a stand-in for the browser, so where the contract is silent it does what a browser does. Each of
these is a place a live run can differ from the contract; the first thing to check when a case fails live is
whether it is one of them.

- Every request, reads included, carries `Origin` equal to the base URL. The cookies the host sets are kept and
  sent back, on the socket handshake too. A mutating call carries `x-agentforge-csrf` (the value of the
  `agentforge_csrf` cookie, after one `GET /api/v1/ping` primes it) and `x-agentforge-transport: web`.
- The socket is opened with per-message compression off, so zlib's thread pool adds no jitter to the latency being
  measured (a browser may negotiate it; PCM frames are small either way).
- The microphone sends silence frames the whole time, from the `ready` frame on, and starts a clip on a 40 ms
  boundary.
- On `barge_in` the browser pauses its playback at once and sends `played` with the ms it had played. On
  `stop_audio` it drops the queue and sends `played` again. On `resume_audio` it resumes. The browser sends
  `barge_in` 120 ms after the speech over the agent begins.
- The first assistant caption ids are the acknowledgement and the answer. A fact turn counts as acknowledged
  when it has two final assistant captions, or a gap of 600 ms or more between bursts of audio.
- A cut reply's `caption` frames show its full text at some point (a partial caption), so "shorter than the full
  reply" can be checked against the longest text seen for that caption id.
- `metrics` arrives once per answered turn, within 40 s of the turn; the person's caption within 15 s.
- The thread route `GET /api/v1/threads/:id` returns `{ messages: [{ role, content: [{ type: "text", text }] }] }`.

## Tests of the runner itself

Nothing here reaches a desk or a gateway. The tests start a fake host (`fake-host.ts`) on a loopback port: a small
`http` plus `ws` server that takes turns on the audio the client streams, with one switch for each wrong
behaviour a case must catch. Every case passes on the correct fake and fails on its wrong one. The tests also
cover the pacing, the end-of-speech finder on every fixture, the latency math, the percentiles, the port refusal
and that output hides text by default. A stray `fetch` to anywhere but loopback throws (`test-setup.ts`).

```bash
cd packages/host
npx vitest run --root eval/voice      # the eval's own tests
npx tsc --noEmit -p eval/voice/tsconfig.json
```

The package's own vitest config only includes `src/**/*.test.ts`, so `vitest run eval/voice` from the package
root finds nothing; the `--root` form above uses this folder's `vitest.config.ts`. The tests run whole turns at
four times real speed on a shared scaled clock, so a few of them take several seconds.

## Files

`run.ts` is the entry point. `args.ts` parses flags and holds the port refusal. `cases.ts` is the case table.
`runner.ts` runs it. `client.ts` is the browser stand-in (HTTP, socket, timeline). `mic.ts` is the paced stream.
`playback.ts` is what the person would have heard. `audio.ts` reads the fixtures and finds speech marks.
`stats.ts` is percentiles. `text.ts` hides words. `report.ts` is the table, the result file and `--compare`.
`results/` is gitignored.
