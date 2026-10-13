/**
 * The 2026-10-13 security review of the outbound guard: one block per finding (H1, H2, H3 fail-closed, M1, M2,
 * M5, L1, L3). The original rules are in `outbound-guard.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../tenancy/types";
import { invokeTool } from "../tools/define-tool";
import { runWithToolSecrets } from "../tools/secret-scope";
import { resetKeylessSearchState } from "../tools/platform/keyless-search";
import { webSearchTool } from "../tools/platform/web-search";
import {
  assertSendableUrl,
  createOutboundGuard,
  maskedQueryNote,
  mediaSendRefusal,
  OutboundRefusedError,
  outboundRefusal,
  runInToolCall,
  runOutboundGuarded,
  sendableSearchQuery,
} from "./outbound-guard";
import { readableUrl, urlShapeProblem } from "./outbound-match";

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  role: "member",
};

const PRIVATE_REFUSAL = outboundRefusal("private", "en");

function guard(privateText: string[], userText: string[] = [], extra: { figuresOnlyText?: string[] } = {}) {
  return createOutboundGuard({ userText, privateText, locale: "en", ...extra });
}

describe("M1: figures", () => {
  const notes = () => guard(["Gaji pokok 12.750 per jam, lembur 18.400, akun 7788990011. Mengacu Pasal 365."]);

  it("sends one short private number on its own: an article, a standard, a status code", () => {
    const cites = guard(["Pasal 365 KUHP, ISO 27001, RFC 2616 dan HTTP 404 di catatan."]);
    expect(cites.judgeQuery("Pasal 365 KUHP")).toBeNull();
    expect(cites.judgeQuery("ISO 27001 controls")).toBeNull();
    expect(cites.judgeQuery("RFC 2616 caching")).toBeNull();
    expect(cites.judgeQuery("HTTP 404 meaning")).toBeNull();
  });

  it("refuses two short private numbers in one query", () => {
    expect(notes().judgeQuery("upah 12.750 dan lembur 18.400")).toEqual(PRIVATE_REFUSAL);
  });

  it("refuses a private number of six digits or more on its own", () => {
    expect(notes().judgeQuery("bank 7788990011")).toEqual(PRIVATE_REFUSAL);
  });

  it("does not count a refusal for figures alone toward the stop", () => {
    const run = notes();
    expect(run.judgeQuery("bank 7788990011")).toEqual(PRIVATE_REFUSAL);
    expect(run.judgeQuery("upah 12.750 dan lembur 18.400")).toEqual(PRIVATE_REFUSAL);
    expect(run.judgeQuery("rekening 7788990011")).toEqual(PRIVATE_REFUSAL);
    expect(run.judgeQuery("harga emas hari ini")).toBeNull();
  });
});

describe("M2: spans", () => {
  it("never counts a span made mostly of stopwords", () => {
    const run = guard(["This vendor is one of the most reliable in the region and that is what we will do."]);
    expect(run.judgeQuery("which provider is one of the most reliable")).toBeNull();
    expect(run.judgeQuery("that is what we will do next")).toBeNull();
  });

  it("still refuses a span with three or more meaningful words", () => {
    const run = guard(["Kami akan mengakuisisi pabrik tekstil di Cikarang bulan depan."]);
    expect(run.judgeQuery("mengakuisisi pabrik tekstil di Cikarang")).toEqual(PRIVATE_REFUSAL);
  });

  it("indexes earlier-chat titles for figures and codes only, not for their words", () => {
    const run = guard([], [], { figuresOnlyText: ["Rencana akuisisi pabrik tekstil Cikarang, invoice INV-2025-00871"] });
    expect(run.isTainted()).toBe(true);
    expect(run.judgeQuery("rencana akuisisi pabrik tekstil Cikarang")).toBeNull();
    expect(run.judgeQuery("status INV-2025-00871")).toEqual(PRIVATE_REFUSAL);
  });
});

describe("M5: what the person typed is exempt from the shape rules", () => {
  it("sends a key and a long question the person typed themselves", () => {
    const question = `${"Saya ingin tahu aturan pajak untuk usaha kecil di Jakarta dan Bandung. ".repeat(5)}`.trim();
    const run = guard([], [`Cari dokumentasi untuk kunci sk-abcdefghij1234567890 ini. ${question}`]);
    expect(run.judgeQuery("docs for sk-abcdefghij1234567890")).toBeNull();
    expect(run.judgeQuery(question)).toBeNull();
  });

  it("still refuses a key the person did not type", () => {
    expect(guard([], ["Cari dokumentasi"]).judgeQuery("docs for sk-zzzzzzzzzz1234567890")).toEqual(
      outboundRefusal("credential", "en"),
    );
  });
});

describe("L1: invisible characters", () => {
  it("matches a span split by zero-width spaces and combining marks", () => {
    const run = guard(["Pembayaran tahap kedua dilakukan paling lambat tanggal sepuluh."]);
    expect(run.judgeQuery("dilakukan​ paling lambat tang‍gal sepúluh")).toEqual(PRIVATE_REFUSAL);
  });
});

describe("H2: page addresses", () => {
  it("decodes each percent run on its own, three times over", () => {
    expect(readableUrl("https://x.example/?a=%zz&q=dilakukan%2520paling")).toBe(
      "https://x.example/?a=%zz&q=dilakukan paling",
    );
  });

  it("refuses a private span hidden behind a malformed escape and double encoding", () => {
    const run = guard(["Pembayaran tahap kedua dilakukan paling lambat tanggal sepuluh."]);
    expect(run.judgeUrl("https://x.example/?bad=%zz&q=dilakukan%2520paling%2520lambat%2520tanggal%2520sepuluh")).toEqual(
      PRIVATE_REFUSAL,
    );
  });

  it("refuses an encoded blob or an over-long tail in a model-written address, tainted or not", () => {
    const run = guard([]);
    expect(run.judgeUrl("https://x.example/p/U2VjcmV0IHBheW1lbnQgdGVybXMgMTUw")).toEqual(
      outboundRefusal("url_blob", "en"),
    );
    expect(run.judgeUrl(`https://x.example/${"a/".repeat(300)}`)).toEqual(outboundRefusal("url_too_long", "en"));
  });

  it("refuses a host label that packs data", () => {
    expect(urlShapeProblem(`https://${"m".repeat(41)}.evil.example/`)).toBe("blob");
    expect(urlShapeProblem("https://mfrggzdfmz2wq3a1b2c3d4e5.evil.example/")).toBe("blob");
    expect(urlShapeProblem("https://docs.python.org/3/library/asyncio.html")).toBeNull();
  });

  it("opens an ordinary article address", () => {
    expect(guard([]).judgeUrl("https://www.bi.go.id/id/publikasi/laporan/Pages/LPI-2024.aspx")).toBeNull();
  });
});

describe("H1: media sources and third-party prompts", () => {
  const run = () => guard(["Gaji direktur Budi Santoso naik menjadi 87.500.000 per bulan mulai Januari."]);

  it("hands a provider only an image this run made, a search returned or the person gave", () => {
    const desk = run();
    desk.noteHostMedia(["https://cdn.gateway.example/out/1.png"]);
    desk.noteSearchResults(["https://images.example/cat.jpg"]);
    expect(desk.judgeMediaUrl("https://cdn.gateway.example/out/1.png")).toBeNull();
    expect(desk.judgeMediaUrl("https://images.example/cat.jpg")).toBeNull();
    expect(desk.judgeMediaUrl("https://attacker.example/x.png?d=87500000")).toEqual(outboundRefusal("media", "en"));
    const own = guard([], ["edit https://my.example/photo.png please"]);
    expect(own.judgeMediaUrl("https://my.example/photo.png")).toBeNull();
  });

  it("judges a prompt bound for a third party, not one for the gateway, and has no length cap there", () => {
    const leak = "poster: gaji direktur Budi Santoso naik menjadi 87.500.000 per bulan";
    expect(runOutboundGuarded(run(), () => mediaSendRefusal({ prompt: leak, thirdParty: true }))).toEqual(
      PRIVATE_REFUSAL,
    );
    expect(runOutboundGuarded(run(), () => mediaSendRefusal({ prompt: leak, thirdParty: false }))).toBeNull();
    const long = `a calm watercolour harbour at dawn, ${"soft light, ".repeat(60)}`;
    expect(runOutboundGuarded(run(), () => mediaSendRefusal({ prompt: long, thirdParty: true }))).toBeNull();
  });
});

describe("H3: fails closed in a tool call with no guard open", () => {
  it("refuses a search query and a page address from a model's tool call with no guard", () => {
    expect(() => runInToolCall(() => sendableSearchQuery("harga emas"))).toThrow(OutboundRefusedError);
    expect(() => runInToolCall(() => assertSendableUrl("https://x.example/"))).toThrow(
      outboundRefusal("unguarded", "en").message,
    );
    expect(runInToolCall(() => mediaSendRefusal({ prompt: "cat", thirdParty: true }))).toEqual(
      outboundRefusal("unguarded", "en"),
    );
  });

  it("leaves a host route alone: no tool call, no guard, only the shape rules", () => {
    expect(sendableSearchQuery("harga emas")).toBe("harga emas");
    expect(() => assertSendableUrl("https://x.example/")).not.toThrow();
  });

  it("runs normally inside a guard", () => {
    const run = guard([]);
    expect(runOutboundGuarded(run, () => runInToolCall(() => sendableSearchQuery("harga emas")))).toBe("harga emas");
  });
});

describe("L3: a masked query is never a silent change", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetKeylessSearchState();
  });

  it("tells the model the query was masked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ pages: [] }) })),
    );
    const masked = await runWithToolSecrets({ secrets: {}, backends: {} }, () =>
      invokeTool(webSearchTool, { query: "kontak budi.santoso@example.com harga" }, tenant),
    );
    expect(masked).toMatchObject({ note: maskedQueryNote("en") });
    const plain = await runWithToolSecrets({ secrets: {}, backends: {} }, () =>
      invokeTool(webSearchTool, { query: "harga emas" }, tenant),
    );
    expect(plain).not.toHaveProperty("note");
  });
});
