import { describe, expect, it } from "vitest";
import { ID_PROVINCE_CODES, isNikDigits, isNpwpDigits, scanIndonesianIds } from "./pii-id";

/** Invented numbers only. `99` is the reserved synthetic province code; the rest are format samples. */
const NIK_MALE = "3273010101900001";
const NIK_FEMALE = "3273014107950123";
const NIK_SYNTHETIC = "9901011505880042";
const NPWP_DOTTED = "09.254.294.3-407.000";

describe("isNikDigits", () => {
  it("accepts a well-formed NIK for either sex and the synthetic region", () => {
    expect(isNikDigits(NIK_MALE)).toBe(true);
    expect(isNikDigits(NIK_FEMALE)).toBe(true);
    expect(isNikDigits(NIK_SYNTHETIC)).toBe(true);
    expect(ID_PROVINCE_CODES.has("99")).toBe(true);
  });

  it("refuses anything that is not sixteen digits", () => {
    expect(isNikDigits("327301010190000")).toBe(false);
    expect(isNikDigits("32730101019000012")).toBe(false);
    expect(isNikDigits("32730101019000a1")).toBe(false);
  });

  it("refuses an impossible province, regency, district, day or month", () => {
    expect(isNikDigits("2273010101900001")).toBe(false); // province 22 is not assigned
    expect(isNikDigits("3200010101900001")).toBe(false); // regency 00
    expect(isNikDigits("3273000101900001")).toBe(false); // district 00
    expect(isNikDigits("3273013201900001")).toBe(false); // day 32
    expect(isNikDigits("3273013001900001")).toBe(true); // day 30, month 01
    expect(isNikDigits("3273013102900001")).toBe(false); // 31 February
    expect(isNikDigits("3273010113900001")).toBe(false); // month 13
  });

  it("refuses a round serial unless the number was labelled", () => {
    // 1250000000000000-style totals end in zeros; a registration serial runs 0001-9999.
    expect(isNikDigits("3273010101902000")).toBe(false);
    expect(isNikDigits("3273010101902000", { labelled: true })).toBe(true);
    expect(isNikDigits("3273010101900000", { labelled: true })).toBe(false); // serial 0000 is never valid
  });
});

describe("isNpwpDigits", () => {
  it("accepts fifteen or sixteen digits and nothing else", () => {
    expect(isNpwpDigits("092542943407000")).toBe(true);
    expect(isNpwpDigits("0925429434070001")).toBe(true);
    expect(isNpwpDigits("09254294340700")).toBe(false);
    expect(isNpwpDigits("09254294340700012")).toBe(false);
  });
});

