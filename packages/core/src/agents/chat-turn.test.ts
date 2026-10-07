import { describe, expect, it } from "vitest";
import { chatTurnCopy } from "./chat-locale";
import { bindingsForChatModality, repairUnresolvedCites, settleChatTurn } from "./chat-turn";

describe("Chat turn check", () => {
  it("drops a source number the desk did not offer and keeps one it did", () => {
    expect(repairUnresolvedCites("From the desk [1] [99].", 1, "en")).toBe("From the desk [1].");
  });

  it("says the desk had no such source when every marker was invented", () => {
    expect(repairUnresolvedCites("See [9].", 0, "en")).toBe("See.\n\nThis desk did not have a source for that.");
    expect(repairUnresolvedCites("Lihat [9].", 0, "id")).toContain("Meja ini tidak punya sumber untuk itu.");
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
    expect(settled.text).toBe('Percakapan sebelumnya berjudul "Budget decision".');
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
      const note = chatTurnCopy("en").stepLimit;
      expect(note).toMatch(/ran out of steps/i);
      expect(note).toMatch(/continue/i);
      expect(settled.text).toBe(note);
      expect(settled.appended).toBe(note);
    });

    it("says it in Bahasa Indonesia too", () => {
      const settled = settleChatTurn({ text: "", offeredSources: 0, locale: "id", tools: [], stepLimit: true });
      expect(settled.text).toBe(chatTurnCopy("id").stepLimit);
      expect(settled.text).toMatch(/melanjutkan/);
      expect(settled.text).not.toBe(chatTurnCopy("en").stepLimit);
    });

    it("puts it after words the model wrote earlier in the run, and streams only the new part", () => {
      const settled = settleChatTurn({
        text: "Let me look at the files.",
        offeredSources: 0,
        locale: "en",
        tools: [],
        stepLimit: true,
      });
      const note = chatTurnCopy("en").stepLimit;
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
      const note = chatTurnCopy("en").stepLimit;
      expect(settled.text).toBe(`2 + 3 = 5\n\n${note}`);
      expect(settled.appended).toBe(`2 + 3 = 5\n\n${note}`);
    });

    it("does not add it twice", () => {
      const note = chatTurnCopy("en").stepLimit;
      const settled = settleChatTurn({ text: note, offeredSources: 0, locale: "en", tools: [], stepLimit: true });
      expect(settled.text).toBe(note);
      expect(settled.appended).toBe("");
    });

    it("adds nothing when the run did not end at the limit", () => {
      expect(settleChatTurn({ text: "", offeredSources: 0, locale: "en", tools: [] }).text).toBe("");
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
      expect(settled.text).toMatch(/Langkah alat di atas/);
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
