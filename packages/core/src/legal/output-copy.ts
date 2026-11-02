import type { FindingKind } from "./types";
import type { LegalLocale } from "./locale";

export type LegalOutputCopy = {
  stubError: string;
  unsupportedFile: string;
  closingLine: string;
  memoTitle: string;
  privilegeLine: string;
  headerTo: string;
  headerFrom: string;
  headerDate: string;
  headerRe: string;
  firmLabel: string;
  summaryHeading: string;
  fallbackSummary: string;
  missingWhy: string;
  unmarkedTitle: string;
  unmarkedAdded: string;
  unmarkedPrior: string;
  noPriorTurn: string;
  unmarkedChanges: string;
  noClauses: string;
  allMapped: string;
  noPlaybook: string;
  usingPlaybook: string;
  assumedDraft: string;
  droppedQuote: string;
  noHighSeverity: string;
  noRedlineBytes: string;
  droppedOutput: string;
  instructingAuthor: string;
  skipped: string;
  roundOf: string;
  passedFailed: string;
  reservedFor: string;
  noCitation: string;
  findingNotFound: string;
  noneIdentified: string;
  positionLine: string;
  basisComment: string;
  deviationsSheet: string;
  summarySheet: string;
  sheetMatter: string;
  sheetPosition: string;
  sheetFindings: string;
  sheetReserved: string;
  sheetSeverity: string;
  sheetKind: string;
  sheetCount: string;
  verificationHeading: string;
  verificationNotRun: string;
  allChecksPassed: string;
  someChecksFailed: string;
  checkPassed: string;
  checkFailed: string;
  roundLine: string;
  memoColumns: readonly string[];
  deviationColumns: readonly string[];
  findingColumns: readonly string[];
  reservedColumns: readonly string[];
  redFlagSections: readonly string[];
  kindLabels: Readonly<Record<FindingKind, string>>;
  phase: Readonly<Record<string, string>>;
  /** Doc flow: add files, get answers (docs/internal/doc-flow-plan.md section 2). */
  needsOcr: string;
  pdfUnreadable: string;
  pdfEncrypted: string;
  pdfTooLong: string;
  redlineNeedsWord: string;
  diffNeedsSameFormat: string;
  partiesRequired: string;
  counterpartyFallback: string;
  noFiles: string;
  noExtract: string;
  matterTooLarge: string;
  readingPart: string;
  readSummary: string;
  partFailed: string;
  modelUnreadable: string;
  repairing: string;
  extractSaved: string;
  notInDocuments: string;
  answerDropped: string;
  fieldLabels: Readonly<Record<string, string>>;
};

