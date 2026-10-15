# Usage

Usage is the desk spend and this-key wallet page at `/usage`. It is a link in the rail's pinned Account group (`rail-account-group`) next to Workspaces and Settings — not a product mode. Day / Week / Month stacked bars and spend-by-model live here; Settings keeps a compact this-key strip and Open Usage. Map: [`docs/internal/maps/shell-rail-and-workspaces.md`](../../../../docs/internal/maps/shell-rail-and-workspaces.md).

Product: both · Instance: main :3000

## Sub-features

- `usage-link` (there is no `usage-open-rail` testid) opens Usage from the left rail or from the Settings strip (`usage-panel` → `usage-open`). Collapsed rail shows the icon only. Active when the path starts with `/usage`. The page root is `usage-page`.
- `usage-intro` is the header's one outcome line (`ModeHeader` `outcomeTestId`, `apps/web/components/usage-page.tsx:140`): "What this desk and this key have spent over the selected range." (`usage.intro`, `apps/web/locales/en/usage.json:3`; Indonesian in `id/usage.json:3`). Assert the testid, not the sentence.
- `usage-range` toggles Day / Week / Month (`usage-range-day` | `usage-range-week` | `usage-range-month`). Default Day. Changing the range refetches `GET /api/v1/usage?range=…`.
- The chart (there is no `usage-chart` testid; the handle is `usage-range-chart`) shows stacked spend-by-model bars or one of **two** empty states, both on `usage-range-empty`: “No {productName} runs in this range.” when the window holds nothing (`apps/web/components/usage-range-chart.tsx:54-60`), and “Runs in this range are not priced yet.” when there are runs but no catalog price (`:61-67`). Match the testid, not either sentence — both are hardcoded English even on an `id` desk. No chart library.
- `usage-this-key` shows the this-key wallet card on `/usage` (and the slim strip inside `usage-panel` on Settings), with `usage-key-meter` under it when the gateway answered. Cloud / no key: the needs-key line. Desk card is `usage-desk-range`; by-model list is `usage-by-model` on this page only, one `usage-model-row-<model>` per row. Range toggle sits in the page header (`usage-range`). Do not treat the first-paint “Loading…” as empty spend.
- The header art column (`buddy-stage-header`, `buddy-stage-header-tap`) is in the DOM at every width but only visible when the header is 60rem or wider.

## How to get to it (user POV)

- Choose Usage on the left rail (`usage-link`; the rail is icon-only, so `aria-label` and `title` read `Usage` / `Pemakaian`, `agent-rail.tsx:75-76`; there is no `Use` label).
- From Settings, follow Open Usage (`usage-open`).
- Open `/usage` directly.

## Driving it with the Nultron harness

Preconditions:

- Doctor exits 0.
- Do **not** paste a gateway key unless the operator asked.

- **Rail.** `usage-link` is visible with Workspaces / Settings (not among `mode-*`). Click it. URL matches `/usage`. Heading Usage is visible.
- **From Settings.** On `/settings`, `usage-open` is visible. Click it. URL matches `/usage`.
- **Range.** `usage-range` is visible. Default control is Day (`usage-range-day` has `aria-pressed="true"`). Click Week / Month / Day; each click fires exactly one `GET /api/v1/usage?range=<id>` and flips `aria-pressed` (loading may flash). Equal `usage-desk-range` totals across all three is **expected**, not a stuck fetch: the frames are 14 days / 8 weeks / 6 months (`packages/core/src/gateway/account.ts:568-596`), so a desk whose runs are all recent lands every run in the newest bucket of each. Only the chart's bucket count and labels change.
- **Empty / Cloud.** With no key and no priced runs, `usage-this-key` shows the needs-key line (`usage.thisKey.needsKey`: `Paste a gateway key to see spend.` on `en`, `Tempel kunci gateway untuk melihat pemakaian.` on `id` — do not string-match the English on an `id` desk) and `usage-key-meter` has count 0: the meter only renders for `thisKey.status === "ok"` (`apps/web/components/usage-panel.tsx:95-96`). Either `usage-range-empty` or `usage-range-chart` is visible — do not require priced bars, and do not require the empty state either: a keyless desk with local priced runs still draws a chart.
- **Live (Windows, key saved, read-only).** `usage-this-key` shows `$` used (or Unlimited / error); on Settings' strip it reads `This key: $<used> used · $<left> left` (`usage.thisKey.metered`, `apps/web/locales/en/usage.json:14`). `usage-desk-range` shows desk display and model count. If this desk has runs in range, `usage-range-chart` and `usage-by-model` show spend.
- **Locale (id).** With the desk on `id` (see [locale.md](./locale.md)), this view reads `Pemakaian`, the range toggle `Hari` / `Minggu` / `Bulan`, and `Kunci ini`. Testids are locale-invariant.
- **IDE proof.** Screenshot under `evidence/usage/<run-id>/` with range toggle + chart or empty.
- **Cloud.** Same via `foundation.spec.ts` after Settings checks. Do not paste a key.

## Gotchas

- `/usage` is exempt from the hidden-mode redirect (`redirectIfHiddenMode`, `packages/core/src/agents/product-modes.ts:172-183`, the `/usage` branch at `:179`). A desk that hides every job mode still opens Usage; that is not a leak.
- The chart's empty copy, its `aria-label` and its bar tooltips are hardcoded English (`apps/web/components/usage-range-chart.tsx:54-67`, `:92`, `:152-154`) while `usage.chart.empty` / `unpriced` / `aria` / `barTitle` sit unused in both catalogs. Record it, do not work around it — see `docs/internal/unreleased.md`.
- Usage is not in `PRODUCT_MODES`. Do not hunt for `mode-usage`.
- Desk estimate and this-key wallet will not match (footer note). Chat chips `chat-usage` / `chat-context` stay on Chat.
- Settings no longer hosts `usage-by-model` or `usage-desk-range`. Assert those on `/usage` only.
- Not in the recipe: the by-model list also draws unpriced rows as `usage-model-row-<model>` with different copy ("billed after they finish"), `usage-by-model` always renders (even empty or loading, so its presence proves nothing about spend), the load-error `<p>` (`usage-page.tsx:165`) has no testid (copy `usage.errors.unavailable` on a 404, otherwise `loadStatus`, `incomplete` or `load`), on `/usage` `usage-this-key` carries no "This key:" prefix (the label is a separate panel label) while Settings' `usage-panel` strip does, `trimLeadingEmptyBuckets` keeps at least 7 day bars and 4 week or month bars (`usage-page.tsx:94-102`), and the chart's empty text is hard-coded English (`usage-range-chart.tsx:152-154`).
- **Driven 2026-10-05 on `:3000` (keyed; maintain3).** Settings `usage-panel` showed `usage-this-key` "This key: $x used · $y left" (live figures: record them, never assert them) and `usage-open`; `usage-open` went to `/usage` with `usage-page`, `usage-intro` and `h1:visible` "Usage"; `usage-link` carried `aria-current="page"`; `usage-range-day` was pressed by default and clicking week, month, day fired exactly one `GET /api/v1/usage?range=week`, `month`, `day` each; `usage-desk-range` "$x · N models", `usage-key-meter` 1, `usage-range-chart` 1, `usage-range-empty` 0, `usage-by-model` 1; at 420 px the collapsed `usage-link` had `aria-label` and `title` "Usage".
