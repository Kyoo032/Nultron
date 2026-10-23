/**
 * Edit on the hosted app, with no gateway key (Nultron Enterprise; owner review 2026-10-01, L3).
 *
 * A hosted tenant may open the desk before adding a key ("Add it later"). Every other pane already says
 * so calmly and quiets its model button; Edit's Agent pane did not: no note, Send enabled, and only after
 * a refused call did a red "Add your key" line appear. The pane now shows the same `NeedsKeyNote` every
 * other pane shows and quiets Send until a key is there. And the "install ffmpeg" guide, which tells a
 * person to type `sudo apt install ffmpeg`, is for a machine the person owns: a hosted tenant cannot
 * install anything on the server, so there it is a calm line with no command.
 *
 * `renderToStaticMarkup` runs no effects, so the shared gate store is seeded the way the settings read
 * would seed it, and the frame it produces is what is read.
 *
 * The second half of each block is the other product. The Personal strings below are the exact markup
 * the components produced before this change (captured from the unchanged code first), so a Personal
 * desk is held to the byte, not to "still has the words".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditAgentPanel } from "@/components/edit-agent-panel";
import { EditGenerateTab } from "@/components/edit-generate-tab";
import { EditRecipesPanel } from "@/components/edit-recipes-panel";
import { FfmpegSetupNotice } from "@/components/ffmpeg-setup-notice";
import type { EditDoctor } from "./edit-client";
import { publishGate, resetGateStateForTests } from "./gate-state";
import type { GatewayGatePayload } from "./gateway-gate";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import { useHostedNeedsKey } from "./use-desk-needs-key";

vi.mock("@/lib/api-client", () => ({
  isElectron: () => false,
  apiFetch: async () => ({ ok: true, json: async () => ({}) }) as Response,
}));

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(join(web, relative), "utf8").replace(/\r\n/g, "\n");

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

function hosted(): void {
  vi.stubGlobal("__AGENTFORGE_SERVER__", "1");
}

beforeEach(() => {
  resetGateStateForTests();
  applyLocale("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetGateStateForTests();
  resetLocaleForTests();
});

function panel(needsKey?: boolean): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <EditAgentPanel
        project={null}
        cards={[]}
        jobs={[]}
        unplaced={[]}
        spendCap={2}
        emitLockActive={false}
        composerPrefill=""
        onComposerPrefill={() => undefined}
        onSend={() => undefined}
        onKeep={() => undefined}
        onUndo={() => undefined}
        onTweak={() => undefined}
        onCancel={() => undefined}
        onPlanGo={() => undefined}
        onReviewOk={() => undefined}
        onPlace={() => undefined}
        onDiscard={() => undefined}
        {...(needsKey === undefined ? {} : { needsKey })}
      />
    </MemoryRouter>,
  );
}

/** The opening tag of the element carrying `testId`. */
function tag(markup: string, testId: string): string {
  return markup.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
}

describe("Edit's Agent pane, hosted, no usable key", () => {
  it("shows the shared needs-key note with a link to Settings, and quiets Send", () => {
    const html = panel(true);

    expect(html).toContain('data-testid="edit-agent-needs-key"');
    expect(html).toContain('role="status"');
    expect(tag(html, "edit-agent-needs-key-settings")).toContain('href="/settings"');
    expect(html).toContain(t("rail.settings"));
    expect(html).toContain("Add your Toko Token key in");
    expect(tag(html, "edit-composer-send")).toMatch(/ disabled=""/);
  });

  it("still lets the person type: only sending is quiet", () => {
    expect(tag(panel(true), "edit-composer")).not.toMatch(/ disabled=""/);
  });

  it("puts the note where the composer is, above the box", () => {
    const html = panel(true);
    expect(html.indexOf("edit-agent-needs-key")).toBeGreaterThan(-1);
    expect(html.indexOf("edit-agent-needs-key")).toBeLessThan(html.indexOf('data-testid="edit-composer"'));
  });

  it("speaks Indonesian on an id desk", () => {
    applyLocale("id");
    const html = panel(true);

    expect(html).toContain('data-testid="edit-agent-needs-key"');
    expect(html).toContain("Pengaturan");
    expect(html).not.toContain("Add your");
  });
});

