import { expect, type Page, test } from "@playwright/test";
import { showEveryMode } from "./every-mode";

/**
 * In the chat-first shell a mode's rail tile is `agent-<mode>`. Every agent opens a conversation. A
 * studio agent's empty conversation (`agent-home`) has a button that opens the old mode screen
 * (`studioHref`), so this is how a spec reaches one. Research is not a studio agent: its home has no
 * such button.
 */
async function openStudio(page: Page, mode: string) {
  await page.getByTestId(`agent-${mode}`).click();
  await expect(page.getByTestId("agent-home")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("agent-open-studio").click();
}

test.describe.configure({ retries: 0 });

test.setTimeout(180_000);

// A fresh desk starts with Research, Images, Videos and Presentation only; this spec drives the rest.
test.beforeEach(async ({ request }) => {
  await showEveryMode(request);
});

test("chat and workspaces work without an account", async ({ page }) => {
  const runId = Date.now().toString(36);
  const promptOne = `E2E one ${runId}: What is 2 + 3?`;
  const promptTwo = `E2E two ${runId}: Session two check`;
  const deskName = `Legal desk ${runId}`;

  await page.goto("/chat");
  // The tester code offers three choices (Daily, Fastest, Reasoning) instead of a model list and a
  // Thinking select. In the chat-first shell the picker is a chip in the agent's header, so it needs no
  // `+` click and the composer holds none. A person who never opens the picker is on Daily.
  const header = page.getByTestId("chat-header");
  await expect(header.getByTestId("tier-picker")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("composer").getByTestId("tier-picker")).toHaveCount(0);
  await expect(header.getByTestId("tier-picker")).toContainText("Daily");
  await expect(page.getByTestId("model-picker")).toHaveCount(0);
  await expect(page.getByTestId("reasoning-effort")).toHaveCount(0);
  await expect(page.getByTestId("chat-wire")).toHaveCount(0);
  await expect(page.getByTestId("chat-empty")).toContainText("Work starts here");
  // The chat-first rail lists agents: `mode-chat` is the generalist and the others are `agent-<mode>`.
  await expect(page.getByTestId("mode-chat")).toBeVisible();
  await expect(page.getByTestId("agent-documents")).toBeVisible();
  await expect(page.getByTestId("agent-research")).toBeVisible();
  await expect(page.getByTestId("agent-finance")).toBeVisible();
  await expect(page.getByTestId("agent-data")).toBeVisible();
  await expect(page.getByTestId("agent-market")).toBeVisible();
  await expect(page.getByTestId("agent-images")).toBeVisible();
  await expect(page.getByTestId("agent-videos")).toBeVisible();
  await expect(page.getByTestId("agent-edit")).toBeVisible();
  await expect(page.getByTestId("agent-presentations")).toBeVisible();
  await expect(page.getByTestId("mode-knowledge")).toBeVisible();
  await expect(page.getByTestId("mode-agents")).toHaveCount(0);
  // The agent rail has no desk switcher.
  await expect(page.getByTestId("workspaces-switcher")).toHaveCount(0);
  await expect(page.getByTestId("workspaces-link")).toBeVisible();

  await page.getByTestId("composer-text").fill(promptOne);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-list")).toContainText(promptOne, { timeout: 20_000 });
  // The send button is an icon: its name is its aria-label, "Sending" while a turn runs and "Send" after.
  await expect(page.getByTestId("composer-send")).toHaveAccessibleName("Send", { timeout: 30_000 });
  // Sessions are in the header's Conversations popover, not in the rail.
  await page.getByTestId("agent-history-toggle").click();
  await expect(page.getByTestId("rail-thread-list")).toContainText(promptOne);
  await page.keyboard.press("Escape");

  await page.getByTestId("new-chat-link").click();
  await expect(page.getByTestId("chat-empty")).toContainText("Work starts here", { timeout: 10_000 });
  await page.getByTestId("composer-text").fill(promptTwo);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-list")).toContainText(promptTwo, { timeout: 20_000 });
  await expect(page.getByTestId("composer-send")).toHaveAccessibleName("Send", { timeout: 30_000 });
  await page.getByTestId("agent-history-toggle").click();
  await expect(page.getByTestId("rail-thread-list")).toContainText(promptTwo);
  await page.getByTestId("thread-item").filter({ hasText: promptOne }).click();
  await expect(page.getByTestId("message-list")).toContainText(promptOne);

  await page.getByTestId("settings-link").click();
  await expect(page).toHaveURL(/\/settings/, { timeout: 30_000 });
  await expect(page.getByTestId("settings-form")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("privacy-note")).toBeVisible();
  await expect(page.getByTestId("key-fingerprint")).toHaveCount(0);
  await expect(page.getByTestId("runtime-status")).toContainText("No key", { timeout: 15_000 });
  await expect(page.getByTestId("usage-this-key")).toContainText("Paste a gateway key");
  await expect(page.getByTestId("usage-open")).toBeVisible();
  await expect(page.getByTestId("usage-by-model")).toHaveCount(0);
  await expect(page.getByTestId("usage-desk-estimate")).toHaveCount(0);
  await expect(page.getByTestId("settings-tab-simple")).toHaveCount(0);
  await expect(page.getByTestId("settings-tab-advanced")).toHaveCount(0);
  await expect(page.getByTestId("settings-build-link")).toHaveCount(0);
  await expect(page.getByTestId("openai-base-url")).toHaveCount(0);
  await expect(page.getByTestId("injection-guard-bypass")).toHaveCount(0);

  await expect(page.getByTestId("usage-link")).toBeVisible();
  await page.getByTestId("usage-open").click();
  await expect(page).toHaveURL(/\/usage/, { timeout: 30_000 });
  await expect(page.getByTestId("usage-range")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("usage-this-key")).toContainText("Paste a gateway key");
  await expect(page.getByTestId("usage-range-empty").or(page.getByTestId("usage-range-chart"))).toBeVisible({
    timeout: 15_000,
  });

  await openStudio(page, "images");
  await expect(page).toHaveURL(/\/images/, { timeout: 15_000 });
  await expect(page.getByTestId("images-studio")).toBeVisible({ timeout: 15_000 });

  await openStudio(page, "videos");
  await expect(page).toHaveURL(/\/videos/, { timeout: 15_000 });
  await expect(page.getByTestId("videos-studio")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("videos-studio-needs-key")).toBeVisible();

  await openStudio(page, "presentations");
  await expect(page).toHaveURL(/\/presentations/, { timeout: 15_000 });
  await expect(page.getByTestId("presentations-studio")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("presentations-more").click();
  await expect(page.getByTestId("presentations-studio-model")).toBeVisible();
  await expect(page.getByTestId("presentations-starter")).toHaveCount(2);
  await page.getByTestId("presentations-starter").first().click();
  await expect(page.getByTestId("presentations-preview")).toBeVisible();
  await expect(page.getByTestId("presentations-editor")).toBeVisible();
  await page.getByTestId("presentations-filmstrip-slide").nth(1).click();
  await expect(page.getByTestId("presentations-slide")).toBeVisible();
  await expect(page.getByTestId("presentations-regen")).toBeVisible();
  await page.getByTestId("presentations-regen").click();
  await expect(page.getByTestId("presentations-regen-panel")).toBeVisible();
  await expect(page.getByTestId("presentations-regen-prompt")).toBeVisible();
  await expect(page.getByTestId("presentations-regen-model")).toBeVisible();
  await expect(page.getByTestId("presentations-regen-attach")).toBeVisible();
  await page.getByTestId("presentations-regen-submit").click();
  await expect(page.getByTestId("presentations-error")).toContainText(/gateway|Settings|API key/i, { timeout: 15_000 });

  await openStudio(page, "documents");
  await expect(page).toHaveURL(/\/documents/, { timeout: 15_000 });
  await expect(page.getByTestId("documents-studio")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("documents-studio-model")).toBeVisible();
  await expect(page.getByTestId("documents-starter")).toHaveCount(2);
  await page.getByTestId("documents-starter").first().click();
  await expect(page.getByTestId("documents-preview")).toBeVisible();
  await expect(page.getByTestId("documents-regen").first()).toBeVisible();
  await page.getByTestId("documents-regen").first().click();
  await expect(page.getByTestId("documents-regen-panel")).toBeVisible();
  await expect(page.getByTestId("documents-regen-prompt")).toBeVisible();
  await expect(page.getByTestId("documents-regen-model")).toBeVisible();
  await expect(page.getByTestId("documents-regen-attach")).toBeVisible();
  await page.getByTestId("documents-regen-submit").click();
  await expect(page.getByTestId("documents-error")).toContainText(/gateway|Settings|API key/i, { timeout: 15_000 });

  // Not yet updated for the chat-first shell, from here to the end of the test: `/workspaces` is the
  // Virtual agents page (`virtual-agents-page`), which hires and lets go of agents and cannot create a
  // desk, so the desk-creation steps and the `mode-<name>` checks after them have no counterpart.
  await page.getByTestId("workspaces-link").click();
  await expect(page).toHaveURL(/\/workspaces/, { timeout: 15_000 });
  await expect(page.getByTestId("create-new-workspace")).toBeVisible();
  await expect(page.getByTestId("workspace-template-picker")).toHaveCount(0);
  await page.getByTestId("create-new-workspace").click();
  await expect(page.getByTestId("workspace-template-picker")).toBeVisible();
  await page.getByTestId("workspace-template-legal").click();
  await page.getByTestId("workspace-name").fill(deskName);
  await page.getByTestId("create-workspace").click();
  await expect(page).toHaveURL(/\/chat/, { timeout: 15_000 });
  await expect(page.getByTestId("mode-chat")).toBeVisible();
  await expect(page.getByTestId("mode-documents")).toBeVisible();
  await expect(page.getByTestId("mode-research")).toBeVisible();
  await expect(page.getByTestId("mode-presentations")).toBeVisible();
  await expect(page.getByTestId("mode-images")).toHaveCount(0);
  await expect(page.getByTestId("mode-videos")).toHaveCount(0);
  await expect(page.getByTestId("mode-edit")).toHaveCount(0);
  await expect(page.getByTestId("mode-finance")).toHaveCount(0);
  await expect(page.getByTestId("mode-data")).toHaveCount(0);
  await expect(page.getByTestId("mode-market")).toHaveCount(0);
  await expect(page.getByTestId("mode-knowledge")).toBeVisible();
  await expect(page.getByTestId("mode-agents")).toHaveCount(0);
});
