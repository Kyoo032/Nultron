/**
 * The Research checks note: which problems the page names for a host report, that it never shows the
 * host's English text, and that the note draws in both languages with real catalog strings.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchChecksNote } from "@/components/research-checks-note";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { researchChecksNote } from "./research-checks-view";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(resolve(here, relative), "utf8").replace(/\r\n/g, "\n");

const failed = (check: string) => ({
  ok: false,
  check,
  error: 'The answer cites source ids that do not exist: S9 in finding "Rates".',
  why: "Only the numbered sources in the prompt were read.",
  fix: "Replace each unknown id.",
});

const report = (verdicts: unknown[], passed = false) => ({ passed, rounds: 1, verdicts });

afterEach(() => resetLocaleForTests());

describe("researchChecksNote", () => {
  it("is nothing when the checks passed, or when there is no report", () => {
    expect(researchChecksNote(undefined)).toBeNull();
    expect(researchChecksNote(null)).toBeNull();
    expect(researchChecksNote("passed")).toBeNull();
    expect(researchChecksNote(report([{ ok: true }, { ok: true }], true))).toBeNull();
    expect(researchChecksNote({ passed: false, rounds: 1 })).toBeNull();
  });

  it("never turns a report that says it passed into a note, whatever its verdicts hold", () => {
    expect(researchChecksNote(report([failed("research-findings-cited")], true))).toBeNull();
  });

  it("names each failed check once, in a fixed order", () => {
    const all = report([
      failed("research-sections-filled"),
      { ok: true },
      failed("research-findings-cited"),
      failed("research-citations-resolve"),
      failed("research-findings-cited"),
    ]);
    expect(researchChecksNote(all)).toEqual({ problems: ["uncited", "unknownSources", "emptySections"] });
  });

  it("names only what failed", () => {
    expect(researchChecksNote(report([{ ok: true }, failed("research-citations-resolve")]))).toEqual({
      problems: ["unknownSources"],
    });
  });

  it("ignores a check it does not know and a verdict it cannot read", () => {
    expect(researchChecksNote(report([failed("something-else"), { ok: false }, null, "x", 3]))).toBeNull();
  });
});

describe("ResearchChecksNote", () => {
  it("draws nothing without a note", () => {
    expect(renderToStaticMarkup(<ResearchChecksNote note={null} />)).toBe("");
    expect(renderToStaticMarkup(<ResearchChecksNote note={{ problems: [] }} />)).toBe("");
  });

  it("says in plain words what is left, and that the dossier is saved", () => {
    const html = renderToStaticMarkup(
      <ResearchChecksNote note={{ problems: ["uncited", "unknownSources", "emptySections"] }} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('data-testid="research-checks-note"');
    expect(html).toContain('data-problems="uncited unknownSources emptySections"');
    expect(html).toContain("Some findings cite no source.");
    expect(html).toContain("Some citations point to sources this run did not read.");
    expect(html).toContain("Some sections came back empty.");
    expect(html).toContain("The dossier is saved.");
    expect(html).not.toContain("research.checks");
  });

  it("speaks Indonesian", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(<ResearchChecksNote note={{ problems: ["uncited"] }} />);
    expect(html).toContain("Sebagian temuan tidak mencantumkan sumber.");
    expect(html).toContain("Laporan sudah tersimpan.");
    expect(html).not.toContain("Some findings");
    expect(html).not.toContain("research.checks");
  });
});

describe("ResearchStudio wiring", () => {
  const studio = source("../components/research-studio.tsx");

  it("reads the checks off a fresh run and off a reopened dossier", () => {
    expect(studio).toContain("checks: researchChecksNote(checks)");
    expect(studio).toContain("checks: researchChecksNote(artifact.meta.checks)");
    // The report stays out of the notes the preview and the Markdown export read.
    expect(studio).toMatch(/const \{ artifactId, dossierId, dossier, checks, \.\.\.notes \} = result;/);
  });

  it("puts the note inside the result block, under the actions", () => {
    expect(studio.indexOf("<ArtifactActions")).toBeLessThan(studio.indexOf("<ResearchChecksNote"));
    expect(studio.indexOf("<ResearchChecksNote")).toBeLessThan(studio.indexOf("<ResearchPreview"));
  });
});
