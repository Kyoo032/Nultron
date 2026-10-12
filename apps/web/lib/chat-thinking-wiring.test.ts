import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Where Chat's Thinking level went, pinned against the sources.
 *
 * It used to be the person's: a select in the composer, a stored pick, and `thinkingRequestFields`
 * putting `thinking` and `reasoningEffort` in the run body once the person had chosen a level. In the
 * tester code the tier decides it (Fastest is Off, Reasoning is Deep, Daily is the model's default, model
 * tiers spec section 1), the host reads it off the tier, and the renderer posts neither field. The pane
 * and the composer are JSX with hooks and this package's vitest run is node-only, so the wiring is pinned
 * as text. `chat-thinking.ts` and its own test stay in the tree, unread by the renderer: the published
 * code still uses the module, and deleting it here would conflict at every sync.
 */
const web = join(dirname(fileURLToPath(import.meta.url)), "..");

function source(relative: string): string {
  return readFileSync(join(web, relative), "utf8").replace(/\r\n/g, "\n");
}

const composer = source("components/chat-composer.tsx");
const session = source("components/chat-session.tsx");

describe("the composer's run requests", () => {
  it("builds no Thinking fields, because the host reads Thinking off the tier", () => {
    expect(composer).not.toContain("thinkingRequestFields");
    expect(composer).not.toContain("reasoningEffortChosen");
    expect(composer).not.toMatch(/thinking:\s/);
    expect(composer).not.toMatch(/^\s*reasoningEffort,\s*$/m);
  });

  it("draws no picker for the level", () => {
    expect(composer).not.toContain("value={reasoningEffort}");
    expect(composer).not.toContain('data-testid="reasoning-effort"');
    expect(composer).not.toContain("REASONING_EFFORTS");
  });
});

describe("the chat pane", () => {
  it("keeps no Thinking level of its own and stores none", () => {
    expect(session).not.toContain("useState<ReasoningEffort>");
    expect(session).not.toContain("DEFAULT_THINKING_PREF");
    expect(session).not.toContain("setReasoningChosen");
    expect(session).not.toContain("writeThinkingPref");
    expect(session).not.toContain("reasoningEffortChosen=");
  });

  it("gives the reply's Thinking row the tier's answer instead", () => {
    expect(session).toContain("thinkingEnabled: tierThinkingEnabled(tierId)");
  });
});
