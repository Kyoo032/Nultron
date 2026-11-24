import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(web, "..", "..");
const read = (relative: string, root: string = web) => readFileSync(join(root, relative), "utf8").replace(/\r\n/g, "\n");

const app = read("src/App.tsx");

describe("the callback reaches the screen only for a signed-in person on the hosted build", () => {
  it("derives who may be offered it from the hosted marker and the session, in one place", () => {
    expect(app).toContain("const hosted = isHostedBuild();");
    expect(app).toContain("const canLater = canOfferKeyLater(hosted, session.status);");
  });

  it("hands the screen no callback at all otherwise", () => {
    const screen = app.slice(app.indexOf("<OnboardingScreen"), app.indexOf("</PlanBlockBoundary>", app.indexOf("<OnboardingScreen")));
    expect(screen).toMatch(/onLater=\{\s*canLater\s*\?[\s\S]*:\s*undefined\s*\}/);
  });

  it("tells the host only from that callback", () => {
    expect(app.match(/recordKeyLater\(\)/g)).toHaveLength(1);
    const screen = app.slice(app.indexOf("<OnboardingScreen"), app.indexOf("</PlanBlockBoundary>", app.indexOf("<OnboardingScreen")));
    expect(screen).toContain("void recordKeyLater();");
  });

  it("finishes onboarding through onDone, going straight into Chat", () => {
    const screen = read("components/onboarding-screen.tsx");
    expect(screen).toMatch(/function later\(\) \{[\s\S]*?onLater\(\);\s*onDone\(\);/);
  });
});

describe("every gate decision in the app carries the deferral, and the Personal calls carry none", () => {
  it("resolves the gate with the deferral on both paths, and with the hosted marker defaulted", () => {
    const calls = app.match(/resolveGate\([^;]*\);/g) ?? [];
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatch(/resolveGate\(reported, false, undefined, (deferral|deferralRef\.current)\)/);
    }
  });

  it("builds that deferral empty off the hosted build", () => {
    expect(app).toContain("deferralRef.current = canLater ? { hasSession: true, later: keyLater } : NO_KEY_DEFERRAL;");
    expect(app).toContain("const read = deskDeferral(hosted, session.status, payload);");
  });
});

describe("a pane that gained the hook makes no request of its own off the hosted build", () => {
  const hook = read("lib/use-desk-needs-key.ts");

  it("answers false and skips the settings read unless the build is hosted or the pane already had the hook", () => {
    expect(hook).toContain("const active = hosted || !options.hostedOnly;");
    expect(hook).toMatch(/useEffect\(\(\) => \{\s*if \(!active\) return;/);
    expect(hook).toContain("return active && resolveNeedsKey(hosted, own, shared);");
    expect(hook).toContain("return useDeskNeedsKey({ hostedOnly: true });");
  });

  it("is the only hook the panes that are new to it call", () => {
    for (const file of [
      "components/research-studio.tsx",
      "components/data-studio.tsx",
      "components/finance-studio.tsx",
      "components/market-studio.tsx",
      "components/legal-studio.tsx",
      "components/meeting-studio.tsx",
      "components/presentations-studio.tsx",
      "components/knowledge-page.tsx",
      "components/videos-studio.tsx",
      "components/music-studio.tsx",
      "components/chat-session.tsx",
      "components/edit-studio.tsx",
    ]) {
      const source = read(file);
      expect(source, file).toContain("useHostedNeedsKey()");
      expect(source, file).not.toMatch(/useDeskNeedsKey\(/);
    }
  });
});

describe("a studio hides only the refused-for-no-key banner, never every error while the key is missing", () => {
  const STUDIOS = [
    "components/research-studio.tsx",
    "components/data-studio.tsx",
    "components/finance-studio-view.tsx",
    "components/market-studio.tsx",
    "components/legal-studio.tsx",
    "components/meeting-studio.tsx",
    "components/presentations-studio.tsx",
    "components/knowledge-page.tsx",
    "components/videos-studio.tsx",
    "components/music-studio.tsx",
    "components/documents-studio.tsx",
    "components/images-studio.tsx",
    "components/edit-studio.tsx",
  ];

  it("keys every error banner on the sentence, not on the key being missing", () => {
    for (const file of STUDIOS) {
      const source = read(file);
      expect(source, file).toContain("isGatewayBlockedText(");
      expect(source, file).not.toMatch(/&& !(needsKey|keyMissing|keyBlocked) \?/);
    }
  });

  it("maps the hosted 403 to that sentence where a studio reads a refused model call", () => {
    for (const file of [
      "components/documents-studio.tsx",
      "components/presentations-studio.tsx",
      "lib/meeting-request.ts",
      "components/images-studio.tsx",
      "components/videos-studio.tsx",
      "components/knowledge-page.tsx",
      "lib/music-models.ts",
      "lib/job-stream.ts",
      "components/chat-composer.tsx",
      "components/edit-studio.tsx",
    ]) {
      expect(read(file), file).toMatch(/messageUnlessBlocked|hostedGatewayBlocked/);
    }
  });
});

describe("a choice made this session outlives a re-read that lands first, and a pasted key reaches every pane", () => {
  it("remembers the choice in a ref the boot effect honours", () => {
    expect(app).toContain("const choseLaterRef = useRef(false);");
    expect(app).toContain("read.hasSession && choseLaterRef.current");
    expect(app).toContain("choseLaterRef.current = true;");
  });

  it("publishes the gate onboarding just got, hosted only inside", () => {
    expect(read("components/onboarding-screen.tsx")).toMatch(/function applyGate[\s\S]*?publishGate\(next\);/);
  });
});

describe("the only way in on the host is the Enterprise route", () => {
  it("registers exactly one write route for it, and nothing else in the renderer posts to it", () => {
    expect(read("packages/host/src/router.ts", repo)).toContain(
      'compile("POST", "/api/v1/settings/key-later", handlePostKeyLater)',
    );
    expect(read("lib/key-later.ts")).toContain('"/api/v1/settings/key-later"');
    for (const file of ["lib/guide-store.ts", "lib/api-client.ts", "components/settings-page.tsx"]) {
      expect(read(file), file).not.toContain("key-later");
    }
  });

  it("answers 404 off server mode and is never behind the gateway gate", () => {
    const handler = read("packages/host/src/handlers/key-later.ts", repo);
    expect(handler).toContain('throw new ApiError("not_found", "Not found", 404);');
    expect(handler).not.toContain("requireGatewayAllowed");
  });
});
