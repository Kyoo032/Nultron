import { t } from "./i18n";
import type { VirtualAgentInfo, VirtualAgentSkill } from "./virtual-agents";

/**
 * The words for what an agent is made of. The host sends the English skill `name` and the raw tool
 * keys; the catalog (`harness` namespace) says them in the owner's language. A key the catalog does
 * not know yet (a skill or tool added on the host first) still reads sensibly, so a new one never
 * shows a bare translation key.
 */

/** A catalog line, or null when the key is missing: `t()` hands the key back for a key it lacks. */
function catalogLine(key: string): string | null {
  const line = t(key);
  return line === key ? null : line;
}

export function skillLabel(modeId: string, skill: Pick<VirtualAgentSkill, "id" | "name">): string {
  return catalogLine(`harness.skills.${modeId}.${skill.id}`) ?? skill.name;
}

export function toolLabel(toolKey: string): string {
  return catalogLine(`harness.tools.${toolKey}`) ?? toolKey.replaceAll("_", " ");
}

export function loopLine(loop: VirtualAgentInfo["loop"]): string {
  return t(`harness.loop.${loop}`);
}

/** "6 model steps a turn", with the singular its own line so the count never reads "1 steps". */
export function stepsLine(count: number): string {
  return count === 1 ? t("harness.panel.stepsOne") : t("harness.panel.steps", { n: count });
}

export function callsLine(count: number): string {
  return count === 1 ? t("harness.panel.callsOne") : t("harness.panel.calls", { n: count });
}

/** What the harness does when a check fails: repair a few rounds, or only report. */
export function repairLine(rounds: number): string {
  if (rounds <= 0) {
    return t("harness.panel.noRepair");
  }
  return rounds === 1 ? t("harness.panel.repairOne") : t("harness.panel.repair", { n: rounds });
}