describe("Edit's Agent pane, a key is there or the product is Personal", () => {
  const PERSONAL_SEND =
    '<button type="submit" class="btn btn-primary mt-1 w-full py-1.5 text-sm" data-testid="edit-composer-send">Send</button>';

  it("renders no note and an enabled Send when the flag is false", () => {
    const html = panel(false);
    expect(html).not.toContain("edit-agent-needs-key");
    expect(html).toContain(PERSONAL_SEND);
  });

  it("renders exactly what it rendered before the prop existed when the prop is omitted", () => {
    // Captured from the component before the change, so the Personal Agent pane is held to the byte.
    expect(panel()).toBe(
      `<aside class="flex h-full min-h-0 w-[240px] min-w-[200px] shrink flex-col overflow-hidden border-l border-[var(--line)] bg-[var(--surface)] min-[1600px]:w-[300px] min-[2400px]:w-[340px]" data-testid="edit-agent-panel"><div class="flex items-center justify-between border-b border-[var(--line)] px-3 py-2"><span class="text-xs font-heading uppercase tracking-[.12em] text-[var(--text-3)]">Agent</span><span class="text-xs text-[var(--text-2)]" data-testid="edit-spend-meter">turn $0.00 / $2.00</span></div><div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2"></div><form class="border-t border-[var(--line)] p-2"><textarea class="h-20 w-full resize-none rounded-md border border-[var(--line)] bg-transparent px-2 py-1.5 text-sm outline-none" placeholder="Ask the editor…" data-testid="edit-composer"></textarea>${PERSONAL_SEND}</form></aside>`,
    );
    expect(panel(false)).toBe(panel());
  });
});

describe("what EditStudio hands the pane", () => {
  const studio = source("components/edit-studio.tsx");

  /** A probe that reads the hook the studio calls, so the answer is the one the studio gets. */
  function Probe() {
    return <>{String(useHostedNeedsKey())}</>;
  }
  const read = () => renderToStaticMarkup(<Probe />);

  it("passes the hosted-only hook's answer, never the mount-time key read", () => {
    const start = studio.indexOf("<EditAgentPanel");
    const agent = studio.slice(start, studio.indexOf("/>", start));
    expect(agent).toContain("needsKey={hostedNeedsKey}");
    expect(agent).not.toContain("!hasKey");
    expect(studio).toContain("const hostedNeedsKey = useHostedNeedsKey();");
  });

  it("hosted, the hook says so while the host's gate is closed, and stops when it opens", () => {
    hosted();
    publishGate(CLOSED);
    expect(read()).toBe("true");
    publishGate(OPEN);
    expect(read()).toBe("false");
  });

  it("Personal: the hook is false whatever the store holds, so the pane gets false", () => {
    // No hosted marker: the writers are inert and the reader never consults the store.
    publishGate(CLOSED);
    expect(read()).toBe("false");
  });

  it("hides the refused-for-no-key banner, because the note already says it, and keeps every other error", () => {
    expect(studio).toContain("{error && !isGatewayBlockedText(error) ? (");
    expect(studio).toMatch(/import \{[^}]*isGatewayBlockedText[^}]*\} from "@\/lib\/gateway-blocked";/);
  });
});

