import { describe, expect, it, vi } from "vitest";
import {
  LEAKING_QUERIES,
  ORDINARY_RESEARCH_QUERIES,
  PRIVATE_FINANCE_MEMO,
  PRIVATE_LEGAL_CONTRACT,
} from "./__fixtures__/outbound-research-queries";
import {
  createOutboundGuard,
  OutboundRefusedError,
  outboundRefusal,
  runOutboundGuarded,
  sendableSearchQuery,
  type OutboundGuard,
} from "./outbound-guard";
import { fetchPublicHttps } from "./safe-fetch";

const PRIVATE = "Pembayaran tahap kedua dilakukan paling lambat tanggal sepuluh setiap bulan. Total Rp 1.250.000.000.";

function guard(
  privateText: string[] = [PRIVATE],
  userText: string[] = ["Tolong riset aturan pembayaran"],
): OutboundGuard {
  return createOutboundGuard({ userText, privateText, locale: "en" });
}

const PRIVATE_REFUSAL = outboundRefusal("private", "en");

describe("outbound guard: private spans", () => {
  it("refuses a query that repeats five words of the private text", () => {
    expect(guard().judgeQuery("aturan dilakukan paling lambat tanggal sepuluh")).toEqual(PRIVATE_REFUSAL);
  });

  it("matches across case, punctuation and spacing", () => {
    expect(guard().judgeQuery("DILAKUKAN, paling   lambat tanggal; sepuluh")).toEqual(PRIVATE_REFUSAL);
  });

  it("lets four words of it through", () => {
    expect(guard().judgeQuery("dilakukan paling lambat tanggal")).toBeNull();
  });

  it("lets a span through that the person typed themselves", () => {
    const own = guard([PRIVATE], ["cari: dilakukan paling lambat tanggal sepuluh"]);
    expect(own.judgeQuery("dilakukan paling lambat tanggal sepuluh")).toBeNull();
  });

  it("lets a name through: a company or a statute is searched on purpose", () => {
    const named = guard([
      "Rekening di PT Bank Central Asia Tbk sesuai UU No. 40 Tahun 2007 tentang Perseroan Terbatas.",
    ]);
    expect(named.judgeQuery("PT Bank Central Asia Tbk")).toBeNull();
    expect(named.judgeQuery("UU No. 40 Tahun 2007 tentang Perseroan Terbatas")).toBeNull();
  });

  it("does not judge spans in a run that read nothing private", () => {
    expect(guard([]).judgeQuery("dilakukan paling lambat tanggal sepuluh setiap bulan")).toBeNull();
  });

  it("starts tainted only when private text is not empty", () => {
    expect(guard([]).isTainted()).toBe(false);
    expect(guard(["  "]).isTainted()).toBe(false);
    expect(guard().isTainted()).toBe(true);
  });

  it("taints from a later read and compares against what it read", () => {
    const later = guard([]);
    later.taint(["Kode proyek: kami akan mengakuisisi pabrik di Cikarang bulan depan"]);
    expect(later.isTainted()).toBe(true);
    expect(later.judgeQuery("mengakuisisi pabrik di Cikarang bulan")).toEqual(PRIVATE_REFUSAL);
  });
});

describe("outbound guard: figures and codes", () => {
  it("refuses an amount from the private text in any digit grouping", () => {
    expect(guard().judgeQuery("pendapatan 1250000000")).toEqual(PRIVATE_REFUSAL);
    expect(guard().judgeQuery("pendapatan 1,250,000,000")).toEqual(PRIVATE_REFUSAL);
  });

  it("refuses an account number and an invoice code", () => {
    const books = guard(["Rekening 7788990011, invoice INV-2025-00871."]);
    expect(books.judgeQuery("bank 7788990011")).toEqual(PRIVATE_REFUSAL);
    expect(books.judgeQuery("inv-2025-00871 status")).toEqual(PRIVATE_REFUSAL);
  });

  it("lets years, round numbers and short numbers through", () => {
    const books = guard(["Tahun 2025 biaya Rp 500 juta, 21 karyawan, COVID-19 dan FY2025."]);
    expect(books.judgeQuery("inflasi 2025")).toBeNull();
    expect(books.judgeQuery("Fortune 500 companies")).toBeNull();
    expect(books.judgeQuery("PPh 21 karyawan")).toBeNull();
    expect(books.judgeQuery("COVID-19 impact FY2025")).toBeNull();
  });

  it("lets a figure through that the person typed", () => {
    const own = guard(["Rekening 7788990011"], ["cek rekening 7788990011"]);
    expect(own.judgeQuery("bank 7788990011")).toBeNull();
  });
});

