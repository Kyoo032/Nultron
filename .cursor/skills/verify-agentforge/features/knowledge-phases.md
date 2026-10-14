# Knowledge phases

Builtin-only Knowledge Base. WeKnora sidecar was stripped 2026-09-12 (binary never built). Cloud proves Phases 0–4 with Vitest plus stub webdev on `127.0.0.1:3000`. Live `[n]` cites need a gateway key — skip that step on Cloud. This file is the testing path; drive recipes live in [knowledge.md](./knowledge.md), [knowledge-ingest.md](./knowledge-ingest.md), and [knowledge-graph.md](./knowledge-graph.md). Maps: [`knowledge-flows.md`](../../../../docs/internal/maps/knowledge-flows.md) and [`knowledge-base-page.md`](../../../../docs/internal/maps/knowledge-base-page.md).

Product: both · Instance: main :3000 + HYP AI :3301

## Sub-features

- `phase-0-seam` is the backend contract + cited retrieve + `knowledge_retrievals` + PDF/DOCX ingest. Unit: `packages/host/src/knowledge/backend.contract.test.ts`, `knowledge-extract.test.ts`, `knowledge-retrievals.test.ts`. Drive: planted-fact recipe in [knowledge.md](./knowledge.md).
- `phase-1-parse` is text-layer PDF / Word → `Indexed`, scanned PDF → `pdf_no_text_layer`. Unit: `packages/core/src/pdf/index.test.ts`, host `knowledge-extract.test.ts`. Drive: the PDF/Word gotchas in [knowledge.md](./knowledge.md). No OCR.
- `phase-2-hybrid` is overlapping chunker, hybrid RRF, graph tables, the health strip (`knowledge-loop`), self-check. Unit: `knowledge-chunk.test.ts`, `knowledge-verify.test.ts`, `knowledge-graph.test.ts`, `knowledge-stub-vectors.test.ts`, `knowledge-query-model.test.ts`. Drive: the health strip and Graph in [knowledge.md](./knowledge.md).
- `phase-3-builtin-only` is the sidecar removal. `GET /api/v1/knowledge` reports `backend.id = "builtin"`. `PUT /api/v1/knowledge/backend` `{id:"weknora"}` is **400** `WeKnora sidecar is not part of this product`. Unit: `knowledge-backend-routes.test.ts`. There is no backend card, no `:3100` sidecar instance, no `AGENTFORGE_WEKNORA_BIN`, no `features/knowledge-backend.md`.
- `phase-4-graph` is `cites` edges after a reply with `[n]`, one-hop `covers` expand (off in Chat), reindex, PDF `worker_threads`. Unit: `knowledge-cites.test.ts`, `knowledge-expand.test.ts`, `knowledge-reindex.test.ts`, `knowledge-graph.test.ts`, `packages/core/src/pdf/worker.test.ts`, `fallback.test.ts`. Drive: [knowledge-graph.md](./knowledge-graph.md). A stub Chat cites only for the desk phrase ("what does the desk say about ...", see [knowledge-graph.md](./knowledge-graph.md)): its reply is "From the desk [1] [99].", the host drops `[99]`, and a real `cites` edge follows; the proof is `src/chat-harness.test.ts` (`:27-58`), add it to the host unit list. A real model citing is key-only.
- `ingest-loop` predates these phases (0.14.23). Every finished Chat/job writes a work card. Drive: [knowledge-ingest.md](./knowledge-ingest.md).

## How to get to it (user POV)

- Cloud: this repo after clone. Stub runtime. No sidecar to start.
- Webdev: `pnpm dev` → `http://127.0.0.1:3000/knowledge` (`mode-knowledge`). Doctor with no args; skip the Knowledge drive if `knowledge` is false.
- Packaged desktop is Windows-only proof (`doctor --desktop`). Cloud cannot pack or drive the installed app.

## Driving it with the Nultron harness

Preconditions:

- Doctor exits 0. Cloud stays `AGENTFORGE_RUNTIME=stub`. Do not paste a gateway key.
- Never start a second process on `:3000`. Never treat `:3000` as the packaged app.
- Do not look for WeKnora, `resources/weknora/`, or a backend Switch.

**Cloud unit (required).** From repo root, after `install`:

```bash
cd packages/host
npx vitest run src/knowledge.test.ts \
  src/knowledge/backend.contract.test.ts \
  src/knowledge-backend-routes.test.ts \
  src/knowledge-extract.test.ts \
  src/knowledge-retrievals.test.ts \
  src/knowledge-chunk.test.ts \
  src/knowledge-verify.test.ts \
  src/knowledge-graph.test.ts \
  src/knowledge-cites.test.ts \
  src/knowledge-expand.test.ts \
  src/knowledge-reindex.test.ts \
  src/knowledge-stub-vectors.test.ts \
  src/knowledge-query-model.test.ts

cd packages/core
npx vitest run src/pdf
```