describe("the ffmpeg install guide", () => {
  const LINUX: EditDoctor = {
    ffmpeg: {
      found: false,
      setup: {
        platform: "linux",
        summary: "ffmpeg was not found.",
        installCommand: "sudo apt install ffmpeg",
        installUrl: "https://ffmpeg.org/download.html",
        steps: ["Run the command", "Press Check again"],
        envVar: "AGENTFORGE_FFMPEG_PATH",
      },
    },
  };

  const notice = (variant?: "compact" | "full") =>
    renderToStaticMarkup(<FfmpegSetupNotice doctor={LINUX} onDoctor={() => undefined} variant={variant} />);

  describe("hosted", () => {
    beforeEach(hosted);

    it("never tells a tenant to install anything: no command, no copy button, no re-check, no guide link", () => {
      for (const variant of ["compact", "full"] as const) {
        const html = notice(variant);
        expect(html, variant).not.toContain("sudo apt");
        expect(html, variant).not.toContain("apt install");
        expect(html, variant).not.toContain("ffmpeg-install-command");
        expect(html, variant).not.toContain("ffmpeg-recheck");
        expect(html, variant).not.toContain("ffmpeg-setup-steps");
        expect(html, variant).not.toContain("Install guide");
        expect(html, variant).not.toContain("<button");
        expect(html, variant).not.toContain("<a ");
      }
    });

    it("says, calmly, that the server has no video tools yet and who to ask", () => {
      const html = notice();
      expect(html).toContain('data-testid="edit-needs-ffmpeg"');
      expect(html).toContain('role="status"');
      expect(html).toContain(t("edit.ffmpeg.hostedUnavailable"));
      expect(html).toContain("administrator");
    });

    it("says it in Bahasa Indonesia on an id desk", () => {
      applyLocale("id");
      const html = notice();
      expect(html).toContain("administrator");
      expect(html).toContain(t("edit.ffmpeg.hostedUnavailable"));
      expect(html).not.toContain("not set up");
    });

    it("says nothing when ffmpeg is there", () => {
      const found: EditDoctor = { ffmpeg: { found: true } };
      expect(renderToStaticMarkup(<FfmpegSetupNotice doctor={found} onDoctor={() => undefined} />)).toBe("");
    });
  });

  describe("Personal", () => {
    // Captured from the component before the change.
    const ROW =
      '<div class="flex flex-wrap items-center gap-2"><span><strong>Linux setup:</strong> ffmpeg was not found.</span><code class="rounded bg-[var(--surface)] px-2 py-0.5 font-mono text-xs" data-testid="ffmpeg-install-command">sudo apt install ffmpeg</code><button type="button" class="btn btn-ghost px-2 py-0.5 text-xs">Copy</button><button type="button" class="btn btn-secondary px-2 py-0.5 text-xs" data-testid="ffmpeg-recheck">Check again</button><a class="underline" href="https://ffmpeg.org/download.html" target="_blank" rel="noopener noreferrer">Install guide</a></div>';
    const WRAP =
      '<div class="border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-4 py-2 text-xs text-[var(--text-2)]" data-testid="edit-needs-ffmpeg" role="status">';

    it("keeps the guide, the command, Copy, Check again and the link, byte for byte", () => {
      expect(notice("compact")).toBe(`${WRAP}${ROW}</div>`);
    });

    it("keeps the onboarding steps list in the full variant", () => {
      expect(notice("full")).toBe(
        `${WRAP}${ROW}<ol class="mt-2 list-decimal space-y-1 pl-5" data-testid="ffmpeg-setup-steps"><li>Run the command</li><li>Press Check again</li></ol></div>`,
      );
    });

    it("is not affected by the shared gate store", () => {
      publishGate(CLOSED);
      expect(notice("compact")).toBe(`${WRAP}${ROW}</div>`);
    });
  });

  describe("the onboarding screen", () => {
    it("does not offer the install guide, or the 'install ffmpeg later' line, on the hosted build", () => {
      const onboarding = source("components/onboarding-screen.tsx");
      expect(onboarding).toContain("const needsFfmpeg = !isHostedBuild() && doctor?.ffmpeg?.found === false;");
      expect(onboarding).toMatch(/import \{ isHostedBuild \} from "@\/lib\/hosted-build";/);
    });
  });
});

/**
 * Everything else in Edit that reaches the model. The Agent pane's Send was quieted first; three more
 * doors lead to the same call and were not (owner review 2026-10-01, L3 follow-up):
 *
 *  - "Go" on a plan card, which sends the word "Go" to the Edit agent;
 *  - a recipe button, which sends "Run recipe <id>";
 *  - the Generate tab's submit, which posts a paid generation (it never touched the agent: its
 *    `onAgentPrompt` prop is declared and unused, so the door that exists is the submit itself).
 *
 * Each is quiet while a hosted key is missing, and says why in the one way a screen reader can follow
 * (`aria-describedby` at the needs-key note on screen) and a pointer can (`title`). Personal is held to
 * the byte: the goldens below were captured from the components before this change.
 */
