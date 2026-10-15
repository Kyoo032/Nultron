import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentDeleteDialog } from "@/components/agent-delete-dialog";
import { applyLocale, resetLocaleForTests } from "./i18n";
import type { MadeAgent } from "./virtual-agents-made";

const MAKER_OWN: MadeAgent = { id: "ag_1", name: "Invoices", description: "Checks invoices", deletable: true };
const COLLEAGUE: MadeAgent = { id: "ag_2", name: "Procurement helper", description: "", deletable: true };

const COPY = {
  en: (name: string) =>
    `All chats with ${name} are deleted, with their messages, tool records and any cards they left in the Knowledge Base. Files and uploads stay. ${name} is taken out of any Workspace it was brought into; the Workspace keeps everything else it holds.`,
  id: (name: string) =>
    `Semua obrolan dengan ${name} dihapus, beserta pesan, catatan alat, dan kartu yang ditinggalkannya di Basis pengetahuan. Berkas dan unggahan tetap ada. ${name} dikeluarkan dari Workspace mana pun tempat ia dibawa; Workspace tetap menyimpan semua isinya yang lain.`,
};

function bodyOf(agent: MadeAgent): string {
  const html = renderToStaticMarkup(
    <AgentDeleteDialog agent={agent} onCancel={() => undefined} onDeleted={() => undefined} />,
  );
  const match = html.match(/data-testid="made-agent-delete-body"[^>]*>([^<]*)</);
  return match?.[1] ?? "";
}

describe("made agent delete confirm", () => {
  beforeEach(() => {
    resetLocaleForTests();
    applyLocale("en");
  });

  it("reads the same for the maker deleting their own agent and for an owner or admin deleting a colleague's", () => {
    expect(bodyOf(MAKER_OWN)).toBe(COPY.en("Invoices"));
    expect(bodyOf(COLLEAGUE)).toBe(COPY.en("Procurement helper"));
  });

  it("says every chat goes and files stay, and never that other people's chats stay", () => {
    for (const agent of [MAKER_OWN, COLLEAGUE]) {
      const body = bodyOf(agent);
      expect(body).toContain("All chats with");
      expect(body).toContain("Files and uploads stay.");
      expect(body).not.toContain("other people");
    }
  });

  it("reads the same shape in Indonesian", () => {
    applyLocale("id");
    expect(bodyOf(MAKER_OWN)).toBe(COPY.id("Invoices"));
    expect(bodyOf(COLLEAGUE)).toBe(COPY.id("Procurement helper"));
    expect(bodyOf(COLLEAGUE)).not.toContain("obrolan orang lain");
  });
});