describe("scanIndonesianIds", () => {
  it("finds a dotted NPWP with no label at all", () => {
    const hits = scanIndonesianIds(`Wajib pajak ${NPWP_DOTTED} terdaftar`);
    expect(hits).toEqual([{ kind: "npwp", match: NPWP_DOTTED, index: "Wajib pajak ".length }]);
  });

  it("finds a labelled NIK and NPWP and spans only the number", () => {
    const hits = scanIndonesianIds(`NIK: ${NIK_MALE}\nNPWP: 09.254.294.3-407.000`);
    expect(hits.map((hit) => hit.kind).sort()).toEqual(["nik", "npwp"]);
    expect(hits.find((hit) => hit.kind === "nik")?.match).toBe(NIK_MALE);
    expect(hits.find((hit) => hit.kind === "nik")?.index).toBe("NIK: ".length);
  });

  it("finds a bare NIK on structure alone", () => {
    expect(scanIndonesianIds(`Karyawan ${NIK_SYNTHETIC} aktif`)).toEqual([
      { kind: "nik", match: NIK_SYNTHETIC, index: "Karyawan ".length },
    ]);
  });

  it("finds 08xx local phones in both spaced and bare form", () => {
    expect(scanIndonesianIds("HP 081234567890").map((hit) => hit.kind)).toEqual(["phone"]);
    expect(scanIndonesianIds("HP 0812-3456-7890").map((hit) => hit.kind)).toEqual(["phone"]);
  });

  it("finds an account number only when the cue sits right before the digits", () => {
    expect(scanIndonesianIds("No. Rekening: 1234567890").map((hit) => hit.kind)).toEqual(["account"]);
    expect(scanIndonesianIds("norek 8830011223").map((hit) => hit.kind)).toEqual(["account"]);
    expect(scanIndonesianIds("A/C 0123456789").map((hit) => hit.kind)).toEqual(["account"]);
    // A word between the cue and the number means the number is an amount, not an account.
    expect(scanIndonesianIds("Rekening Bank: 1250000000")).toEqual([]);
    expect(scanIndonesianIds("Accounts payable 450000000")).toEqual([]);
    expect(scanIndonesianIds("Accounts receivable 1250000000")).toEqual([]);
  });

  it("finds account numbers when a recognized bank name sits between the cue and digits", () => {
    expect(scanIndonesianIds("Rekening BCA 1234567890")).toEqual([
      { kind: "account", match: "1234567890", index: "Rekening BCA ".length },
    ]);
    expect(scanIndonesianIds("No. Rek Mandiri: 1370004567890")).toEqual([
      { kind: "account", match: "1370004567890", index: "No. Rek Mandiri: ".length },
    ]);
    expect(scanIndonesianIds("No. Rekening BNI 0123-456-789")).toEqual([
      { kind: "account", match: "0123-456-789", index: "No. Rekening BNI ".length },
    ]);
  });

  it("finds safe unlabelled bank accounts (bank-cued, bank-grouped, IBAN) without touching amounts or cards", () => {
    expect(scanIndonesianIds("Transfer ke 1370004567891")).toEqual([
      { kind: "account", match: "1370004567891", index: "Transfer ke ".length },
    ]);
    expect(scanIndonesianIds("BCA 1234567890")).toEqual([
      { kind: "account", match: "1234567890", index: "BCA ".length },
    ]);
    expect(scanIndonesianIds("Kirim ke 9000-1234-0001 segera")).toEqual([
      { kind: "account", match: "9000-1234-0001", index: "Kirim ke ".length },
    ]);
    expect(scanIndonesianIds("IBAN: DE89 3704 0044 0532 0130 00")).toEqual([
      { kind: "account", match: "DE89 3704 0044 0532 0130 00", index: "IBAN: ".length },
    ]);
    expect(scanIndonesianIds("Wire to GB29NWBK60161331926819")).toEqual([
      { kind: "account", match: "GB29NWBK60161331926819", index: "Wire to ".length },
    ]);
    expect(scanIndonesianIds("rekening BCA saya 1234567890")).toEqual([
      { kind: "account", match: "1234567890", index: "rekening BCA saya ".length },
    ]);
    expect(scanIndonesianIds("my BCA account is 1234567890")).toEqual([
      { kind: "account", match: "1234567890", index: "my BCA account is ".length },
    ]);
    expect(scanIndonesianIds("transfer Rp 1.500.000 ke 1234567890")).toEqual([
      { kind: "account", match: "1234567890", index: "transfer Rp 1.500.000 ke ".length },
    ]);
    expect(scanIndonesianIds("transfer ke 123456789")).toEqual([
      { kind: "account", match: "123456789", index: "transfer ke ".length },
    ]);
    expect(scanIndonesianIds("wire to 123456789")).toEqual([
      { kind: "account", match: "123456789", index: "wire to ".length },
    ]);

    expect(scanIndonesianIds("Rp 1.500.000")).toEqual([]);
    expect(scanIndonesianIds("revenue grew to 123456789")).toEqual([]);
    expect(scanIndonesianIds("naik ke 123456789")).toEqual([]);

    // Never mask amounts, round totals, grouped thousands, bare 16-digit runs, or cards
    expect(scanIndonesianIds("Transfer Rp 1.250.000.000")).toEqual([]);
    expect(scanIndonesianIds("Transfer Saldo 1234567890")).toEqual([]);
    expect(scanIndonesianIds("BCA 1250000000")).toEqual([]);
    expect(scanIndonesianIds("1234567890123456")).toEqual([]);
    expect(scanIndonesianIds("Transfer 4111-1111-1111-1111")).toEqual([]);
    expect(scanIndonesianIds("Call 415-555-2671 or 021-5551234")).toEqual([]);
  });

  it("keeps financial figures out of transfer and bank account cues", () => {
    const amounts = [
      "Set the budget to 125500123 rupiah",
      "Set the budget to 125500123",
      "Pay 125500123 rupiah to the supplier",
      "Pay 125500123",
      "BCA dividends were 125500123 rupiah",
      "BCA dividends were 125500123",
      "Transfer ke 125500123 rupiah",
      "Rekening 125500123 rupiah",
      "Transfer 125500123",
      "Wire 125500123 usd",
      "Send 125500123 dollars",
      "Transfer 125500123 juta",
      "Transfer 125500123 miliar",
      "Transfer 125500123 ribu",
    ];
    for (const line of amounts) {
      expect({ line, hits: scanIndonesianIds(line) }).toEqual({ line, hits: [] });
    }

    expect(scanIndonesianIds("Pay to 125500123")).toEqual([
      { kind: "account", match: "125500123", index: "Pay to ".length },
    ]);
    expect(scanIndonesianIds("BCA account 125500123")).toEqual([
      { kind: "account", match: "125500123", index: "BCA account ".length },
    ]);
    const mixed = "Transfer 125500123 rupiah ke 987654321";
    expect(scanIndonesianIds(mixed)).toEqual([
      { kind: "account", match: "987654321", index: mixed.indexOf("987654321") },
    ]);
  });

  it("recognizes a transfer cue wrapped across one newline without trusting weak line endings", () => {
    const wrapped = [
      "Transfer ke:\n1234567890",
      "Transfer ke BCA:\n1234567890",
      "Transfer ke rekening BCA:\n1234567890",
      "No. Rekening:\n1234567890",
      "No. Rekening:\n1234560000",
      "BCA account\n1234567890",
      "transfer Rp 1.500.000 ke\n1234567890",
    ];
    for (const line of wrapped) {
      const expectedMatch = line.endsWith("1234560000") ? "1234560000" : "1234567890";
      expect({ line, hits: scanIndonesianIds(line) }).toEqual({
        line,
        hits: [{ kind: "account", match: expectedMatch, index: line.indexOf(expectedMatch) }],
      });
    }

    // Wrapped account followed by a separate numeric line must NOT swallow the next line's amount (LF and CRLF).
    for (const sep of ["\n", "\r\n"]) {
      const multi = `No. Rekening:${sep}1234567890${sep}1250000000`;
      expect(scanIndonesianIds(multi)).toEqual([
        { kind: "account", match: "1234567890", index: multi.indexOf("1234567890") },
      ]);
    }

    const weakLines = [
      "Set the budget to\n1234567890",
      "Revenue grew to\n1234567890",
      "Invoice total:\n1234567890",
      "Pay\n1234567890",
      "Payment amount\n1234567890",
      "BCA dividends were\n1234567890",
      "BCA\n1234567890",
      "Transfer ke rekening BCA:\n\n1234567890",
    ];
    for (const line of weakLines) {
      expect({ line, hits: scanIndonesianIds(line) }).toEqual({ line, hits: [] });
    }
  });

  it("finds the abbreviated ke rek transfer cue", () => {
    for (const line of ["ke rek 1234567890", "ke rek. 1234567890", "Ke Rek: 1234567890"]) {
      expect({ line, hits: scanIndonesianIds(line) }).toEqual({
        line,
        hits: [{ kind: "account", match: "1234567890", index: line.indexOf("1234567890") }],
      });
    }
    expect(scanIndonesianIds("ke reksa 1234567890")).toEqual([]);
    expect(scanIndonesianIds("ke rek 12345678")).toEqual([]);
  });

  it("keeps sentence punctuation with a transfer account but rejects decimal and grouped figures", () => {
    for (const line of ["Transfer ke 123456789.", "Transfer ke 123456789,", "Wire to 123456789."]) {
      expect({ line, hits: scanIndonesianIds(line) }).toEqual({
        line,
        hits: [{ kind: "account", match: "123456789", index: line.indexOf("123456789") }],
      });
    }

    for (const line of [
      "Transfer ke 123456789.50",
      "Transfer ke 123456789,50",
      "Transfer ke rekening 123456789.50",
      "Rekening 123456789,50",
      "Transfer ke 123,456,789",
    ]) {
      expect({ line, hits: scanIndonesianIds(line) }).toEqual({ line, hits: [] });
    }
  });

  it("leaves money alone in every shape Finance writes it", () => {
    const money = [
      "Pendapatan 2024: 1.250.000.000",
      "Revenue 2024: 1,250,000,000",
      "Laba bersih: 3.500.000,50",
      "Total: 1250000000",
      "Grand total: 1250000000000000",
      "Kas akhir 1189000000000000",
      "Margin 41,6% pada 2024",
      "Volume 26367138, mkt cap 1129686761472",
      "Harga per unit 12.500",
      "Tahun 2024 dan 2025",
    ];
    for (const line of money) {
      expect({ line, hits: scanIndonesianIds(line) }).toEqual({ line, hits: [] });
    }
  });

  it("does not donate 081 out of the middle of a rupiah amount", () => {
    expect(scanIndonesianIds("Beban sewa 1.081.250.000")).toEqual([]);
    expect(scanIndonesianIds("Beban sewa 1081250000")).toEqual([]);
  });
});
