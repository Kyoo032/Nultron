/**
 * What every pane says on the hosted app when the desk has no usable gateway key.
 *
 * Nultron Enterprise (owner decision 2026-10-01): a signed-in tenant may open the desk before adding
 * a key ("Add it later"). The host still refuses every gateway-calling route with the flat
 * `403 gateway_blocked`, so every pane that would have called a model has to say so calmly and point
 * at Settings, instead of printing a generic failure. The panes learn it two ways, both driven here:
 * the host reports a closed gate on a settings read, or any call answers `403 gateway_blocked`.
 *
 * `renderToStaticMarkup` runs no effects, so what it returns is the frame the shared gate store
 * produces on its own: the store is seeded, then every pane is rendered and read.
 *
 * The second half is the other product. On the Personal app none of this exists: the same seeded
 * store changes nothing about any pane, and no pane has a needs-key note it did not have before.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatKeyStatus } from "@/components/chat-key-status";
import { ChatComposer } from "@/components/chat-composer";
import { DataStudio } from "@/components/data-studio";
import { DocumentsStudio } from "@/components/documents-studio";
import { FinanceStudio } from "@/components/finance-studio";
import { ImagesStudio } from "@/components/images-studio";
import { KnowledgePage } from "@/components/knowledge-page";
import { LegalStudio } from "@/components/legal-studio";
import { MarketStudio } from "@/components/market-studio";
import { MeetingStudio } from "@/components/meeting-studio";
import { MusicStudio } from "@/components/music-studio";
import { PresentationsStudio } from "@/components/presentations-studio";
import { ResearchStudio } from "@/components/research-studio";
import { VideosStudio } from "@/components/videos-studio";
import { apiFetch } from "./api-client";
import { publishGate, resetGateStateForTests } from "./gate-state";
import { resetGatewayBlockedForTests } from "./gateway-blocked";
import { resetSettingsReadForTests } from "./settings-read";
import type { GatewayGatePayload } from "./gateway-gate";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import { SessionFixture } from "./session";

const CLOSED: GatewayGatePayload = {
  status: "needs_key",
  allowed: false,
  grace: false,
  endpoint: "https://api.tokotokenai.com/v1",
  endpointLocked: true,
  checkedAt: null,
  lastOkAt: null,
};

const OPEN: GatewayGatePayload = { ...CLOSED, status: "ok", allowed: true };

const BLOCKED_BODY = {
  error: "gateway_blocked",
  status: "needs_key",
  message: "No gateway key is saved on this machine.",
};

function hosted(): void {
  vi.stubGlobal("__AGENTFORGE_SERVER__", "1");
}

beforeEach(() => {
  resetGateStateForTests();
  resetGatewayBlockedForTests();
  resetSettingsReadForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetGateStateForTests();
  resetLocaleForTests();
});

function page(element: ReactElement, url = "/"): string {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[url]}>{element}</MemoryRouter>);
}

/** The anchor that carries `testId`, whichever order its attributes came out in. */
function anchor(html: string, testId: string): string {
  return new RegExp(`<a [^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
}

function composer(): ReactElement {
  return (
    <ChatComposer
      threadId={null}
      modalities={["text"]}
      model="model-a"
      models={[{ id: "model-a", label: "Model A", inputModalities: ["text"] }]}
      onModelChange={() => {}}
      onReasoningEffortChange={() => {}}
      onDelta={() => {}}
      onComplete={() => {}}
    />
  );
}

/** Every pane that gained a needs-key note, with the testid its note carries. */
const NEW_NOTES: ReadonlyArray<{ mode: string; testId: string; element: () => ReactElement; url?: string }> = [
  { mode: "research", testId: "research-needs-key", element: () => <ResearchStudio /> },
  { mode: "data", testId: "data-needs-key", element: () => <DataStudio /> },
  { mode: "finance", testId: "finance-needs-key", element: () => <FinanceStudio />, url: "/finance?task=ratios" },
  { mode: "market", testId: "market-needs-key", element: () => <MarketStudio /> },
  { mode: "legal", testId: "legal-needs-key", element: () => <LegalStudio /> },
  { mode: "meeting", testId: "meeting-needs-key", element: () => <MeetingStudio /> },
  { mode: "presentations", testId: "presentations-needs-key", element: () => <PresentationsStudio /> },
  { mode: "knowledge", testId: "knowledge-needs-key", element: () => <KnowledgePage /> },
];

describe("hosted, the host reports a closed gate", () => {
  beforeEach(() => {
    hosted();
    publishGate(CLOSED);
  });

  it("Chat's composer says a key is missing, with a link to Settings, and quiets Send", () => {
    const html = page(composer());

    expect(html).toContain('data-testid="composer-needs-key"');
    expect(html).toContain('data-testid="composer-needs-key-settings"');
    expect(anchor(html, "composer-needs-key-settings")).toContain('href="/settings"');
    expect(html).toContain(t("rail.settings"));
    // Send is quiet and says why in its tooltip.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="composer-send"|data-testid="composer-send"[^>]*disabled=""/);
  });

  it("Chat's key pill asks for a key, not 'Signed in · Ready', even for a signed-in session", () => {
    const html = page(
      <SessionFixture
        value={{
          status: "signed-in",
          identity: { userId: "u", orgId: "o", tenantId: "t", expiresAt: 0 },
          reason: null,
        }}
      >
        <ChatKeyStatus />
      </SessionFixture>,
    );

    expect(html).toContain(t("chat.empty.statusNeedsKey"));
    expect(html).not.toContain(t("chat.empty.statusSignedIn"));
    expect(html).toMatch(/class="btn btn-primary"[^>]*data-testid="chat-empty-settings"/);
  });

  it("Documents swaps its plain note for one with a Settings link", () => {
    const html = page(<DocumentsStudio />);

    expect(html).toContain('data-testid="documents-needs-key"');
    expect(html).toContain('data-testid="documents-needs-key-settings"');
  });

  for (const { mode, testId, element, url } of NEW_NOTES) {
    it(`${mode} shows its needs-key note with a link to Settings`, () => {
      const html = page(element(), url);

      expect(html, mode).toContain(`data-testid="${testId}"`);
      expect(anchor(html, `${testId}-settings`), mode).toContain('href="/settings"');
    });
  }

  it("Images, Videos and Music quiet their Generate button and say what is missing", () => {
    for (const element of [<ImagesStudio key="i" />, <VideosStudio key="v" />, <MusicStudio key="m" />]) {
      const html = page(element);
      expect(html).toMatch(/Add a [^"<]* gateway key in Settings to generate/);
    }
    expect(page(<VideosStudio />)).toContain('data-testid="videos-studio-needs-key"');
    expect(page(<MusicStudio />)).toContain('data-testid="music-studio-needs-key"');
  });

  it("speaks Indonesian on an id desk", () => {
    applyLocale("id");
    const html = page(<ResearchStudio />);

    expect(html).toContain('data-testid="research-needs-key"');
    expect(html).toContain("Pengaturan");
    expect(html).not.toContain("Add your");
  });

  it("the host reporting an open gate takes every note away again, without a reload", () => {
    publishGate(OPEN);

    expect(page(composer())).not.toContain('data-testid="composer-needs-key"');
    for (const { testId, element, url } of NEW_NOTES) {
      expect(page(element(), url)).not.toContain(`data-testid="${testId}"`);
    }
  });
});

describe("hosted, a call answers 403 gateway_blocked (the gate had been open)", () => {
  beforeEach(() => {
    hosted();
    publishGate(OPEN);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify(BLOCKED_BODY), { status: 403, headers: { "Content-Type": "application/json" } }),
    );
  });

  async function refused(path: string): Promise<void> {
    await apiFetch(path, { method: "POST", body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("flips Chat's composer to the needs-key state", async () => {
    expect(page(composer())).not.toContain('data-testid="composer-needs-key"');

    await refused("/api/v1/threads/thr_1/runs/text");

    const html = page(composer());
    expect(html).toContain('data-testid="composer-needs-key"');
    expect(html).toContain('data-testid="composer-needs-key-settings"');
  });

  it("flips a studio too: Research shows the calm note, not an error", async () => {
    expect(page(<ResearchStudio />)).not.toContain('data-testid="research-needs-key"');

    await refused("/api/v1/research/stream");

    const html = page(<ResearchStudio />);
    expect(html).toContain('data-testid="research-needs-key"');
    expect(html).toContain('data-testid="research-needs-key-settings"');
    expect(html).not.toContain('data-testid="research-error"');
  });

  it("flips every pane at once, since the store is shared", async () => {
    await refused("/api/v1/documents");

    for (const { testId, element, url } of NEW_NOTES) {
      expect(page(element(), url), testId).toContain(`data-testid="${testId}"`);
    }
  });
});

describe("the Personal app: the same seeded store changes nothing", () => {
  beforeEach(() => {
    // No hosted marker. Every writer to the store is inert here, and every reader ignores it.
    publishGate(CLOSED);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify(BLOCKED_BODY), { status: 403, headers: { "Content-Type": "application/json" } }),
    );
  });

  it("shows no needs-key note on any pane, even after a 403 gateway_blocked went through apiFetch", async () => {
    await apiFetch("/api/v1/research/stream", { method: "POST", body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(page(composer())).not.toContain('data-testid="composer-needs-key"');
    expect(page(<DocumentsStudio />)).not.toContain('data-testid="documents-needs-key"');
    for (const { testId, element, url } of NEW_NOTES) {
      expect(page(element(), url), testId).not.toContain(`data-testid="${testId}"`);
    }
    expect(page(<VideosStudio />)).not.toContain('data-testid="videos-studio-needs-key"');
    expect(page(<MusicStudio />)).not.toContain('data-testid="music-studio-needs-key"');
  });

  it("renders every pane that gained the hook exactly as it renders with the gate open", () => {
    const closedMarkup = NEW_NOTES.map(({ element, url }) => page(element(), url));
    resetGateStateForTests();
    publishGate(OPEN);
    const openMarkup = NEW_NOTES.map(({ element, url }) => page(element(), url));

    expect(closedMarkup).toEqual(openMarkup);
  });

  it("keeps Chat's key pill on the Personal copy: the store is never read", () => {
    const html = page(<ChatKeyStatus />);
    // First frame, host not heard from: the pill keeps its room and paints nothing.
    expect(html).toMatch(/class="chat-status-pill[^"]*\binvisible\b/);
    expect(html).not.toContain(t("chat.empty.statusNeedsKey"));
  });
});