describe("Edit's other model entry points, hosted, no usable key", () => {
  const NOTE_ID = "edit-agent-needs-key-note";
  const TITLE = "Add your key in Settings to use this.";
  const PLAN = {
    id: "c1",
    verb: "Generate",
    object: "intro clip",
    status: "plan",
    toolKey: "propose_plan",
    estimateUsd: 0.5,
  };

  function panelWithPlan(needsKey?: boolean): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <EditAgentPanel
          project={null}
          cards={[PLAN]}
          jobs={[]}
          unplaced={[]}
          spendCap={2}
          emitLockActive={false}
          composerPrefill=""
          onComposerPrefill={() => undefined}
          onSend={() => undefined}
          onKeep={() => undefined}
          onUndo={() => undefined}
          onTweak={() => undefined}
          onCancel={() => undefined}
          onPlanGo={() => undefined}
          onReviewOk={() => undefined}
          onPlace={() => undefined}
          onDiscard={() => undefined}
          {...(needsKey === undefined ? {} : { needsKey })}
        />
      </MemoryRouter>,
    );
  }

  const recipes = (needsKey?: boolean) =>
    renderToStaticMarkup(
      <EditRecipesPanel onRun={() => undefined} {...(needsKey === undefined ? {} : { needsKey })} />,
    );

  const generate = (needsKey: boolean) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <EditGenerateTab project={{ id: "p1" }} models={[]} needsKey={needsKey} gatewayName="Toko Token" />
      </MemoryRouter>,
    );

  /** The whole element carrying `testId`, opening tag to closing tag. */
  const element = (markup: string, tagName: string, testId: string) =>
    markup.match(new RegExp(`<${tagName}[^>]*data-testid="${testId}"[^>]*>[^]*?</${tagName}>`))?.[0] ?? "";

  describe("the plan card's Go", () => {
    it("is quiet, explains itself, and points at the note that is on screen", () => {
      const html = panelWithPlan(true);
      const go = tag(html, "edit-plan-go");

      expect(go).toMatch(/ disabled=""/);
      expect(go).toContain(`title="${TITLE}"`);
      expect(go).toContain(`aria-describedby="${NOTE_ID}"`);
      // The description it points at exists, in the same pane, and is the shared note.
      expect(tag(html, "edit-agent-needs-key")).toContain(`id="${NOTE_ID}"`);
    });

    it("explains itself in Indonesian on an id desk", () => {
      applyLocale("id");
      const go = tag(panelWithPlan(true), "edit-plan-go");
      expect(go).toContain("Pengaturan");
      expect(go).not.toContain("Add your");
    });

    it("Personal and a hosted desk with a key: the exact markup it always had", () => {
      const GO = '<button type="button" class="btn btn-primary mt-2 px-3 py-1 text-xs" data-testid="edit-plan-go">Go</button>';
      for (const html of [panelWithPlan(), panelWithPlan(false)]) {
        expect(html).toContain(GO);
        expect(html).not.toContain(NOTE_ID);
      }
    });
  });

  describe("the recipe buttons", () => {
    it("are all quiet and each points at the note", () => {
      const html = recipes(true);
      for (const id of ["podcast-clean-up", "reels-cutdown"]) {
        const button = tag(html, `edit-recipe-${id}`);
        expect(button, id).toMatch(/ disabled=""/);
        expect(button, id).toContain(`title="${TITLE}"`);
        expect(button, id).toContain(`aria-describedby="${NOTE_ID}"`);
        expect(button, id).toContain("cursor-not-allowed");
      }
      expect(html).not.toContain('class="w-full rounded-md border border-[var(--line)] px-2 py-1.5 text-left text-xs hover:bg-[var(--line)]/30"');
    });

    it("Personal and a hosted desk with a key: the exact markup it always had", () => {
      // Captured from the component before the change, so the Personal recipe list is held to the byte.
      const BEFORE =
        '<div class="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-3 text-sm"><p class="text-xs text-[var(--text-3)]">Each step becomes its own card after Go.</p><ul class="space-y-1"><li><button type="button" class="w-full rounded-md border border-[var(--line)] px-2 py-1.5 text-left text-xs hover:bg-[var(--line)]/30" data-testid="edit-recipe-podcast-clean-up">Podcast clean-up<span class="mt-0.5 block text-xs text-[var(--text-3)]">3 steps</span></button></li><li><button type="button" class="w-full rounded-md border border-[var(--line)] px-2 py-1.5 text-left text-xs hover:bg-[var(--line)]/30" data-testid="edit-recipe-reels-cutdown">Reels cutdown<span class="mt-0.5 block text-xs text-[var(--text-3)]">2 steps</span></button></li></ul></div>';
      expect(recipes()).toBe(BEFORE);
      expect(recipes(false)).toBe(BEFORE);
    });
  });

  describe("the Generate tab's submit", () => {
    const SUBMIT_BEFORE =
      '<button type="submit" class="btn btn-primary w-full px-2 py-1.5 text-xs" disabled="" data-testid="edit-generate-submit">Generate</button>';
    const NOTE_BEFORE =
      '<p class="rounded-md border border-[var(--line)] bg-[var(--line)]/30 px-2 py-2 text-xs text-[var(--text-2)]" data-testid="edit-needs-key">Add a Toko Token gateway key in <a class="underline" href="/settings" data-discover="true">Settings</a> to generate.</p>';
    const PROMPT_BEFORE =
      '<textarea class="min-h-[72px] min-w-0 w-full rounded-md border border-[var(--line)] bg-transparent px-2 py-1 text-xs" placeholder="Describe a video…" data-testid="edit-generate-prompt"></textarea>';

    it("hosted: stays quiet, says why, and points at the tab's own note", () => {
      hosted();
      const html = generate(true);
      const submit = tag(html, "edit-generate-submit");

      expect(submit).toMatch(/ disabled=""/);
      expect(submit).toContain(`title="${TITLE}"`);
      expect(submit).toContain('aria-describedby="edit-generate-needs-key-note"');
      expect(tag(html, "edit-needs-key")).toContain('id="edit-generate-needs-key-note"');
      // The prompt box stays editable (only sending is quiet, as in the Agent pane) but is described too.
      expect(tag(html, "edit-generate-prompt")).not.toMatch(/ disabled=""/);
      expect(tag(html, "edit-generate-prompt")).toContain('aria-describedby="edit-generate-needs-key-note"');
    });

    it("hosted, with a key: no hint, no id, the markup it had", () => {
      hosted();
      const html = generate(false);
      expect(element(html, "button", "edit-generate-submit")).toBe(SUBMIT_BEFORE);
      expect(element(html, "textarea", "edit-generate-prompt")).toBe(PROMPT_BEFORE);
      expect(html).not.toContain("edit-needs-key");
    });

    it("Personal with no key: the same note and the same quiet button, byte for byte, with nothing added", () => {
      // Not hosted: `needsKey` here is the desk's own mount-time read, which already quieted this button.
      const html = generate(true);
      expect(element(html, "button", "edit-generate-submit")).toBe(SUBMIT_BEFORE);
      expect(element(html, "p", "edit-needs-key")).toBe(NOTE_BEFORE);
      expect(element(html, "textarea", "edit-generate-prompt")).toBe(PROMPT_BEFORE);
      expect(html).not.toContain("aria-describedby");
      expect(html).not.toContain("needs-key-note");
    });
  });

  describe("what EditStudio does with the same signal", () => {
    const studio = source("components/edit-studio.tsx");

    it("hands it to the recipe list", () => {
      const start = studio.indexOf("<EditRecipesPanel");
      expect(studio.slice(start, studio.indexOf("/>", start))).toContain("needsKey={hostedNeedsKey}");
    });

    it("refuses to call the agent at all while it holds, whichever door asked", () => {
      const start = studio.indexOf("async function sendAgent(text: string) {");
      expect(start).toBeGreaterThan(-1);
      expect(studio.slice(start, studio.indexOf("agentAbort.current?.abort();", start))).toContain(
        "if (!project || hostedNeedsKey) {",
      );
    });
  });

  it("uses catalog sentences only, so nothing new is untranslated", () => {
    const common = (locale: string) =>
      JSON.parse(source(`locales/${locale}/common.json`)) as { needsKey: { blocked: string } };
    expect(common("en").needsKey.blocked).toBe("Add your key in {settings} to use this.");
    expect(common("id").needsKey.blocked).toBeTruthy();
    expect(common("id").needsKey.blocked).not.toBe(common("en").needsKey.blocked);
  });
});

