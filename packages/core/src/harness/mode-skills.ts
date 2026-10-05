/**
 * One harness per mode, packed from the 2026-09-25 skill list.
 *
 * A skill is a work or design ability of that mode. "has" means the pipeline already
 * does the work and this catalog only names it. "new" means this change wires it.
 * "off" means the ability exists and is deliberately not offered.
 *
 * The skills of a product mode live in its spec (`harness/modes/<mode>.ts`); this file derives the
 * catalog from them and adds Knowledge, which is a page and not a product mode, so it has no spec.
 *
 * Education-specific drafts live in the university pack. This file only names the skills.
 */

import { PRODUCT_MODE_IDS, productModeHref } from "../agents/product-modes";
import { MODE_HARNESS_SPECS } from "./specs";

export type HarnessSkillStatus = "has" | "new" | "off";

export type HarnessSkill = {
  id: string;
  name: string;
  status: HarnessSkillStatus;
};

export type ModeHarness = {
  id: string;
  route: string;
  skills: readonly HarnessSkill[];
};

const KNOWLEDGE_HARNESS: ModeHarness = {
  id: "knowledge",
  route: "/knowledge",
  skills: [
    { id: "soul-and-memory", name: "Set Soul and pinned memory", status: "has" },
    { id: "ingest-source", name: "Ingest a source", status: "has" },
    { id: "retrieve-into-chat", name: "Retrieve into Chat", status: "has" },
    { id: "map-and-verify", name: "Map and verify", status: "has" },
    { id: "read-file-stop-on-scan", name: "Read a file locally, and stop on a scan", status: "has" },
  ],
};

export const MODE_HARNESSES: readonly ModeHarness[] = [
  ...PRODUCT_MODE_IDS.map((id) => ({
    id,
    route: productModeHref(id),
    skills: MODE_HARNESS_SPECS[id].skills,
  })),
  KNOWLEDGE_HARNESS,
];

export function harnessFor(id: string): ModeHarness | undefined {
  return MODE_HARNESSES.find((harness) => harness.id === id);
}

/** Skills this change wires. Existing pipelines stay where they are. */
export function wiredSkillIds(): string[] {
  return MODE_HARNESSES.flatMap((harness) =>
    harness.skills.filter((skill) => skill.status === "new").map((skill) => `${harness.id}:${skill.id}`),
  );
}