const EN: LegalOutputCopy = {
  stubError: "Legal needs a live gateway. Paste a Toko Token API key in Settings, then try again.",
  unsupportedFile: "Only Word (.docx) and PDF files are accepted.",
  closingLine: "Draft work product prepared with automated assistance for review by a qualified lawyer.",
  memoTitle: "MEMORANDUM",
  privilegeLine: "PRIVILEGED AND CONFIDENTIAL — ATTORNEY WORK PRODUCT",
  headerTo: "To",
  headerFrom: "From",
  headerDate: "Date",
  headerRe: "Re",
  firmLabel: "Firm",
  summaryHeading: "Summary",
  fallbackSummary: "{party} reviewed the counterparty draft against {counterparty}.",
  missingWhy: 'Required provision "{title}" is not present in the counterparty draft.',
  unmarkedTitle: "Unmarked change",
  unmarkedAdded: "Paragraph added without a tracked change.",
  unmarkedPrior: "Prior text: {before}",
  noPriorTurn: "No prior turn to compare",
  unmarkedChanges: "{count} unmarked changes",
  noClauses: "No clauses to review",
  allMapped: "All checklist items mapped",
  noPlaybook: "No playbook",
  usingPlaybook: "Position: {title}",
  assumedDraft: "Treating {name} as the counterparty draft",
  droppedQuote: "Quote was not in the clause; dropped",
  noHighSeverity: "No high-severity findings",
  noRedlineBytes: "No original bytes for redline",
  droppedOutput: "Dropped invalid model output after retry",
  instructingAuthor: "instructing author",
  skipped: "skipped",
  roundOf: "Round {round} of {total}",
  passedFailed: "{passed} passed, {failed} failed",
  reservedFor: "Reserved for {who}",
  noCitation: "no citation recorded",
  findingNotFound: "[finding not found]",
  noneIdentified: "None identified.",
  positionLine: "Acting for {party} ({role}) against {counterparty}.",
  basisComment: "{title}. Basis: {basis}.",
  deviationsSheet: "Deviations",
  summarySheet: "Summary",
  sheetMatter: "Matter",
  sheetPosition: "Position",
  sheetFindings: "Findings",
  sheetReserved: "Reserved for partner decision",
  sheetSeverity: "Severity",
  sheetKind: "Kind",
  sheetCount: "Count",
  verificationHeading: "Verification",
  verificationNotRun: "Verification was not run.",
  allChecksPassed: "All code checks passed.",
  someChecksFailed: "One or more code checks failed.",
  checkPassed: "passed",
  checkFailed: "failed",
  roundLine: "Round {round}. {outcome}",
  memoColumns: ["Clause", "Provision", "Why adverse", "Severity", "Proposed language", "Basis"],
  deviationColumns: [
    "Clause",
    "Kind",
    "Title",
    "Provision (quote)",
    "Why adverse",
    "Severity",
    "Negotiability",
    "Proposed language",
    "Basis",
    "Reserved for",
  ],
  findingColumns: ["Clause", "Title", "Severity", "Negotiability", "Why adverse", "Proposed language", "Basis"],
  reservedColumns: ["Clause", "Title", "Severity", "Reserved for", "Why adverse", "Basis"],
  redFlagSections: [
    "Adverse provisions",
    "Missing provisions",
    "Unmarked changes",
    "Interactions",
    "Reserved for partner decision",
  ],
  kindLabels: {
    adverse: "Adverse provision",
    deviation: "Deviation from playbook",
    "unmarked-change": "Unmarked change",
    interaction: "Interaction",
    missing: "Missing provision",
    ok: "Conforms",
  },
  phase: {
    reading: "Reading the files",
    extracting: "Extracting the facts",
    checking: "Checking against the files",
    answering: "Answering",
    saving: "Saving",
    classify: "Classifying documents",
    diff: "Comparing with the prior turn",
    review: "Reviewing provisions",
    position: "Choosing a position",
    missing: "Checking required provisions",
    interactions: "Checking interactions",
    draft: "Drafting deliverables",
    verify: "Verifying",
    edit: "Applying corrections",
    package: "Packaging",
  },
  needsOcr:
    "This PDF is a scan with no text layer. Scans cannot be read here, and nothing was sent anywhere. Use a PDF with selectable text, or a Word file.",
  pdfUnreadable: "That PDF could not be read. It may be damaged.",
  pdfEncrypted: "That PDF is password protected. Remove the password and add it again.",
  pdfTooLong: "That PDF is too long to read in full. Split it and add the parts.",
  redlineNeedsWord:
    "No redline: the counterparty draft is a PDF, and a redline needs a Word file. The memorandum and the other deliverables are not affected.",
  diffNeedsSameFormat: "The prior turn and the draft are different formats; they were not compared",
  partiesRequired: "Say which side you act for (your party and the counterparty) before running the full review.",
  counterpartyFallback: "the counterparty",
  noFiles: "Add at least one file first.",
  noExtract: "Nothing to edit yet: run the extraction first.",
  matterTooLarge: "This matter is too long to read in one pass ({calls} parts). Remove some files and try again.",
  readingPart: "Reading part {current} of {total}",
  readSummary: "Read {files} files in {calls} parts",
  partFailed: "{part} could not be read in full; it is marked as not fully read",
  modelUnreadable: "The model's answer could not be read. Try again.",
  repairing: "{count} items did not pass the checks; asking once more",
  extractSaved: "Saved",
  notInDocuments: "The documents do not say.",
  answerDropped: "No quote could be verified; answered as not in the documents",
  fieldLabels: {
    parties: "Parties",
    "effective-date": "Effective date",
    term: "Term",
    payment: "Payment",
    liability: "Liability",
    termination: "Termination",
    "governing-law": "Governing law",
    notable: "Notable",
  },
};

