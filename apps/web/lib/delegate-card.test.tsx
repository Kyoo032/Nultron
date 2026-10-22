/**
 * What an agent got back from another agent: what the result reader takes from a `delegate` call, the card
 * that shows it under the answer, the labels of its Thinking row and the live progress line.
 *
 * The card is rebuilt from the saved tool call alone, so the turn cases pass only what the host stored.
 * The renderer's vitest has no DOM, so a press is read from the markup and the source, as `dossier-card.test.tsx` does.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatTurn } from "@/components/chat-turn";
import { DelegateCard, DelegateCards } from "@/components/chat-delegate-card";
import {
  DELEGATE_TOOL_KEY,
  delegatedAgentOf,
  readDelegateResult,
  type DelegateCardModel,
} from "@/components/tool-rows/delegate-result";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";
import { jobEmbedsFromTools } from "@/lib/message-embeds";
import { toolActivityLabel, toolCallSummary, toolDoneLabel } from "@/lib/tool-labels";
import { virtualAgentHref } from "@/lib/virtual-agents";

const here = dirname(fileURLToPath(import.meta.url));

const INPUT = {
  agent: "research",
  task: "Find three reliable sources on QRIS fees for small shops.\nWrite the answer in Indonesian.",
  context: "The owner sells coffee in Jakarta.",
};
const OUTPUT = {
  ok: true,
  agent: "research",
  thread: { id: "thread-9" },
  summary: "QRIS fees for small shops are capped at 0.3 percent (Bank Indonesia).",
  truncated: false,
  toolsUsed: ["web_search", "web_fetch"],
};

const count = (markup: string, testId: string) => markup.split(`data-testid="${testId}"`).length - 1;
/** The link as it is in markup, where `&` is written `&amp;`. */
const href = (...args: Parameters<typeof virtualAgentHref>) => virtualAgentHref(...args).replaceAll("&", "&amp;");

function model(over: Partial<DelegateCardModel> = {}): DelegateCardModel {
  const read = readDelegateResult(INPUT, OUTPUT);
  if (!read) {
    throw new Error("fixture does not read");
  }
  return { ...read, ...over };
}

function card(props: Partial<Parameters<typeof DelegateCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <DelegateCard model={props.model ?? model()} {...props} />
    </MemoryRouter>,
  );
}

function call(status: "started" | "completed", output: unknown = OUTPUT, key = DELEGATE_TOOL_KEY) {
  return { key, status, input: INPUT, output };
}

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("reading a delegate call", () => {
  it("takes the agent, the conversation, the task headline, the answer and the tools from the call", () => {
    expect(readDelegateResult(INPUT, OUTPUT)).toEqual({
      agent: "research",
      threadId: "thread-9",
      headline: "Find three reliable sources on QRIS fees for small shops.",
      summary: "QRIS fees for small shops are capped at 0.3 percent (Bank Indonesia).",
      truncated: false,
      toolsUsed: ["web_search", "web_fetch"],
      failure: null,
    });
  });

  it("reads an answer that was stored as JSON text", () => {
    expect(readDelegateResult(INPUT, JSON.stringify(OUTPUT))?.threadId).toBe("thread-9");
  });

  it("cuts a long first line to a headline and skips leading blank lines", () => {
    const long = readDelegateResult({ ...INPUT, task: `\n\n${"x".repeat(300)}` }, OUTPUT);
    expect(long?.headline).toHaveLength(120);
    expect(long?.headline.endsWith("…")).toBe(true);
  });

  it("falls back to the call's own agent when the answer does not name one", () => {
    const { agent: _agent, ...bare } = OUTPUT;
    expect(delegatedAgentOf(INPUT, bare)).toBe("research");
    expect(delegatedAgentOf({ agent: "nobody" }, bare)).toBeNull();
    expect(delegatedAgentOf(undefined, undefined)).toBeNull();
  });

  it("keeps a run that stopped, ran out of time or gave no answer, with its conversation to open", () => {
    for (const reason of ["cancelled", "timeout", "no_answer", "failed"] as const) {
      const read = readDelegateResult(INPUT, {
        ok: false,
        reason,
        message: "x",
        agent: "research",
        thread: { id: "thread-9" },
      });
      expect(read, reason).toMatchObject({ failure: reason, threadId: "thread-9", summary: "" });
    }
    // A reason the card does not know is read as a plain failure.
    expect(readDelegateResult(INPUT, { ok: false, reason: "surprise", thread: { id: "t" } })?.failure).toBe("failed");
  });

  it("draws nothing for a refusal before a run started, or for output that is not an answer", () => {
    expect(readDelegateResult(INPUT, { ok: false, reason: "not_hired", message: "no", agent: "research" })).toBeNull();
    expect(readDelegateResult(INPUT, { ok: false, reason: "nested", message: "no" })).toBeNull();
    expect(readDelegateResult(INPUT, { ok: true, agent: "research", summary: "no conversation" })).toBeNull();
    expect(readDelegateResult(INPUT, { agent: "research", thread: { id: "t" } })).toBeNull();
    expect(readDelegateResult(INPUT, undefined)).toBeNull();
    expect(readDelegateResult(INPUT, "plain text")).toBeNull();
  });
});

