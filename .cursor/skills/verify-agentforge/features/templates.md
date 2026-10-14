# Templates

Example galleries on Images, Videos, Documents, Research, and Presentation load a full brief into the mode composer. Clicking a card does not generate. Map: [`docs/internal/maps/documents.md`](../../../../docs/internal/maps/documents.md).

Product: both · Instance: main :3000 + HYP AI :3301

## Sub-features

- `example-gallery` is the “Start from a template” region on each job-mode studio.
- `example-card` is one clickable template (10 on Images, 6 on the other modes). On `/presentations` the gallery is `example-gallery` with **six** `example-card`s whose `data-example-id`s read `presentations-<slug>` (`apps/web/components/example-gallery.tsx:29-30`), backed by `packages/core/src/templates/library.ts:504-673` and localized through `presentation.templates.*`; `packages/core/src/templates/library.test.ts:18` pins that count at 6.
- `example-result` shows that card’s `resultSummary` after selection.
- `example-prefills-prompt` clicking a card fills the mode prompt with that card's full brief: `images-studio-prompt`, `videos-studio-prompt`, `documents-prompt`, `research-prompt`, or `presentations-prompt`. `images-studio-prompt`, `videos-studio-prompt`, `documents-prompt` and `research-prompt` are single-line `<input type="text">`, so the library's line breaks are stripped; `presentations-prompt` is a `<textarea>` (`topicField`, `apps/web/components/presentations-studio.tsx:427-438`) and keeps them. Assert length (the unit tests pin more than 240 characters for every card (`library.test.ts:48` runs over all 34 entries) and more than 500 only for documents, research and presentations (`:56`); the "400 to 1600" this line used to say is not a rule, and "Fog path cover" at about 320 and the videos "Night rain hold" at about 300 are under 400; the first card of each mode measured 2026-10-01: images 639, videos 420, documents 1317, research 922, presentations 1430, and other cards differ) or a distinctive substring, never paragraph count: assert the text is present, not that it kept its paragraphs.

## How to get to it (user POV)

- Open a job mode on Default (Images first: rail `agent-images` or `/images`). A Legal desk may hide some of these tabs.
- The gallery sits above the prompt bar under “Start from a template”.
- Click a card. A full brief fills the prompt; replace the sample details, then generate if you want.

## Driving it with the Nultron harness

Preconditions:

- Doctor exits 0.
- `agent-images` (or the target mode tab) is visible on this workspace. An older Default has every work mode, and a fresh Personal desk has Research, Images, Videos and Presentation only. If the tab is missing, you are on a desk that hid it — hire the agent in Virtual agents (`agent-hire`).

- **Open Images.** Click `agent-images`, then `agent-open-studio` (or go to `/images`). `images-studio` is visible. `example-gallery` is visible.
- **Gallery.** Images: 10 `example-card` entries (34 in the library: images 10 and videos, documents, research and presentations 6 each, `library.test.ts:12-18`, total `:23`). Scope every count to the studio's own root (`getByTestId("images-studio").getByTestId("example-card")`): the other studios stay mounted (G3). Titles and summaries are localized for all five modes; prompts only for documents and presentations (`ui-copy.ts:48`), the rest fall back to the English library string.
- **Select.** Click one `example-card`. The mode prompt contains that example’s prompt text (15s). `example-result` shows the card’s result summary.
- **Other modes.** Repeat on `/videos`, `/documents`, `/research`, `/presentations` when those agent tiles are visible. Do not remove or recount `documents-starter` / `presentations-starter` (still 2). `documents-starter` renders only while no draft exists (`documents-studio.tsx:326`), and `presentations-starter` sits inside the closed `presentations-more-details` (`presentations-studio.tsx:519`, `:629`); with a deck loaded `presentations-prompt` is inside that closed disclosure too (`:493-502`, `:523-529`).
- **IDE proof.** Screenshot under `evidence/templates/<run-id>/` with the gallery and prefilled prompt visible.
- **Cloud.** Same asserts via `page.getByTestId`.

## Gotchas

- Default already has the job-mode tabs a first desk starts with (Research, Images, Videos, Presentation). Missing `agent-images` on Default is a fail; missing `agent-documents` on a fresh Personal desk is expected. On a Legal desk it is expected — switch to Default or add the tab in Workspaces.
- `images-studio-gallery` / `videos-studio-gallery` are generated-result galleries, not the example cards.
- Documents / Presentations starters load a worked offline draft/outline. Template cards only prefill the prompt: `ExampleGallery`'s `onSelect` does nothing but `setPrompt(entry.prompt)` (`apps/web/components/documents-studio.tsx:324`), so a card can never produce `documents-preview` — only `documents-starter` and a live generate can.
- Prefill targets the mode studio prompt, not Chat `composer-text`.
- Card titles and `example-result` are localized on all five modes, but only `documents` and `presentation` have localized **prompts** in the catalogs; `images`, `videos` and `research` fall back to the English `TEMPLATE_LIBRARY` string (`apps/web/lib/ui-copy.ts:48`). So on an `id` desk the prefill is English on Images/Videos/Research and Indonesian on Documents/Presentations. Match a length or a mode-specific noun, not a fixed English sentence.
- `/videos` carries **two** card grids: the template gallery (`example-card`, 6) and the generated video examples (`videos-example-card` / `videos-example-video` / `videos-example-use-<templateId>`, `apps/web/components/video-examples.tsx:106`, `:116`, `:134`). Say which one you mean.
- The first click on `example-card` right after the studio paints can be swallowed on `/videos` and `/research` — the block above it finishes loading and moves the card. Assert `aria-pressed="true"` (or a non-empty prompt) and re-click once rather than treating the miss as a product fail.
- Library copy is industry-neutral — no `student` / `course` / campus nouns in titles or prompts.
- **Images picks its frame from the card.** A card click sets the prompt, and until `images-studio-aspect` is touched the sentence picks the aspect (`chooseImageFrame`, [images.md](./images.md)): "Quiet kitchen header" and "App in a working desk" give landscape, "About-page portrait" gives portrait, "Launch-page product hero" and "Fog path cover" (a clash) give square. `example-gallery` / `example-card` / `example-result` were missing from `SKILL.md`'s handles; they are a row there now. `videos-example-use-<templateId>` is a different control: it fills the prompt **and** sets aspect and the snapped seconds (`videos-studio.tsx:156-161`), while a gallery card only sets the prompt.
- **Driven 2026-10-05 on `:3000` (keyed; maintain3), no submit pressed.** Counts scoped to each studio: images 10, videos 6, research 6, documents 6, presentations 6; each first card set exactly one `aria-pressed="true"` card, showed `example-result` and filled the prompt (images 639, videos 420, research 922, documents 1317, presentations 1430 characters; `presentations-prompt` is a textarea); `images-quiet-kitchen-header` gave landscape and a prompt containing "article header", `images-fog-path-cover` gave square. The card ids on Images were `images-launch-page-product-hero, -app-in-a-working-desk, -lookbook-material-board, -quiet-kitchen-header, -dusk-city-establishing, -macro-fabric-study, -night-retail-window, -fog-path-cover, -about-page-portrait, -desk-object-still`.
