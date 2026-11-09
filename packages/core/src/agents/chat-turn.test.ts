import { describe, expect, it } from "vitest";
import { chatTurnCopy, stepLimitNote } from "./chat-locale";
import { bindingsForChatModality, repairUnresolvedCites, settleChatTurn } from "./chat-turn";

describe("Chat turn check", () => {
  it("drops a source number the desk did not offer and keeps one it did", () => {
    expect(repairUnresolvedCites("From the desk [1] [99].", 1, "en")).toBe("From the desk [1].");
  });

  it("says the desk had no such source when every marker was invented", () => {
    expect(repairUnresolvedCites("See [9].", 0, "en")).toBe("See.\n\nThis desk did not have a source for that.");
    expect(repairUnresolvedCites("Lihat [9].", 0, "id")).toContain("Meja kerja ini tidak memiliki sumber untuk itu.");
  });

  it("leaves a marker inside a fence", () => {
    const text = "Before [1].\n```\n[99]\n```\nAfter.";
    expect(repairUnresolvedCites(text, 1, "en")).toBe(text);
  });

  it("writes the tool result when the reply has no sentence", () => {
    const settled = settleChatTurn({
      text: "",
      offeredSources: 0,
      locale: "en",
      tools: [
        {
          toolKey: "calculator",
          status: "completed",
          input: { expression: "2 + 3" },
          output: { result: 5 },
        },
      ],
    });
    expect(settled.text).toBe("2 + 3 = 5");
    expect(settled.appended).toBe("2 + 3 = 5");
  });

  it("names an earlier chat from the tool, in Bahasa Indonesia", () => {
    const settled = settleChatTurn({
      text: "   ",
      offeredSources: 0,
      locale: "id",
      tools: [
        {
          toolKey: "past_sessions",
          status: "completed",
          output: { success: true, sessions: [{ title: "Budget decision" }] },
        },
      ],
    });
    expect(settled.text).toBe('Obrolan sebelumnya berjudul "Budget decision".');
  });

  describe("a run that ended at its step limit", () => {
    const calculator = {
      toolKey: "calculator",
      status: "completed",
      input: { expression: "2 + 3" },
      output: { result: 5 },
    } as const;

    it("tells the person the steps ran out, in English, when the run left no words", () => {
      const settled = settleChatTurn({ text: "", offeredSources: 0, locale: "en", tools: [], stepLimit: true });
      const note = stepLimitNote("en", []);
      expect(note).toMatch(/no tool finished/i);
      expect(note).toMatch(/answer didn't/i);
      expect(note).toMatch(/continue/i);
      expect(settled.text).toBe(note);
      expect(settled.appended).toBe(note);
      expect(settled.stepLimit).toEqual({ tools: [] });
    });

    it("says it in Bahasa Indonesia too", () => {
      const settled = settleChatTurn({ text: "", offeredSources: 0, locale: "id", tools: [], stepLimit: true });
      expect(settled.text).toBe(stepLimitNote("id", []));
      expect(settled.text).toMatch(/melanjutkan/);
      expect(settled.text).toMatch(/jawabannya belum/);
      expect(settled.text).not.toBe(stepLimitNote("en", []));
      expect(settled.stepLimit).toEqual({ tools: [] });
    });

    it("names the tools that finished, and not one that only started, in both languages", () => {
      const tools = [
        { toolKey: "list_files", status: "completed" as const, output: { ok: true } },
        { toolKey: "read_file", status: "started" as const },
        { toolKey: "web_search", status: "completed" as const, output: { results: [] } },
        { toolKey: "list_files", status: "completed" as const, output: { ok: true } },
      ];
      const en = settleChatTurn({ text: "", offeredSources: 0, locale: "en", tools, stepLimit: true });
      expect(en.stepLimit).toEqual({ tools: ["list_files", "web_search"] });
      expect(en.text).toBe(stepLimitNote("en", ["list_files", "web_search"]));
      expect(en.text).toMatch(/list_files and web_search finished/i);
      expect(en.text).toMatch(/answer didn't/i);
      expect(en.text).not.toContain("read_file");
      const id = settleChatTurn({ text: "", offeredSources: 0, locale: "id", tools, stepLimit: true });
      expect(id.text).toBe(
        "list_files dan web_search sudah selesai, tetapi jawabannya belum. Minta saya melanjutkan, dan saya akan meneruskan dari titik terakhir.",
      );
      expect(id.text).not.toMatch(/answer didn't/i);
      expect(id.stepLimit).toEqual({ tools: ["list_files", "web_search"] });
    });

    it("lists three finished tools with a comma and the joining word", () => {
      const tools = ["list_files", "read_file", "web_search"].map((toolKey) => ({
        toolKey,
        status: "completed" as const,
      }));
      const settled = settleChatTurn({ text: "", offeredSources: 0, locale: "en", tools, stepLimit: true });
      expect(settled.text.startsWith("list_files, read_file and web_search finished")).toBe(true);
      expect(settled.stepLimit).toEqual({ tools: ["list_files", "read_file", "web_search"] });
    });

    it("puts it after words the model wrote earlier in the run, and streams only the new part", () => {
      const settled = settleChatTurn({
        text: "Let me look at the files.",
        offeredSources: 0,
        locale: "en",
        tools: [],
        stepLimit: true,
      });
      const note = stepLimitNote("en", []);
      expect(settled.text).toBe(`Let me look at the files.\n\n${note}`);
      expect(settled.appended).toBe(`\n\n${note}`);
    });

    it("keeps the sentence a finished tool already earned, then adds the note", () => {
      const settled = settleChatTurn({
        text: "",
        offeredSources: 0,
        locale: "en",
        tools: [calculator],
        stepLimit: true,
      });
      const note = stepLimitNote("en", ["calculator"]);
      expect(note).toMatch(/calculator finished/i);
      expect(settled.text).toBe(`2 + 3 = 5\n\n${note}`);
      expect(settled.appended).toBe(`2 + 3 = 5\n\n${note}`);
      expect(settled.stepLimit).toEqual({ tools: ["calculator"] });
    });

    it("does not add it twice, and still marks the turn", () => {
      const note = stepLimitNote("en", []);
      const settled = settleChatTurn({ text: note, offeredSources: 0, locale: "en", tools: [], stepLimit: true });
      expect(settled.text).toBe(note);
      expect(settled.appended).toBe("");
      expect(settled.stepLimit).toEqual({ tools: [] });
    });

    it("does not mark a turn whose words merely contain the sentence", () => {
      const note = stepLimitNote("en", ["list_files"]);
      const settled = settleChatTurn({
        text: note,
        offeredSources: 0,
        locale: "en",
        tools: [{ toolKey: "list_files", status: "completed" }],
        stepLimit: false,
      });
      expect(settled.text).toBe(note);
      expect(settled.stepLimit).toBeUndefined();
    });

    it("keeps the mark when an interruption is also recorded", () => {
      const settled = settleChatTurn({
        text: "",
        offeredSources: 0,
        locale: "en",
        tools: [{ toolKey: "list_files", status: "completed" }],
        stepLimit: true,
        interrupted: "gateway down",
      });
      expect(settled.stepLimit).toEqual({ tools: ["list_files"] });
      expect(settled.text).toContain("list_files finished");
      expect(settled.text).toContain("gateway down");
    });

    it("adds nothing when the run did not end at the limit", () => {
      expect(settleChatTurn({ text: "", offeredSources: 0, locale: "en", tools: [] }).text).toBe("");
      expect(settleChatTurn({ text: "", offeredSources: 0, locale: "en", tools: [] }).stepLimit).toBeUndefined();
      expect(settleChatTurn({ text: "Hi.", offeredSources: 0, locale: "en", tools: [], stepLimit: false }).text).toBe(
        "Hi.",
      );
    });
  });

  describe("a run that ended because the model call failed after a tool completed", () => {
    const reason = "The gateway is unavailable right now. Send again in a moment.";
    const calculator = {
      toolKey: "calculator",
      status: "completed",
      input: { expression: "2 + 3" },
      output: { result: 5 },
    } as const;

    it("says the tools ran, why the answer did not come, and that the person can send continue", () => {
      const settled = settleChatTurn({ text: "", offeredSources: 0, locale: "en", tools: [], interrupted: reason });
      const note = chatTurnCopy("en").interrupted;
      expect(note).toMatch(/tool steps above ran/i);
      expect(note).toMatch(/continue/i);
      expect(settled.text).toContain(reason);
      expect(settled.text).toBe(note.replaceAll("{reason}", reason));
      expect(settled.appended).toBe(settled.text);
    });

    it("says it in Bahasa Indonesia too, with the reason it was given", () => {
      const idReason = "Gateway sedang tidak tersedia. Coba kirim lagi sebentar lagi.";
      const settled = settleChatTurn({ text: "", offeredSources: 0, locale: "id", tools: [], interrupted: idReason });
      expect(settled.text).toContain(idReason);
      expect(settled.text).toMatch(/lanjutkan/);
      expect(settled.text).toMatch(/Langkah-langkah alat di atas/);
      expect(settled.text).not.toMatch(/tool steps above/i);
    });

    it("puts it after words the model wrote earlier in the run, and streams only the new part", () => {
      const settled = settleChatTurn({
        text: "Let me read the file.",
        offeredSources: 0,
        locale: "en",
        tools: [],
        interrupted: reason,
      });
      const note = chatTurnCopy("en").interrupted.replaceAll("{reason}", reason);
      expect(settled.text).toBe(`Let me read the file.\n\n${note}`);
      expect(settled.appended).toBe(`\n\n${note}`);
    });

    it("keeps the sentence a finished tool already earned, then adds the note", () => {
      const settled = settleChatTurn({
        text: "",
        offeredSources: 0,
        locale: "en",
        tools: [calculator],
        interrupted: reason,
      });
      expect(settled.text.startsWith("2 + 3 = 5\n\n")).toBe(true);
      expect(settled.text).toContain(reason);
    });

    it("does not add it twice", () => {
      const note = chatTurnCopy("en").interrupted.replaceAll("{reason}", reason);
      const settled = settleChatTurn({ text: note, offeredSources: 0, locale: "en", tools: [], interrupted: reason });
      expect(settled.text).toBe(note);
      expect(settled.appended).toBe("");
    });

    it("adds nothing when the run was not interrupted", () => {
      expect(settleChatTurn({ text: "Hi.", offeredSources: 0, locale: "en", tools: [] }).text).toBe("Hi.");
      expect(settleChatTurn({ text: "Hi.", offeredSources: 0, locale: "en", tools: [], interrupted: "" }).text).toBe(
        "Hi.",
      );
    });
  });

  it("does not offer generate tools on an understand turn", () => {
    const bindings = [
      { toolKey: "calculator" },
      { toolKey: "image_generate" },
      { toolKey: "video_generate" },
      { toolKey: "past_sessions" },
    ];
    expect(bindingsForChatModality(bindings, "text").map((binding) => binding.toolKey)).toEqual([
      "calculator",
      "image_generate",
      "video_generate",
      "past_sessions",
    ]);
    expect(bindingsForChatModality(bindings, "image").map((binding) => binding.toolKey)).toEqual([
      "calculator",
      "past_sessions",
    ]);
    expect(bindingsForChatModality(bindings, "video").map((binding) => binding.toolKey)).toEqual([
      "calculator",
      "past_sessions",
    ]);
  });
});
