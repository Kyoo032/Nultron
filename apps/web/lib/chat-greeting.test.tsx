import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_IDEAS, ChatGreeting, ChatIdeaChips } from "@/components/chat-greeting";
import { applyLocale, resetLocaleForTests } from "./i18n";
import en from "../locales/en/chat.json";
import id from "../locales/id/chat.json";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const session = readFileSync(join(web, "components", "chat-session.tsx"), "utf8").replace(/\r\n/g, "\n");

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter initialEntries={["/chat"]}>{node}</MemoryRouter>);
}

afterEach(() => resetLocaleForTests());

describe("the default agent's empty chat (owner, 2026-10-21: no character at the top, like a chat)", () => {
  it("is a greeting with the headline and the key status, and no hero or character", () => {
    const html = render(<ChatGreeting />);
    expect(html).toContain('data-testid="chat-empty"');
    expect(html).toContain('data-layout="greeting"');
    expect(html).toMatch(/data-needs-key="(true|false)"/);
    expect(html).toContain('data-testid="chat-key-status"');
    expect(html).toContain(en.empty.headline);
    expect(html).not.toContain('data-testid="chat-hero"');
    expect(html).not.toContain("chat-mascot");
    expect(html).not.toContain('data-testid="chat-hero-mascot"');
  });

  it("says the headline in Indonesian on an id desk", () => {
    applyLocale("id");
    expect(render(<ChatGreeting />)).toContain(id.empty.headline);
  });

  it("offers the four ideas as chips that fill the composer", () => {
    const filled: string[] = [];
    const html = render(<ChatIdeaChips onSuggest={(text) => filled.push(text)} />);
    expect(html).toContain('data-testid="chat-suggestions"');
    expect(html.match(/data-testid="chat-suggestion"/g)).toHaveLength(CHAT_IDEAS.length);
    for (const idea of CHAT_IDEAS) {
      expect(html).toContain(`data-idea="${idea}"`);
      expect(html).toContain(en.empty.ideas[idea].label);
    }
  });

  it("is what chat-session draws for the generalist in the shell, with the ideas under the composer only while empty", () => {
    expect(session).toContain("const greeting = empty && !error && shell?.agent.generalist === true;");
    expect(session).toMatch(/\) : shell \? \(\s*<ChatGreeting \/>/);
    expect(session).toContain("{agentIdReady && greeting ? <ChatIdeaChips onSuggest={setComposerDraft} /> : null}");
    const ledge = session.indexOf('className="chat-composer-ledge"');
    const chips = session.indexOf("<ChatIdeaChips");
    expect(ledge).toBeGreaterThan(-1);
    expect(chips).toBeGreaterThan(ledge);
  });
});
