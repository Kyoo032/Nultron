/**
 * Calibration for the outbound guard (`../outbound-guard.ts`): a tainted run whose private material is a
 * realistic finance memo and a realistic contract must still be able to run ordinary research.
 *
 * The overlap is deliberate. The private text names years, statutes (UU No. 40 Tahun 2007, PP 23/2018, UU 27
 * Tahun 2022), a listed bank's full legal name, round amounts and a regulator, and the queries name them too.
 * A set that avoided those would prove nothing.
 */

export const PRIVATE_FINANCE_MEMO = `Memo internal, Oktober 2025. Rekening operasional PT Sinar Laut Abadi di PT Bank Central Asia Tbk
nomor 0123456789 atas nama Budi Santoso. Pendapatan kuartal ketiga tahun 2025 sebesar Rp 1.250.000.000, naik
dari Rp 980.450.000 pada kuartal yang sama tahun 2024. Biaya operasional Rp 500 juta dan pinjaman modal kerja
Rp 2.000.000.000 dengan bunga 9,75 persen per tahun. Invoice INV-2025-00871 dari CV Maju Jaya belum dibayar.
Kami berencana menunda pembayaran pajak PPh 21 bulan November sampai arus kas membaik. Margin kotor turun karena
harga bahan baku naik dan kurs rupiah melemah terhadap dolar AS. Laporan ini disusun sesuai PSAK 72 dan akan
diaudit oleh kantor akuntan publik pada Januari 2026. Pemegang saham utama setuju menambah modal disetor
sebesar Rp 750.000.000 sebelum akhir tahun.`;

export const PRIVATE_LEGAL_CONTRACT = `PERJANJIAN KERJA SAMA PENYEDIAAN LAYANAN. Perjanjian ini dibuat antara PT Sinar Laut Abadi dan
PT Data Prima Nusantara pada tanggal 3 Maret 2025. Para pihak tunduk pada UU No. 40 Tahun 2007 tentang
Perseroan Terbatas dan UU 27 Tahun 2022 tentang Pelindungan Data Pribadi. Pembayaran tahap kedua dilakukan
paling lambat tanggal sepuluh setiap bulan ke rekening escrow nomor 7788990011. Nilai kontrak seluruhnya
Rp 3.400.000.000 belum termasuk PPN. Apabila terjadi wanprestasi, pihak yang dirugikan berhak atas denda
sebesar 2 persen per hari keterlambatan. Sengketa diselesaikan melalui Badan Arbitrase Nasional Indonesia di
Jakarta. Kerahasiaan berlaku selama lima tahun setelah perjanjian berakhir. Pengalihan data ke luar negeri
mengikuti PP 23/2018 dan peraturan Otoritas Jasa Keuangan yang berlaku.`;

/**
 * Working notes that cite short public numbers (an article of a code, a standard, an RFC, a status code) and
 * ordinary English phrasing. Since the 2026-10-13 review a number of three to five digits counts only with a
 * second one, so citing a public article in a private note does not block researching that article.
 */
export const PRIVATE_TECH_NOTES = `Catatan tim hukum dan TI. Kasus karyawan gudang mengacu pada Pasal 365 KUHP dan syarat sah
perjanjian vendor diuji menurut Pasal 1320 KUHPerdata. Server kami belum lulus audit ISO 27001 dan API lama masih
mengikuti RFC 2616, sehingga klien sering menerima HTTP 404. This vendor is one of the most reliable in the region,
and the migration will be done in the first quarter of next year.`;

/** Ordinary research a person on that desk would run. Every one must pass. */
export const ORDINARY_RESEARCH_QUERIES: readonly string[] = [
  "UU No. 40 Tahun 2007 tentang Perseroan Terbatas modal disetor minimum",
  "UU 27 Tahun 2022 Pelindungan Data Pribadi sanksi administratif",
  "PP 23/2018 tarif PPh final UMKM",
  "laporan keuangan PT Bank Central Asia Tbk kuartal ketiga 2025",
  "harga saham BBCA hari ini",
  "inflasi Indonesia 2025 menurut BPS",
  "suku bunga acuan Bank Indonesia Oktober 2025",
  "kurs rupiah terhadap dolar AS hari ini",
  "PSAK 72 pengakuan pendapatan kontrak dengan pelanggan",
  "cara menghitung PPh 21 karyawan tetap 2025",
  "batas waktu pembayaran PPh 21 dan sanksi keterlambatan",
  "Badan Arbitrase Nasional Indonesia prosedur pendaftaran perkara",
  "transfer data pribadi ke luar negeri menurut UU PDP",
  "peraturan OJK tentang perlindungan konsumen sektor jasa keuangan",
  "rata-rata bunga kredit modal kerja bank BUMN 2025",
  "500 perusahaan terbesar di Asia Tenggara",
  "harga emas Antam 1 gram hari ini",
  "harga minyak mentah Brent minggu ini",
  "Sri Mulyani pernyataan terbaru APBN 2026",
  "profil Gubernur Bank Indonesia Perry Warjiyo",
  "denda keterlambatan kontrak menurut hukum perdata Indonesia",
  "contoh klausul force majeure dalam perjanjian kerja sama",
  "what is IFRS 15 revenue recognition five step model",
  "Indonesia personal data protection law cross-border transfer requirements",
  "Bank Central Asia third quarter 2025 net profit",
  "rupiah exchange rate outlook 2026",
  "how to calculate working capital ratio",
  "OpenAI GPT-5 release notes",
  "Elon Musk latest statement on Tesla earnings",
  "COVID-19 impact on Indonesian SMEs",
  "ISO 27001 certification requirements for data centers",
  "difference between escrow account and trust account",
  "Nvidia H100 price per unit 2025",
  "how does Python asyncio event loop work",
  "Fortune 500 list 2025 top ten companies",
  "Pasal 365 KUHP pencurian dengan kekerasan",
  "Pasal 1320 KUHPerdata syarat sah perjanjian",
  "ISO 27001 annex A controls list",
  "RFC 2616 HTTP/1.1 status code definitions",
  "HTTP 404 error meaning and how to fix it",
  "which cloud provider is one of the most reliable in the region",
  "best practices for SaaS service level agreement uptime 99.9 percent",
];

/**
 * Queries that carry the private material verbatim and must be refused: a sentence from the contract, an
 * account number, the invoice code and the exact revenue figure.
 */
export const LEAKING_QUERIES: readonly string[] = [
  "pembayaran tahap kedua dilakukan paling lambat tanggal sepuluh setiap bulan",
  "rekening escrow 7788990011",
  "status invoice INV-2025-00871 CV Maju Jaya",
  "pendapatan kuartal ketiga 1.250.000.000",
  "kami berencana menunda pembayaran pajak PPh 21",
];