describe("the delegate card", () => {
  it("names the asked agent, shows the task, the tools and a link to its conversation", () => {
    const html = card();
    expect(html).toContain("Asked the Research agent");
    expect(html).toContain("Find three reliable sources on QRIS fees for small shops.");
    expect(html).not.toContain("Write the answer in Indonesian.");
    expect(html).toContain("Tools used: Web search · Read a web page");
    expect(html).toContain('data-state="answered"');
    expect(html).toContain(`href="${href("research", "thread-9")}"`);
    expect(html).toContain("Open conversation");
  });

  it("keeps the answer closed until Show is pressed, and opens it on request", () => {
    const closed = card();
    expect(closed).toContain('data-testid="chat-delegate-toggle"');
    expect(closed).toContain("Show answer");
    expect(count(closed, "chat-delegate-view")).toBe(0);
    expect(closed).not.toContain("capped at 0.3 percent");

    const open = card({ defaultOpen: true });
    expect(count(open, "chat-delegate-view")).toBe(1);
    expect(open).toContain("capped at 0.3 percent");
    expect(open).toContain("Hide answer");
    expect(open).toContain('aria-expanded="true"');
  });

  it("says how many more tools were used than it names", () => {
    const html = card({ model: model({ toolsUsed: ["web_search", "web_fetch", "read_file", "run_code", "write_file"] }) });
    expect(html).toContain("Tools used: Web search · Read a web page · Read a file · 2 more");
  });

  it("says when the answer is shortened, once it is open", () => {
    expect(count(card({ model: model({ truncated: true }), defaultOpen: true }), "chat-delegate-truncated")).toBe(1);
    expect(count(card({ model: model({ truncated: false }), defaultOpen: true }), "chat-delegate-truncated")).toBe(0);
  });

  it("gives a run that did not answer a plain reason, no Show control, and still links to what it did", () => {
    const failed = model({ summary: "", toolsUsed: [], failure: "timeout" });
    const html = card({ model: failed, defaultOpen: true });
    expect(html).toContain('data-state="failed"');
    expect(html).toContain("Did not finish in time.");
    expect(count(html, "chat-delegate-toggle")).toBe(0);
    expect(count(html, "chat-delegate-view")).toBe(0);
    expect(html).toContain(`href="${href("research", "thread-9")}"`);
  });

  it("speaks Indonesian when the desk does", () => {
    applyLocale("id");
    const html = card({ defaultOpen: true });
    expect(html).toContain("Meminta agen Riset");
    expect(html).toContain("Buka percakapan");
    expect(html).toContain("Sembunyikan jawaban");
  });

  it("draws one card per finished call that started a run, and nothing otherwise", () => {
    const two = renderToStaticMarkup(
      <MemoryRouter>
        <DelegateCards
          tools={[
            call("completed"),
            call("completed", { ...OUTPUT, agent: "presentations", thread: { id: "thread-10" } }),
          ]}
        />
      </MemoryRouter>,
    );
    expect(count(two, "chat-delegate-card")).toBe(2);
    expect(two).toContain('data-agent="presentations"');

    const none = (tools: Parameters<typeof DelegateCards>[0]["tools"]) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <DelegateCards tools={tools} />
        </MemoryRouter>,
      );
    expect(none([call("started")])).toBe("");
    expect(none([call("completed", OUTPUT, "build_deck")])).toBe("");
    expect(none([call("completed", { ok: false, reason: "not_hired", message: "no" })])).toBe("");
  });
});