Pass: those files green. A leftover `weknora` id in settings is ignored; the routes file asserts PUT `weknora` → 400.

**Cloud UI (stub, required for phases 0–2 + ingest).** Follow [knowledge.md](./knowledge.md) planted-fact + loop/graph, then [knowledge-ingest.md](./knowledge-ingest.md) baseline. Stub Chat injects chunks (click `chat-context`, whose closed chip reads only "Context: N of W"; `chat-context-breakdown` → Sources `≥ 1 chunks`) but the planted question gets no `[n]`, so Phase 4 `cites` stays 0 for it — that is a pass, not a skip. The desk-phrase question below is the free stub cite. Expand stays off: no chunk labelled `via graph`.

**Cloud UI (Phase 4 cites).** Stop after the stub steps. Do not spend a key. Record: the baseline `data-edges` read after that thread's first send (a retrieving stub send already adds a `retrieved` edge, `knowledge-graph.ts:210`, and `data-edges` on `knowledge-graph-counts` counts every kind), and no `cites` title for the planted question; for the desk phrase "what does the desk say about zorblatt7731" expect "From the desk [1]." and a `cites · weight 1` title (read the SVG `title` texts, see the hover trap in [knowledge-graph.md](./knowledge-graph.md)). A real model citing is Windows-only when the operator asked (`runtime: "ai"`).

**Doctor fields (webdev).** `knowledge: true`, `knowledgeRetrievals` after a completed Chat retrieve, `knowledgeGraph` after a map run or after any retrieving stub Chat (a `retrieved` edge needs no Map), `knowledgeBackend` is `{id: "builtin", selected: "builtin", available: true, health: true, outbox: 0}` (`doctor.mjs:338-348`), and `knowledgeVerified` is also reported. Missing graph fields mean an old host.

## Gotchas

- This path is the source of truth for Cloud. `docs/internal/weknora-kb-plan.md` is the old evaluation; Phase 3 sidecar code is gone (the type id `weknora` in `knowledge/backend.ts:62`, `KNOWLEDGE_BACKEND_IDS` in `core/src/secrets.ts:63`, its secret fields and migration `0013` remain as dead code; `apps/web` has none). Do not revive the sidecar, the lite workflow, or `stage-weknora.mjs`.
- `:3100` was an isolated Windows desk used while building. Cloud has no `:3100`. Use `:3000` after doctor.
- `knowledge.graphExpand` has no Settings key. Chat does not pass `expand: true`. Unit tests cover the ON path; product stays off.
- Playwright `foundation.spec.ts` is Chat/Settings/job-mode smoke. It does not replace the Knowledge phase files above.
- Packaged proof (`host.cjs` + renderer, `doctor --desktop`) is owed on Windows before the Personal app ships. Cloud must not run `pnpm desktop:build`.
- Not in the recipe: `POST /api/v1/knowledge/reindex`, `/sources/:id/reindex` and `/backend/reindex` exist, are gated and have no UI control (unit proof only); the live `knowledge_search` tool retrieves without writing retrievals, cites or expand (`knowledge-search-tool.ts:83-100`), so `knowledgeRetrievals` does not move on it; `knowledge-backend-routes.test.ts` asserts only the 400 status and code, the message text is at `backend-api.ts:39`, `:49`; in the narrow layout `chat-context-breakdown` is an inline group inside the header "Chat details" menu with the same testid, and the chip needs a reply and an open gate (a 403 leaves only the Conversation row, `chat-session.tsx:393-421`).
- **Driven 2026-10-05 (maintain3), isolated stub instance:** `GET /api/v1/knowledge` backend `{id: "builtin", selected: "builtin", available: true, reason: null, health: {ok: true}, outbox: 0}`; `PUT /api/v1/knowledge/backend` with `weknora` -> 400 `invalid_request` "WeKnora sidecar is not part of this product"; one retrieving stub send raised `knowledgeRetrievals` to 1 and the graph by one `retrieved` edge; the desk-phrase question wrote the `cites` edge (the walk is in knowledge-graph.md). The unit commands and the PDF worker were not re-run this pass.
- **Driven 2026-10-09 on a throwaway stub instance.** `PUT /api/v1/knowledge/backend` with `{"id":"weknora"}` answered 400 `invalid_request` "WeKnora sidecar is not part of this product". Evidence: `drive5.json` (`knowledge_phases_put`).
