/**
 * Where the stand-in notice is kept and drawn, pinned against the sources.
 *
 * The pane is JSX with hooks and this package's vitest run is node-only, so the placement is pinned as text,
 * the way `chat-run-scope-wiring.test.ts` pins the session gate. The reader that feeds it is driven in
 * `chat-run-stream.test.ts`, and the sentence in `chat-model-fallback-notice.test.tsx`.
 *
 * The rules: the notice belongs to the turn on screen. It is kept after the turn lands (so the owner still
 * sees it under the reply), it is cleared by the next send and when the pane changes thread, and a failed
 * send does not show it. A stand-in frame from a run that is no longer the newest one is ignored.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Line endings are Biome's business, not this test's: every source is read with LF. */
function source(relative: string): string {
  return readFileSync(join(web, relative), "utf8").replace(/\r\n/g, "\n");
}

const chatSession = source("components/chat-session.tsx");
const composer = source("components/chat-composer.tsx");

/** The text of one block of the source, from its start marker up to the next marker. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from, `start marker not found: ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `end marker not found: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("stand-in notice in the composer", () => {
  it("hands the frame to the pane only while the run is the newest one", () => {
    const live = between(composer, "const live: RunStreamHandlers = {", "setBusy(true);");
    expect(live).toMatch(
      /onModelFallback: \(event\) => \{\n\s*if \(!isCurrentRun\(\)\) \{\n\s*return;\n\s*\}\n\s*onModelFallback\?\.\(event\);\n\s*\}/,
    );
  });
});

describe("stand-in notice in the pane", () => {
  it("is held by the session, not by the live turn that is thrown away when the reply lands", () => {
    expect(chatSession).toContain("const [fallback, setFallback] = useState<ModelFallbackNotice | null>(null);");
    expect(chatSession).toContain("onModelFallback={(event) => setFallback((held) => nextModelFallback(held, event))}");
  });

  it("is cleared by the next send and when the pane changes thread", () => {
    const onUserSend = between(chatSession, "onUserSend={(payload) => {", "onStarted={");
    expect(onUserSend).toContain("setFallback(null);");
    const reset = between(chatSession, "function resetLive() {", "async function ensureThread()");
    expect(reset).toContain("setFallback(null);");
  });

  it("is drawn inside the message list, after the live turn, and not for a failed send", () => {
    const list = between(chatSession, 'data-testid="message-list"', 'className="chat-composer-ledge"');
    expect(list).toContain("{fallback && !sendFailed ? <ChatModelFallbackNotice notice={fallback} /> : null}");
    const liveIndex = list.indexOf('data-testid="assistant-live"');
    const noticeIndex = list.indexOf("<ChatModelFallbackNotice");
    expect(liveIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeGreaterThan(liveIndex);
  });
});
