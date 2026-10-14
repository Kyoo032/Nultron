/**
 * "Add to Workspace" on the chat file cards that carry an artifact id (team-board-spec.md section 2b).
 * It draws only on the hosted build: on Personal it is not there at all, so the desk is unchanged.
 * The host decides whether a file may be added; this test only checks what the card draws.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddToWorkspace } from "@/components/add-to-workspace";
import { DossierCard } from "@/components/chat-dossier-card";
import { readDossierResult, type DossierCardModel } from "@/components/tool-rows/dossier-result";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";

afterEach(() => {
  vi.unstubAllGlobals();
  resetLocaleForTests();
});

const DOSSIER_INPUT = { question: "How are small shops in Jakarta adopting QRIS?" };
const DOSSIER_OUTPUT = {
  ok: true,
  artifact: { id: "art-7", kind: "research", title: "QRIS adoption in Jakarta" },
  summary: "Adoption is wide but shallow.",
  sections: ["Adoption today"],
  sourceCount: 12,
  checks: { passed: true, rounds: 1, failed: [] },
};

function dossier(over: Partial<DossierCardModel> = {}): DossierCardModel {
  const read = readDossierResult(DOSSIER_INPUT, DOSSIER_OUTPUT);
  if (!read) {
    throw new Error("fixture does not read");
  }
  return { ...read, ...over };
}

const hosted = () => vi.stubGlobal("__AGENTFORGE_SERVER__", "1");

describe("Add to Workspace on Personal", () => {
  it("draws nothing at all, so a Personal desk keeps the card it had", () => {
    expect(renderToStaticMarkup(<AddToWorkspace artifactId="art-7" />)).toBe("");
  });

  it("draws nothing on a dossier card either", () => {
    expect(renderToStaticMarkup(<DossierCard model={dossier()} />)).not.toContain("add-to-workspace");
  });
});

describe("Add to Workspace on the hosted build", () => {
  it("draws the menu button on the dossier card when the dossier is saved", () => {
    hosted();
    const html = renderToStaticMarkup(<DossierCard model={dossier()} />);
    expect(html).toContain('data-testid="add-to-workspace"');
    expect(html).toContain('data-testid="add-to-workspace-open"');
    expect(html.split('data-testid="add-to-workspace-open"').length - 1).toBe(1);
  });

  it("draws no menu on a dossier that was not saved, since there is no file to add", () => {
    hosted();
    const html = renderToStaticMarkup(<DossierCard model={dossier({ artifactId: null })} />);
    expect(html).not.toContain("add-to-workspace");
  });

  it("names the Workspace action in Indonesian from the id catalog", () => {
    hosted();
    applyLocale("id");
    const html = renderToStaticMarkup(<AddToWorkspace artifactId="art-7" />);
    expect(html).toContain(">Tambah ke ruang kerja</button>");
  });
});
