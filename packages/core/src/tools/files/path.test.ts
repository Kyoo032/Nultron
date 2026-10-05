import { describe, expect, it } from "vitest";
import { parseDeskPath } from "./path";

describe("parseDeskPath", () => {
  it.each([
    "plan.md",
    "notes/plan.md",
    "a/b/c/d/e/f/g/h",
    "notes/.hidden",
    "docs/2026-10-03 meeting notes.md",
    "catatan/rencana-proyek.md",
    "日本語/メモ.md",
    "console.md",
    "COM0",
    "comet.txt",
    "a".repeat(120),
    `${"a".repeat(120)}/${"b".repeat(119)}`,
  ])("accepts %s", (raw) => {
    expect(parseDeskPath(raw)).toBe(raw);
  });

  it.each([
    ["", "The path is empty. Give a path from the top, like notes/plan.md."],
    ["/etc/passwd", "The path must start at the top of the files, with no leading /."],
    ["notes\\plan.md", "Use / between folders, not a backslash."],
    ["C:/Users/x.txt", "Drive letters are not allowed. Give a path from the top, like notes/plan.md."],
    ["c:", "Drive letters are not allowed. Give a path from the top, like notes/plan.md."],
    ["../secret.md", "Parts named . or .. are not allowed. Use a path from the top, like notes/plan.md."],
    ["notes/../secret.md", "Parts named . or .. are not allowed. Use a path from the top, like notes/plan.md."],
    ["./plan.md", "Parts named . or .. are not allowed. Use a path from the top, like notes/plan.md."],
    ["notes/./plan.md", "Parts named . or .. are not allowed. Use a path from the top, like notes/plan.md."],
    ["notes//plan.md", "The path has an empty part (a doubled or trailing /)."],
    ["notes/", "The path has an empty part (a doubled or trailing /)."],
    ["a\u0000b", "The path contains a control character."],
    ["a\nb", "The path contains a control character."],
    ["a\tb", "The path contains a control character."],
    ["a\u007fb", "The path contains a control character."],
    ["a\u0085b", "The path contains a control character."],
    ["evil\u202egnp.exe", "The path contains a control character."],
    ["a/b/c/d/e/f/g/h/i", "The path has more than 8 parts (folders plus the file name)."],
    [`${"a".repeat(120)}/${"b".repeat(120)}`, "The path is longer than 240 characters."],
    [`notes/${"a".repeat(121)}`, "A part of the path is longer than 120 characters."],
    ["notes/plan.", "A part of the path ends with a dot or a space."],
    ["notes /plan.md", "A part of the path ends with a dot or a space."],
    ["notes/plan.md ", "A part of the path ends with a dot or a space."],
    ["notes/plan:v2.md", 'A part of the path contains one of < > : " | ? *, which no file name may have.'],
    ["notes/what?.md", 'A part of the path contains one of < > : " | ? *, which no file name may have.'],
    ["notes/*.md", 'A part of the path contains one of < > : " | ? *, which no file name may have.'],
    ["notes/a|b", 'A part of the path contains one of < > : " | ? *, which no file name may have.'],
    ["CON", "A part of the path uses a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)."],
    ["con.txt", "A part of the path uses a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)."],
    ["notes/Prn.tar.gz", "A part of the path uses a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)."],
    ["notes/AUX", "A part of the path uses a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)."],
    ["nul", "A part of the path uses a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)."],
    ["COM1", "A part of the path uses a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)."],
    ["x/com9.log", "A part of the path uses a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)."],
    ["lpt3.txt", "A part of the path uses a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)."],
  ])("refuses %j as bad_path", (raw, message) => {
    expect(parseDeskPath(raw)).toEqual({ ok: false, code: "bad_path", message });
  });

  it("refuses a value that is not a string", () => {
    expect(parseDeskPath(undefined as unknown as string)).toMatchObject({ ok: false, code: "bad_path" });
  });
});