const ID: LegalOutputCopy = {
  stubError: "Legal memerlukan gerbang yang aktif. Tempel kunci API Toko Token di Settings, lalu coba lagi.",
  unsupportedFile: "Hanya berkas Word (.docx) dan PDF yang diterima.",
  closingLine:
    "Draf hasil kerja yang disusun dengan bantuan otomatis untuk ditinjau oleh pengacara yang berkualifikasi.",
  memoTitle: "MEMORANDUM",
  privilegeLine: "RAHASIA DAN ISTIMEWA — HASIL KERJA PENGACARA",
  headerTo: "Kepada",
  headerFrom: "Dari",
  headerDate: "Tanggal",
  headerRe: "Perihal",
  firmLabel: "Kantor hukum",
  summaryHeading: "Ringkasan",
  fallbackSummary: "{party} menelaah draf pihak lawan terhadap {counterparty}.",
  missingWhy: 'Ketentuan wajib "{title}" tidak terdapat dalam draf pihak lawan.',
  unmarkedTitle: "Perubahan tanpa penandaan",
  unmarkedAdded: "Paragraf ditambahkan tanpa jejak perubahan.",
  unmarkedPrior: "Teks sebelumnya: {before}",
  noPriorTurn: "Tidak ada giliran sebelumnya untuk dibandingkan",
  unmarkedChanges: "{count} perubahan tanpa markup",
  noClauses: "Tidak ada klausul untuk ditelaah",
  allMapped: "Semua butir daftar periksa terpetakan",
  noPlaybook: "Tanpa playbook",
  usingPlaybook: "Kedudukan: {title}",
  assumedDraft: "Memperlakukan {name} sebagai draf pihak lawan",
  droppedQuote: "Kutipan tidak ada dalam klausul; diabaikan",
  noHighSeverity: "Tidak ada temuan berkeparahan tinggi",
  noRedlineBytes: "Tidak ada bita asli untuk redline",
  droppedOutput: "Keluaran model yang tidak sah diabaikan setelah dicoba ulang",
  instructingAuthor: "pemberi instruksi",
  skipped: "dilewati",
  roundOf: "Putaran {round} dari {total}",
  passedFailed: "{passed} lulus, {failed} gagal",
  reservedFor: "Ditahan untuk {who}",
  noCitation: "tidak ada sitasi tercatat",
  findingNotFound: "[temuan tidak ditemukan]",
  noneIdentified: "Tidak ada yang teridentifikasi.",
  positionLine: "Bertindak untuk {party} ({role}) terhadap {counterparty}.",
  basisComment: "{title}. Dasar: {basis}.",
  deviationsSheet: "Penyimpangan",
  summarySheet: "Ringkasan",
  sheetMatter: "Perkara",
  sheetPosition: "Kedudukan",
  sheetFindings: "Temuan",
  sheetReserved: "Ditahan untuk keputusan mitra",
  sheetSeverity: "Tingkat keparahan",
  sheetKind: "Jenis",
  sheetCount: "Jumlah",
  verificationHeading: "Verifikasi",
  verificationNotRun: "Verifikasi tidak dijalankan.",
  allChecksPassed: "Semua cek kode lulus.",
  someChecksFailed: "Satu atau lebih cek kode gagal.",
  checkPassed: "lulus",
  checkFailed: "gagal",
  roundLine: "Putaran {round}. {outcome}",
  memoColumns: ["Klausul", "Ketentuan", "Mengapa merugikan", "Tingkat keparahan", "Usulan redaksi", "Dasar"],
  deviationColumns: [
    "Klausul",
    "Jenis",
    "Judul",
    "Ketentuan (kutipan)",
    "Mengapa merugikan",
    "Tingkat keparahan",
    "Daya tawar",
    "Usulan redaksi",
    "Dasar",
    "Ditahan untuk",
  ],
  findingColumns: ["Klausul", "Judul", "Tingkat keparahan", "Daya tawar", "Mengapa merugikan", "Usulan redaksi", "Dasar"],
  reservedColumns: ["Klausul", "Judul", "Tingkat keparahan", "Ditahan untuk", "Mengapa merugikan", "Dasar"],
  redFlagSections: [
    "Ketentuan yang merugikan",
    "Ketentuan yang hilang",
    "Perubahan tanpa penandaan",
    "Interaksi",
    "Ditahan untuk keputusan mitra",
  ],
  kindLabels: {
    adverse: "Ketentuan yang merugikan",
    deviation: "Penyimpangan dari playbook",
    "unmarked-change": "Perubahan tanpa penandaan",
    interaction: "Interaksi",
    missing: "Ketentuan yang hilang",
    ok: "Sesuai",
  },
  phase: {
    reading: "Membaca berkas",
    extracting: "Mengekstrak fakta",
    checking: "Memeriksa terhadap berkas",
    answering: "Menjawab",
    saving: "Menyimpan",
    classify: "Mengklasifikasi dokumen",
    diff: "Membandingkan dengan giliran sebelumnya",
    review: "Menelaah ketentuan",
    position: "Memilih kedudukan",
    missing: "Memeriksa ketentuan wajib",
    interactions: "Memeriksa interaksi",
    draft: "Menyusun hasil kerja",
    verify: "Memverifikasi",
    edit: "Menerapkan koreksi",
    package: "Mengemas",
  },
  needsOcr:
    "PDF ini adalah hasil pindai tanpa lapisan teks. Hasil pindai tidak dapat dibaca di sini, dan tidak ada yang dikirim ke mana pun. Gunakan PDF dengan teks yang dapat dipilih, atau berkas Word.",
  pdfUnreadable: "PDF itu tidak dapat dibaca. Mungkin rusak.",
  pdfEncrypted: "PDF itu dilindungi kata sandi. Hapus kata sandinya lalu tambahkan lagi.",
  pdfTooLong: "PDF itu terlalu panjang untuk dibaca utuh. Pecah lalu tambahkan bagiannya.",
  redlineNeedsWord:
    "Tanpa redline: draf pihak lawan berupa PDF, dan redline memerlukan berkas Word. Memorandum dan hasil kerja lain tidak terpengaruh.",
  diffNeedsSameFormat: "Giliran sebelumnya dan draf berbeda format; keduanya tidak dibandingkan",
  partiesRequired: "Tentukan pihak yang Anda wakili (pihak Anda dan pihak lawan) sebelum menjalankan telaah penuh.",
  counterpartyFallback: "pihak lawan",
  noFiles: "Tambahkan setidaknya satu berkas terlebih dahulu.",
  noExtract: "Belum ada yang dapat diubah: jalankan ekstraksi terlebih dahulu.",
  matterTooLarge:
    "Perkara ini terlalu panjang untuk dibaca sekali jalan ({calls} bagian). Hapus beberapa berkas lalu coba lagi.",
  readingPart: "Membaca bagian {current} dari {total}",
  readSummary: "Membaca {files} berkas dalam {calls} bagian",
  partFailed: "{part} tidak dapat dibaca secara utuh; ditandai belum terbaca utuh",
  modelUnreadable: "Jawaban model tidak dapat dibaca. Coba lagi.",
  repairing: "{count} butir tidak lolos pemeriksaan; meminta sekali lagi",
  extractSaved: "Tersimpan",
  notInDocuments: "Dokumen tidak menyebutkannya.",
  answerDropped: "Tidak ada kutipan yang dapat diverifikasi; dijawab sebagai tidak ada dalam dokumen",
  fieldLabels: {
    parties: "Para pihak",
    "effective-date": "Tanggal berlaku",
    term: "Jangka waktu",
    payment: "Pembayaran",
    liability: "Tanggung jawab",
    termination: "Pengakhiran",
    "governing-law": "Hukum yang berlaku",
    notable: "Patut dicatat",
  },
};

const BY_LOCALE: Readonly<Record<LegalLocale, LegalOutputCopy>> = { en: EN, id: ID };

export function legalOutputCopy(locale: LegalLocale = "en"): LegalOutputCopy {
  return BY_LOCALE[locale] ?? EN;
}

export function fillCopy(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}