describe("the ffmpeg notice with no setup hint (the hosted server omits it)", () => {
  const NO_SETUP: EditDoctor = { ffmpeg: { found: false, reason: "exec_failed", version: null } };
  const render = (variant?: "compact" | "full") =>
    renderToStaticMarkup(<FfmpegSetupNotice doctor={NO_SETUP} onDoctor={() => undefined} variant={variant} />);

  it("hosted: the one calm line, in both variants, with no guide, command or button", () => {
    hosted();
    for (const variant of ["compact", "full"] as const) {
      const html = render(variant);
      expect(html, variant).toContain(t("edit.ffmpeg.hostedUnavailable"));
      expect(html, variant).not.toContain("<button");
      expect(html, variant).not.toContain("ffmpeg-install-command");
      expect(html, variant).not.toContain("ffmpeg-setup-steps");
    }
  });

  it("a desk talking to an older host: falls back to generic words and does not throw", () => {
    for (const variant of ["compact", "full"] as const) {
      const html = render(variant);
      expect(html, variant).toContain("install ffmpeg 6 or newer");
      expect(html, variant).toContain("<strong>Setup:</strong>");
      expect(html, variant).not.toContain("ffmpeg-setup-steps");
      expect(html, variant).not.toContain("Install guide");
    }
  });
});

describe("the locale catalogs", () => {
  it("ship the hosted ffmpeg line in both languages, and the Indonesian is its own sentence", () => {
    const load = (locale: string) =>
      JSON.parse(source(`locales/${locale}/edit.json`)) as { ffmpeg: Record<string, string> };
    expect(load("en").ffmpeg.hostedUnavailable).toBeTruthy();
    expect(load("id").ffmpeg.hostedUnavailable).toBeTruthy();
    expect(load("id").ffmpeg.hostedUnavailable).not.toBe(load("en").ffmpeg.hostedUnavailable);
  });
});
