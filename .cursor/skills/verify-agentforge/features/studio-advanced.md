# Studio advanced

**Parked / verified-unreachable (GTM).** Post-create soul/tools/model edit lived at `/studio/[agentId]`. That URL now redirects to Chat (nothing named Build exists there). Do not drive `save-soul` or treat missing Studio as a regression.

## Sub-features

- `studio-parked` — `/studio/<uuid>` redirects to Chat.

## How to get to it (user POV)

- You cannot. Build is hidden.

## Driving it with the Nultron harness

Preconditions:

- Doctor exits 0 and the gate is open (a stub runtime, or a saved key that resolves to the app). `/studio` is not a public path (`App.tsx:154`), so on a closed-gate desk the onboarding screen shows with the URL left at `/studio/<uuid>`, and a signed-out hosted visitor sees the sign-in screen: neither is a failed redirect.

- **Redirect.** Go to any `/studio/<uuid>`. URL becomes `/chat` (15s). `/studio` and `/studio/` match the same splat. `agent-prompt` and `save-soul` count 0 (vacuous as proof: neither testid exists in `apps/web`, so the assertion that matters is the final location). Driven 2026-10-05 on `:3000`: `/studio/0b3f6c2e-1111-4222-8333-444455556666` landed on `/chat`, both testids count 0 (evidence `studio-advanced/2026-10-05-maintain3/`).

## Gotchas

- `/studio/<uuid>` matches the same `/studio/*` rule as `/studio/new` (`apps/web/src/App.tsx:443`); there is no separate agent-id route. Assert `agent-prompt` **and** `save-soul` at count 0 — both were 0 on 2026-09-17.
- Un-park together with [build.md](./build.md) when custom agents return to the product.
- The host still routes the edits that page made: `POST /api/v1/agents/:agentId/tools` and `/soul` (`packages/host/src/router.ts:452-453`; the agents block is `:449-457`). The data path survives and the page does not, so a 200 from those routes is not evidence that Studio exists.