describe("the delegate call's other surfaces", () => {
  it("is never also drawn as a link or file embed under the answer", () => {
    expect(
      jobEmbedsFromTools([
        { key: DELEGATE_TOOL_KEY, status: "completed", output: { ok: true, url: "https://example.com/a", title: "A" } },
      ]),
    ).toEqual([]);
  });

  it("labels the live and the finished row with the asked agent, not the task and a field count", () => {
    expect(toolActivityLabel(DELEGATE_TOOL_KEY, INPUT)).toBe("Asking another agent");
    expect(toolDoneLabel(DELEGATE_TOOL_KEY)).toBe("Asked another agent");
    expect(toolCallSummary(DELEGATE_TOOL_KEY, INPUT, OUTPUT)).toBe("Asked another agent · Research");
  });

  it("says why a refused call was refused on its row", () => {
    const refused = { ok: false, reason: "not_hired", message: "The Research agent is not on the owner's desk.", agent: "research" };
    const summary = toolCallSummary(DELEGATE_TOOL_KEY, INPUT, refused);
    expect(summary).toContain("Asked another agent · Research · ");
    expect(summary).toContain("not on the owner");
    expect(toolCallSummary(DELEGATE_TOOL_KEY, undefined, undefined)).toBe("Asked another agent");
  });
});

describe("a hand-off inside a Chat turn", () => {
  const saved = [
    { type: "tool_call" as const, toolKey: DELEGATE_TOOL_KEY, status: "completed" as const, input: INPUT, output: OUTPUT },
    { type: "text" as const, text: "Research found three sources." },
  ];

  function turn(content: unknown, live?: Parameters<typeof ChatTurn>[0]["live"]): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <ChatTurn role="assistant" content={content} live={live} />
      </MemoryRouter>,
    );
  }

  it("rebuilds the card from a saved turn, outside the Thinking disclosure", () => {
    const html = turn(saved);
    expect(count(html, "chat-delegate-card")).toBe(1);
    expect(html.indexOf('data-testid="chat-delegate-card"')).toBeGreaterThan(html.indexOf("</details>"));
    expect(html).toContain("Research found three sources.");
    expect(html).not.toContain("message-embed");
  });

  it("labels the Thinking row with the asked agent", () => {
    const html = turn(saved);
    const row = html.slice(html.indexOf('data-testid="message-tool"'), html.indexOf("</details>"));
    expect(row).toContain("Asked another agent · Research");
    expect(row).not.toContain("fields");
  });

  it("shows the asked agent's progress line in the live row while it works, and no card yet", () => {
    const html = turn([], {
      thinking: "",
      streaming: "",
      running: true,
      tools: [{ key: DELEGATE_TOOL_KEY, status: "started", input: INPUT, progress: "Research agent: web search" }],
    });
    expect(html).toContain('data-testid="message-tool-progress"');
    expect(html).toContain("Research agent: web search");
    expect(count(html, "chat-delegate-card")).toBe(0);
  });

  it("shows the card on a live turn once the call has finished", () => {
    const html = turn([], {
      thinking: "",
      streaming: "Done.",
      running: false,
      tools: [{ key: DELEGATE_TOOL_KEY, status: "completed", input: INPUT, output: OUTPUT }],
    });
    expect(count(html, "chat-delegate-card")).toBe(1);
  });
});

describe("the card's copy", () => {
  const read = (locale: "en" | "id") =>
    JSON.parse(readFileSync(join(here, "..", "locales", locale, "agents.json"), "utf8")) as {
      delegate: Record<string, unknown>;
    };

  it("has the same keys in English and Indonesian, every one a non-empty line", () => {
    const flat = (node: Record<string, unknown>, prefix = ""): string[] =>
      Object.entries(node).flatMap(([key, value]) =>
        typeof value === "string"
          ? value.length > 0
            ? [`${prefix}${key}`]
            : [`EMPTY ${prefix}${key}`]
          : flat(value as Record<string, unknown>, `${prefix}${key}.`),
      );
    const en = flat(read("en").delegate).sort();
    expect(en.filter((key) => key.startsWith("EMPTY"))).toEqual([]);
    expect(flat(read("id").delegate).sort()).toEqual(en);
  });
});
