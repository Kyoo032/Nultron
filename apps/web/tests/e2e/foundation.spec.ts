import { expect, type Page, test } from "@playwright/test";
import agentsCopy from "../../locales/en/agents.json" with { type: "json" };
import chatCopy from "../../locales/en/chat.json" with { type: "json" };
import { EVERY_MODE, showEveryMode } from "./every-mode";

// The headline the empty Chat renders (chat-launcher.tsx, key chat.empty.headline). Read from the en
// catalog so a copy edit does not break this suite again (SH-003).
const EMPTY_CHAT_HEADLINE = chatCopy.empty.headline;
const AGENTS_LEDE = agentsCopy.page.lede;
const AGENTS_NONE_AVAILABLE = agentsCopy.page.noneAvailable;
const AGENTS_KIND_CHAT = agentsCopy.page.converses;
const AGENTS_KIND_STUDIO = agentsCopy.page.studio;

/** Chat and Research run their harness in chat. Every other agent keeps its checked run in a studio. */
const HARNESS_IN_CHAT = new Set(["chat", "research"]);

function agentCard(page: Page, mode: string) {
  return page.locator(`[data-testid="agent-card"][data-agent="${mode}"]`);
}

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

// A fresh desk starts with the default agent alone; this spec hires every other one first.
test.beforeEach(async ({ request }) => {
  await showEveryMode(request);
});

test("chat and workspaces work without an account", async ({ page }) => {
  const runId = Date.now().toString(36);
  const promptOne = `E2E one ${runId}: What is 2 + 3?`;
  const promptTwo = `E2E two ${runId}: Session two check`;

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
  await expect(page.getByTestId("chat-empty")).toContainText(EMPTY_CHAT_HEADLINE);
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
  await expect(page.getByTestId("chat-empty")).toContainText(EMPTY_CHAT_HEADLINE, { timeout: 10_000 });
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

  // `/workspaces` is the Virtual agents page. It hires and lets go of agents on the current desk.
  // It cannot create a desk, so the old create-new-workspace flow is not on this page.
  await page.getByTestId("workspaces-link").click();
  await expect(page).toHaveURL(/\/workspaces/, { timeout: 15_000 });
  await expect(page.getByTestId("virtual-agents-page")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: agentsCopy.page.title })).toBeVisible();
  await expect(page.getByTestId("virtual-agents-lede")).toContainText(AGENTS_LEDE);
  await expect(page.getByTestId("create-new-workspace")).toHaveCount(0);
  await expect(page.getByTestId("workspace-template-picker")).toHaveCount(0);
  await expect(page.getByTestId("workspace-name")).toHaveCount(0);
  await expect(page.getByTestId("workspaces-page")).toHaveCount(0);
  await expect(page.getByTestId("agents-on-desk")).toBeVisible();
  await expect(page.getByTestId("agents-available")).toBeVisible();
  // beforeEach put every mode on the desk, so nothing is left to hire.
  await expect(page.getByTestId("agents-none-available")).toContainText(AGENTS_NONE_AVAILABLE);
  await expect(page.getByTestId("agent-hire")).toHaveCount(0);
  await expect(page.getByTestId("agent-card")).toHaveCount(EVERY_MODE.length);
  await expect(page.getByTestId("agent-always")).toHaveCount(1);
  await expect(page.getByTestId("agent-let-go")).toHaveCount(EVERY_MODE.length - 1);

  for (const mode of EVERY_MODE) {
    const card = agentCard(page, mode);
    await expect(card).toBeVisible();
    await expect(card.getByTestId("agent-open")).toBeVisible();
    await expect(card.getByTestId("agent-kind")).toContainText(
      HARNESS_IN_CHAT.has(mode) ? AGENTS_KIND_CHAT : AGENTS_KIND_STUDIO,
    );
    if (mode === "chat") {
      await expect(card.getByTestId("agent-always")).toBeVisible();
      await expect(card.getByTestId("agent-let-go")).toHaveCount(0);
    } else {
      await expect(card.getByTestId("agent-let-go")).toBeVisible();
      await expect(card.getByTestId("agent-hire")).toHaveCount(0);
    }
  }

  // Letting Edit go drops only that agent. The rail id is `agent-edit`, and the old `mode-*` tiles stay absent.
  const editOnDesk = page.locator('[data-testid="agents-on-desk"] [data-testid="agent-card"][data-agent="edit"]');
  await editOnDesk.getByTestId("agent-let-go").click();
  const editAvailable = page.locator(
    '[data-testid="agents-available"] [data-testid="agent-card"][data-agent="edit"]',
  );
  await expect(editAvailable).toBeVisible({ timeout: 15_000 });
  await expect(editAvailable.getByTestId("agent-hire")).toBeVisible();
  await expect(editOnDesk).toHaveCount(0);
  await expect(page.getByTestId("agents-none-available")).toHaveCount(0);
  await expect(page.getByTestId("agent-edit")).toHaveCount(0);
  await expect(page.getByTestId("mode-edit")).toHaveCount(0);
  await expect(page.getByTestId("mode-documents")).toHaveCount(0);
  await expect(page.getByTestId("mode-research")).toHaveCount(0);
  await expect(page.getByTestId("mode-presentations")).toHaveCount(0);
  await expect(page.getByTestId("mode-images")).toHaveCount(0);
  await expect(page.getByTestId("mode-videos")).toHaveCount(0);
  await expect(page.getByTestId("mode-finance")).toHaveCount(0);
  await expect(page.getByTestId("mode-data")).toHaveCount(0);
  await expect(page.getByTestId("mode-market")).toHaveCount(0);
  await expect(page.getByTestId("agent-documents")).toBeVisible();
  await expect(page.getByTestId("agent-research")).toBeVisible();
  await expect(page.getByTestId("agent-presentations")).toBeVisible();
  await expect(page.getByTestId("agent-images")).toBeVisible();
  await expect(page.getByTestId("agent-videos")).toBeVisible();
  await expect(page.getByTestId("agent-finance")).toBeVisible();
  await expect(page.getByTestId("agent-data")).toBeVisible();
  await expect(page.getByTestId("agent-market")).toBeVisible();
  await expect(page.getByTestId("mode-chat")).toBeVisible();
  await expect(page.getByTestId("mode-knowledge")).toBeVisible();
  await expect(page.getByTestId("mode-agents")).toHaveCount(0);

  await editAvailable.getByTestId("agent-hire").click();
  await expect(editOnDesk.getByTestId("agent-let-go")).toBeVisible({ timeout: 15_000 });
  await expect(editAvailable).toHaveCount(0);
  await expect(page.getByTestId("agents-none-available")).toBeVisible();
  await expect(page.getByTestId("agent-hire")).toHaveCount(0);
  await expect(page.getByTestId("agent-edit")).toBeVisible();
});
