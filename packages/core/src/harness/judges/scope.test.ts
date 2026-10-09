import { describe, expect, it } from "vitest";
import { scopeHits } from "./scope";

const kinds = (text: string, sources: readonly string[] = []) => scopeHits(text, sources).map((hit) => hit.kind);
const phrases = (text: string, sources: readonly string[] = []) => scopeHits(text, sources).map((hit) => hit.text);

describe("scopeHits: advice, English", () => {
  it.each([
    "You should terminate the contract before March.",
    "The client must renegotiate clause 5.",
    "The Client ought to ask for a cap on liability.",
    "We recommend signing only after the cap is fixed.",
    "We advise that you reject this draft.",
    "We suggest a second review.",
    "You need to get a lawyer's view first.",
    "I recommend that you do not sign.",
  ])("flags: %s", (sentence) => {
    expect(kinds(sentence)).toEqual(["advice"]);
  });

  it("returns the phrase, where it was, and the sentence around it", () => {
    const text = "The cap is Rp 1.000.000. You should negotiate it. Then wait.";
    const [hit] = scopeHits(text, []);
    expect(hit).toMatchObject({ kind: "advice", text: "You should", sentence: "You should negotiate it." });
    expect(text.slice(hit?.index, (hit?.index ?? 0) + (hit?.text.length ?? 0))).toBe("You should");
  });
});

describe("scopeHits: advice, Indonesian", () => {
  it.each([
    "Sebaiknya Anda menegosiasikan ulang klausul ini.",
    "Disarankan untuk menolak draf ini.",
    "Kami sarankan agar batas tanggung jawab ditetapkan.",
    "Kami menyarankan peninjauan kedua.",
    "Anda harus menandatangani sebelum Maret.",
    "Anda perlu meminta pendapat ahli hukum.",
    "Anda sebaiknya menolak.",
  ])("flags: %s", (sentence) => {
    expect(kinds(sentence)).toEqual(["advice"]);
  });
});

describe("scopeHits: sentences that must not be flagged", () => {
  it.each([
    "The Supplier shall deliver the Goods within thirty days.",
    "Payment must be made by the Buyer within 30 days.",
    "The contract states that the Client must pay within 30 days.",
    "Clause 5 provides that you should give notice in writing.",
    "Under clause 5, the Client must give 60 days notice.",
    "According to the Agreement the client should keep records.",
    'The clause reads: "You should notify us within 5 days".',
    "The recommended retail price is Rp 5.000.",
    "Kontrak menyatakan bahwa Anda harus membayar dalam 30 hari.",
    "Pasal 5 menyebutkan Penyedia harus menyerahkan barang.",
    "Harga yang disarankan produsen adalah Rp 5.000.",
    "Penyedia wajib menyerahkan laporan.",
    "Party A should not exceed the cap.",
    "",
  ])("passes: %s", (sentence) => {
    expect(kinds(sentence)).toEqual([]);
  });

  it("passes a sentence copied from a source", () => {
    const source = "You must keep records for five years after the end of the Term.";
    expect(kinds("You must keep records for five years after the end of the Term.", [source])).toEqual([]);
    expect(kinds("You must keep records for six years after the end of the Term.", [source])).toEqual(["advice"]);
  });

  it("matches a copied sentence through line breaks and curly quotes", () => {
    const source = "You must keep\nrecords for “five” years.";
    expect(kinds('You must keep records for "five" years.', [source])).toEqual([]);
  });
});

describe("scopeHits: statute citations outside the sources", () => {
  it("flags an Indonesian statute that no source cites", () => {
    expect(phrases("Under UU No. 11 Tahun 2020 the parties may agree.")).toEqual(["UU No. 11 Tahun 2020"]);
    expect(kinds("Under UU No. 11 Tahun 2020 the parties may agree.")).toEqual(["citation"]);
  });

  it("passes it when a source cites the same statute in another form", () => {
    expect(
      kinds("Under UU No. 11 Tahun 2020 the parties may agree.", ["sesuai Undang-Undang Nomor 11 Tahun 2020"]),
    ).toEqual([]);
    expect(kinds("UU Nomor 11/2020", ["UU No. 11 Tahun 2020 tentang Cipta Kerja"])).toEqual([]);
  });

  it("does not mistake a different statute with the same number", () => {
    expect(kinds("PP No. 35 Tahun 2021", ["UU No. 35 Tahun 2021"])).toEqual(["citation"]);
  });

  it("flags a Civil Code article that no source cites, in any spelling", () => {
    expect(kinds("Pasal 1320 KUHPerdata sets four conditions.")).toEqual(["citation"]);
    expect(kinds("Pasal 1320 KUH Perdata sets four conditions.", ["Pasal 1320 KUHPerdata"])).toEqual([]);
    expect(kinds("Pasal 1320 Kitab Undang-Undang Hukum Perdata", ["Pasal 1320 KUHPerdata"])).toEqual([]);
    expect(kinds("Pasal 1338 KUHPerdata", ["Pasal 1320 KUHPerdata"])).toEqual(["citation"]);
  });

  it("does not flag an article of the document itself", () => {
    expect(kinds("Pasal 5 ayat 2 mengatur pembayaran.")).toEqual([]);
    expect(kinds("Section 12.3 and Clause 4 apply.")).toEqual([]);
  });

  it("flags a US code citation that no source cites", () => {
    expect(kinds("Liability arises under 42 U.S.C. § 1983.")).toEqual(["citation"]);
    expect(kinds("Liability arises under 42 U.S.C. § 1983.", ["claims under 42 USC 1983"])).toEqual([]);
  });

  it("flags a named statute with no number", () => {
    expect(kinds("The UU ITE applies to this e-signature.")).toEqual(["citation"]);
    expect(kinds("The UU ITE applies to this e-signature.", ["menurut UU ITE"])).toEqual([]);
  });

  it("flags each uncited citation once per place it appears, in order", () => {
    const hits = scopeHits("UU No. 11 Tahun 2020 and Pasal 1320 KUHPerdata", []);
    expect(hits.map((hit) => hit.text)).toEqual(["UU No. 11 Tahun 2020", "Pasal 1320 KUHPerdata"]);
    expect(hits[0]?.index).toBeLessThan(hits[1]?.index ?? 0);
  });
});

describe("scopeHits: inputs", () => {
  it("takes sources as strings or as objects with text", () => {
    const text = "Under UU No. 11 Tahun 2020 the parties may agree.";
    expect(kinds(text, [])).toEqual(["citation"]);
    expect(scopeHits(text, [{ text: "UU No. 11 Tahun 2020" }])).toEqual([]);
    expect(scopeHits(text, [{ id: "S1", text: "UU No. 11 Tahun 2020" }])).toEqual([]);
  });

  it("returns both kinds in the order they occur", () => {
    const hits = scopeHits("You should read Pasal 1320 KUHPerdata.", []);
    expect(hits.map((hit) => hit.kind)).toEqual(["advice", "citation"]);
  });
});
