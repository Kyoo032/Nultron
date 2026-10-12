/**
 * The line under a reply that a stand-in answered (`run.model_fallback`).
 *
 * The notice is a hook-free component, so `renderToStaticMarkup` reads its tree in this node-only vitest run.
 * The sentence is the renderer's own catalog key (`chat.harness.modelFallback`, both languages), built from the
 * two model ids. The host's sentence is only the fallback for a frame that names no models.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ChatModelFallbackNotice, nextModelFallback } from "@/components/chat-model-fallback-notice";
import { applyLocale, resetLocaleForTests } from "./i18n";

afterEach(() => resetLocaleForTests());

describe("ChatModelFallbackNotice", () => {
  it("says which model stood in for which, in English", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(
      <ChatModelFallbackNotice notice={{ from: "gpt-6-luna", to: "glm-5.3", message: "host sentence" }} />,
    );
    expect(html).toContain('data-testid="chat-model-fallback"');
    expect(html).toContain("gpt-6-luna is unavailable; used glm-5.3 for this answer.");
    expect(html).not.toContain("host sentence");
  });

  it("says it in Bahasa Indonesia", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(
      <ChatModelFallbackNotice notice={{ from: "gpt-6-luna", to: "glm-5.3", message: "host sentence" }} />,
    );
    expect(html).toContain("gpt-6-luna tidak tersedia; menggunakan glm-5.3 untuk jawaban ini.");
  });

  it("falls back to the host's sentence when a frame names no models", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(
      <ChatModelFallbackNotice notice={{ from: "", to: "", message: "Host sentence." }} />,
    );
    expect(html).toContain("Host sentence.");
  });

  it("draws nothing when there is no sentence at all", () => {
    expect(renderToStaticMarkup(<ChatModelFallbackNotice notice={{ from: "", to: "", message: "" }} />)).toBe("");
  });
});

describe("nextModelFallback", () => {
  // The host can move twice in one turn: a model skipped before the first try, then a retry mid-turn. The
  // line must keep the model the person picked and name the one that answered last.
  it("keeps the first model and names the last one, for two moves in one turn", () => {
    const first = nextModelFallback(null, { from: "gpt-6-luna", to: "glm-5.3", message: "first sentence" });
    const second = nextModelFallback(first, { from: "glm-5.3", to: "deepseek-v4-flash", message: "second sentence" });
    expect(second).toEqual({ from: "gpt-6-luna", to: "deepseek-v4-flash", message: "second sentence" });
    applyLocale("en");
    const html = renderToStaticMarkup(<ChatModelFallbackNotice notice={second} />);
    expect(html).toContain("gpt-6-luna is unavailable; used deepseek-v4-flash for this answer.");
    expect(html).not.toContain("glm-5.3");
  });

  it("takes the event as it is when nothing is held yet", () => {
    const event = { from: "gpt-6-luna", to: "glm-5.3", message: "first sentence" };
    expect(nextModelFallback(null, event)).toEqual(event);
  });
});
