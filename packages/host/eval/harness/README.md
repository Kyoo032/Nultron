# Harness smoke lever (dev only, never ships)

One command that drives **Chat, Data, Documents, Presentation and Research** once each on the owner's
running webdev, through the public HTTP API, and records for every case whether it completed, which
tools it called, what the API reported as failed, and how long it took. It is the "did the mode harness
change break anything" check for [`docs/internal/mode-harness-tools-plan.md`](../../../../docs/internal/mode-harness-tools-plan.md):
`results/baseline.json` is the tree before H1, and H1 and H5 run it again and compare.

It sits beside `eval/finance` and `eval/models`, outside `packages/host/src`, so the host's tsconfig and
vitest config never see it and no build bundles it. Loopback only: `--base` must be `127.0.0.1`,
`localhost` or `::1`, and the check runs on every request. Inputs are synthetic (`fixtures.ts`): a bakery
that does not exist and a 20-row sales table. `results/` is gitignored (`.gitignore` in this folder).

**It spends money.** The webdev on `:3000` holds a real, billed gateway key and every case makes at
least one model call. Chat and Documents and Presentation make one each (Chat-tool two or three, the
tool round-trip), Data a handful of SQL steps, and Research a planning call, one extraction call per page
it reads (up to 10) and a synthesis call, plus up to 5 web searches. Research cannot be limited from the
API: the request takes only `prompt` and `model`, and the caps are constants in
`packages/host/src/research-dossier.ts` (`RESEARCH_CAPS`). The question is narrow on purpose, and the row
records the count (`detail.modelCallsEstimate`, `detail.searches`, `detail.sourcesRead`). Use `--skip
research` for a cheaper pass.

## Run it

The app must already be running; the harness never starts, stops or restarts a server. It checks
`GET /api/v1/workspaces` (must be 200), runs the verify skill's `doctor.mjs` and refuses to go on if the
doctor does not pass, then runs the cases in a fixed order.

```bash
cd packages/host
npx tsx eval/harness/run.ts                      # all six cases, results/<run-id>.json
npx tsx eval/harness/run.ts --name baseline      # results/baseline.json (the H0 file)
npx tsx eval/harness/run.ts --case data,chat-tool
npx tsx eval/harness/run.ts --skip research
npx tsx eval/harness/run.ts --compare eval/harness/results/baseline.json
npx tsx eval/harness/run.ts --list
```

Flags are in `--help`. A run writes `results/<name>.json` and a copy of it, plus the doctor's JSON, to
`.cursor/skills/verify-agentforge/evidence/harness/<run-id>/` (gitignored). The exit code is `0` when
every selected case completed and met its expectations, `1` when some did not, `2` when the run could
not start (host down, doctor failed, bad flag).

Unit tests (pure parts and every case against a scripted fake host; no network, a stray real `fetch`
throws):

```bash
cd packages/host && npx vitest run --root eval/harness
```

The package's own config only includes `src/**/*.test.ts`, so `vitest run eval/harness` from the package
root finds nothing; the `--root` form above uses this folder's `vitest.config.ts`.

## What a row holds

| field | meaning |
| --- | --- |
| `id`, `mode` | the case and the product mode it drives |
| `completed` | Chat: `run.completed` arrived, no `run.failed`, and the assistant message is on the thread afterwards. Data and Research: `job.done` arrived, no `job.error`. Documents and Presentation: the route answered 2xx. A broken or timed-out stream is never completed. |
| `error` | the host's message (`HTTP 403 gateway_blocked: ...`, a `run.failed` or `job.error` text) or this side's (`timed out after N ms`) |
| `model` | the model that answered, from the run's usage (Chat) or the saved artifact's `meta.model`. `null` for Data today: the Data job passes `queries: <number>` in the artifact meta and the meta schema wants an array of strings, so the whole meta is dropped on save (`data-generate.ts` `persistAnalysis` call, `artifact-meta.ts` `artifactMetaSchema`). A product bug, not a harness gap. |
| `modelSteps` | always `null` today: the loop caps a run at six steps (`ai-sdk-runtime.ts`, `maxSteps: 6`) and no event reports how many it used. A step count is H1's to add, and the key is here so rows stay comparable. Where a count of model calls can be derived from observed events it is in `detail` (`modelCallsEstimate`). |
| `toolCalls`, `toolCallSource` | tool keys in order. Chat: the `tool.started` events. Data and Research: **inferred from `job.step` events**, because a job's tool calls never reach the stream: each step in Data's `analyzing` phase is a `run_sql`, each in Research's `searching` phase a `web_search`. A `calculator` call the Data model makes is invisible. |
| `checkFailures` | failures the API itself reports. Only Data reports any today: a finding whose evidence query failed (`(Evidence query failed: ...)`) and each failed `run_sql` step. Empty means "none reported", not "checked and clean": Documents, Presentation, Research and Chat have no checks yet, which is what H5 adds. |
| `expectFailures` | what the case expected and did not get (for example `the calculator tool was called`). These are the harness's own assertions, kept apart from the API's checks. |
| `artifactId` | the artifact the run saved. Documents and Presentation answer with the draft only, so it is found by listing the mode's artifacts for one that is new and whose `meta.question` is this case's prompt. |
| `wallMs` | wall time of the case |
| `detail` | counts: events, text length, contact attempts, tokens, sections, slides, sources |

## What a run leaves behind, and cleanup

A run creates threads (Chat), a dataset (Data) and artifacts (Data, Documents, Presentation, Research);
deleting an artifact also drops its Knowledge work card. At the end the harness deletes them through
the API, asks for each id again and records in the result file's `cleanup` block what it removed and
whether every id now answers 404. It also sweeps for an artifact a timed-out request saved late (a new
artifact whose recorded question is one this run asked). `--no-cleanup` keeps everything. Ctrl-C runs the
same cleanup once. Usage rows have no delete route and stay: they are the cost of the run.

## Cases

| id | mode | what it does | expects |
| --- | --- | --- | --- |
| `chat-plain` | chat | new thread on the desk's Chat agent, "Reply with the word ready." | the reply says ready |
| `chat-tool` | chat | "Use the calculator: what is 17.5% of 2340?" | a `calculator` tool call, and 409.5 in the reply |
| `data` | data | uploads `harness-sales.csv` (20 rows), asks which region sold the most units | `run_sql` called, the analysis names East and 610, an artifact was saved |
| `documents` | documents | three-section briefing from a five-sentence source | a title, at least two sections, the 40-guest figure, an artifact |
| `presentation` | presentations | a 3-slide outline from a two-sentence brief | a title, exactly three slides, a heading on each, an artifact |
| `research` | research | one narrow question (the default PostgreSQL port) | `web_search` ran, a source was read, the dossier says 5432, an artifact |

Chat posts the model the desk reports as its default (`GET /api/v1/chat`, `defaultModel`) as the
composer does. The job cases send no model and take the mode default, as a studio does when nothing was
picked.