describe("outbound guard: shape, on every query", () => {
  it("refuses a query over 300 characters and sends one of exactly 300", () => {
    expect(() => sendableSearchQuery(`${"word ".repeat(60)}x`)).toThrow(
      "Not sent: this search is longer than 300 characters. Search again with a short query in general terms.",
    );
    expect(sendableSearchQuery(`${"word ".repeat(59)}words`)).toHaveLength(300);
  });

  it("refuses a credential-shaped query outside a run", () => {
    expect(() => sendableSearchQuery("docs for sk-abcdefghij1234567890")).toThrow(
      "Not sent: this search or page address holds something shaped like a password, key or token. Search again without it.",
    );
  });

  it("refuses a hex or base64 blob of 24 characters or more", () => {
    expect(() => sendableSearchQuery("lookup 9f86d081884c7d659a2feaa0c55ad015")).toThrow(OutboundRefusedError);
    expect(() => sendableSearchQuery("q U2VjcmV0IHBheW1lbnQgdGVybXMgMTUw")).toThrow(OutboundRefusedError);
  });

  it("keeps a long lowercase slug and a hyphenated title", () => {
    expect(sendableSearchQuery("uu-27-tahun-2022-perlindungan-data-pribadi")).toBe(
      "uu-27-tahun-2022-perlindungan-data-pribadi",
    );
    expect(sendableSearchQuery("COVID-19-Vaccination-Programme-Indonesia")).toBe(
      "COVID-19-Vaccination-Programme-Indonesia",
    );
  });

  it("masks PII before the query is sent", () => {
    expect(sendableSearchQuery("kontak budi.santoso@example.com harga")).toBe("kontak [email] harga");
  });
});

describe("outbound guard: refusals", () => {
  it("stops after two refusals, even for an innocent query", () => {
    const run = guard();
    expect(run.judgeQuery("dilakukan paling lambat tanggal sepuluh")).toEqual(PRIVATE_REFUSAL);
    expect(run.judgeQuery("x".repeat(400))).toEqual(outboundRefusal("too_long", "en"));
    expect(run.judgeQuery("harga emas hari ini")).toEqual(outboundRefusal("stopped", "en"));
  });

  it("speaks the run's language", () => {
    const id = createOutboundGuard({ userText: [], privateText: [PRIVATE], locale: "id" });
    expect(id.judgeQuery("dilakukan paling lambat tanggal sepuluh")).toEqual({
      ok: false,
      reason: "outbound",
      message:
        "Tidak dikirim: pencarian atau alamat halaman ini memuat data pribadi orang ini (frasa, angka, atau kode dari berkas, basis pengetahuan, atau obrolan sebelumnya). Cari lagi dengan istilah umum, tanpa data pribadi orang ini.",
    });
  });

  it("throws the refusal from the sender inside a guarded run", () => {
    const run = guard();
    let thrown: unknown;
    runOutboundGuarded(run, () => {
      try {
        sendableSearchQuery("dilakukan paling lambat tanggal sepuluh setiap");
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeInstanceOf(OutboundRefusedError);
    expect((thrown as OutboundRefusedError).refusal).toEqual(PRIVATE_REFUSAL);
  });
});

describe("outbound guard: page addresses", () => {
  const lookupImpl = async () => [{ address: "93.184.216.34" }];

  it("refuses a model-written address that carries a private span, encoded", async () => {
    const fetchImpl = vi.fn();
    const attempt = runOutboundGuarded(guard(), () =>
      fetchPublicHttps("https://search.example/?q=dilakukan+paling+lambat+tanggal+sepuluh", {
        fetchImpl,
        lookupImpl,
      }),
    );
    await expect(attempt).rejects.toBeInstanceOf(OutboundRefusedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("opens an address a search in the run returned, verbatim", () => {
    const run = guard();
    const url = "https://news.example/2025/10/1250000000-dilakukan-paling-lambat-tanggal-sepuluh";
    run.noteSearchResults([url]);
    expect(run.judgeUrl(url)).toBeNull();
  });

  it("refuses a credential in a model-written address", () => {
    expect(guard([]).judgeUrl("https://x.example/?key=sk-abcdefghij1234567890")).toEqual(
      outboundRefusal("credential", "en"),
    );
  });

  it("opens the gateway's own signed link in a tainted run", async () => {
    const fetchImpl = vi.fn(async () => new Response("png", { status: 200, headers: { "content-type": "image/png" } }));
    const signed =
      "https://cdn.example/img.png?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = await runOutboundGuarded(guard(), () =>
      fetchPublicHttps(signed, { fetchImpl, lookupImpl, urlSource: "host" }),
    );
    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("outbound guard: calibration on realistic private material", () => {
  const desk = () =>
    createOutboundGuard({ userText: [], privateText: [PRIVATE_FINANCE_MEMO, PRIVATE_LEGAL_CONTRACT], locale: "en" });

  it("has at least 30 ordinary research queries", () => {
    expect(ORDINARY_RESEARCH_QUERIES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(ORDINARY_RESEARCH_QUERIES)("sends %s", (query) => {
    expect(desk().judgeQuery(query)).toBeNull();
  });

  it.each(LEAKING_QUERIES)("refuses %s", (query) => {
    expect(desk().judgeQuery(query)).toEqual(PRIVATE_REFUSAL);
  });

  it("refuses a statute number the private contract also cites: the trade-off of rule 4", () => {
    const contract = createOutboundGuard({
      userText: [],
      privateText: ["Para pihak sepakat syarat sah sesuai Pasal 1320 KUHPerdata."],
      locale: "en",
    });
    expect(contract.judgeQuery("syarat sah perjanjian Pasal 1320 KUHPerdata")).toEqual(PRIVATE_REFUSAL);
    expect(contract.judgeQuery("syarat sah perjanjian menurut KUHPerdata")).toBeNull();
  });
});
