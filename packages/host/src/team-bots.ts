import { db, DrizzleAgentRepository } from "@agentforge/db";
import {
  ApiError,
  DEFAULT_CHAT_TOOLS,
  isDelegableAgent,
  isTeamBotSlug,
  productModeLabel,
  TEAM_BOT_CONFIG_KEY,
  TEAM_BOT_ROLE_KEY,
  TEAM_BOT_SLUG_PREFIX,
  teamBotSlug,
  sanitizeTeamBotProposal,
  type AgentRecord,
  type AgentVersionRecord,
  type TeamBotProposal,
  type TeamBotView,
  type TeamRoster,
  type TenantContext,
  type VirtualAgent,
} from "@agentforge/core";
import { agentService } from "./tenant";
import { defaultSelectableModel, listSelectableModels } from "./selectable-models";
import { hiredAgentModes, hiredAgentRow } from "./virtual-agents";

/**
 * Team bots on the host: the custom agents a desk hires next to the catalog specialists, so
 * `delegate` has more than the mode list to ask. A bot is an ordinary agent row — slug `tb-…`,
 * published version `config.teamBot === true` with its `role` — that owns its own threads like any
 * agent. What a delegated run of a bot may do is decided in code at ask time
 * (`delegation/run-delegation.ts`), never from the row's stored bindings, the same rule a mode
 * agent's row follows.
 *
 * Releasing a bot is a tombstone, not a delete: the published version's `config.teamBot` flips to
 * `false`, so the row and every conversation it owns stay, and it simply stops being delegatable.
 */

const repo = new DrizzleAgentRepository(db);

function roleOf(version: AgentVersionRecord): string {
  const role = version.config?.[TEAM_BOT_ROLE_KEY];
  return typeof role === "string" ? role : "";
}

function viewOf(row: AgentRecord, version: AgentVersionRecord): TeamBotView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    role: roleOf(version),
    description: row.description,
  };
}

/** The desk's live team bots with their published versions, in row order. Tombstones are out. */
async function teamBotRows(
  tenant: TenantContext,
): Promise<Array<{ row: AgentRecord; version: AgentVersionRecord }>> {
  const rows = await repo.listAgents(tenant.organizationId, tenant.workspaceId);
  const bots: Array<{ row: AgentRecord; version: AgentVersionRecord }> = [];
  for (const row of rows) {
    if (!isTeamBotSlug(row.slug) || !row.currentVersionId) {
      continue;
    }
    const version = await repo.findVersionById(tenant.organizationId, row.currentVersionId);
    if (version && version.config?.[TEAM_BOT_CONFIG_KEY] === true) {
      bots.push({ row, version });
    }
  }
  return bots;
}

/** The desk's live team bots, as the team routes and `delegate`'s roster line see them. */
export async function listTeamBots(tenant: TenantContext): Promise<TeamBotView[]> {
  return (await teamBotRows(tenant)).map(({ row, version }) => viewOf(row, version));
}

/**
 * Hires one bot: an agent row with a `tb-` slug, the desk's default model, Chat's input modalities
 * minus video (a bot is asked in text), and Chat's own tool set bound so it can also hold a
 * conversation of its own. The slug is suffixed until free, so a tombstoned bot's slug is never
 * reused — its old conversations keep their owner.
 */
export async function createTeamBot(tenant: TenantContext, proposal: TeamBotProposal): Promise<TeamBotView> {
  const parsed = sanitizeTeamBotProposal(proposal);
  if (!parsed) {
    throw new ApiError("invalid_request", "A team bot needs a name and a prompt", 400);
  }
  const catalog = listSelectableModels(tenant);
  const model = defaultSelectableModel(catalog, tenant);
  const taken = new Set((await repo.listAgents(tenant.organizationId, tenant.workspaceId)).map((row) => row.slug));
  const base = teamBotSlug(parsed.name);
  let slug = `${TEAM_BOT_SLUG_PREFIX}${base}`;
  for (let suffix = 2; taken.has(slug); suffix += 1) {
    slug = `${TEAM_BOT_SLUG_PREFIX}${base}-${suffix}`;
    if (suffix > 99) {
      throw new ApiError("invalid_request", "No free slug left for this bot name", 400);
    }
  }
  const created = await agentService.create(
    tenant,
    {
      name: parsed.name,
      description: parsed.role,
      systemPrompt: parsed.prompt,
      model,
      inputModalities: ["text", "image"],
      productModes: ["chat"],
      visibility: "private",
      config: { [TEAM_BOT_CONFIG_KEY]: true, [TEAM_BOT_ROLE_KEY]: parsed.role },
    },
    catalog,
  );
  await agentService.publish(tenant, created.agent.id, created.version.id);
  for (const toolKey of DEFAULT_CHAT_TOOLS) {
    await agentService.bindTool(tenant, created.agent.id, created.version.id, toolKey);
  }
  // `agentService.create` slugifies the display name; a bot's slug is the `tb-` handle `delegate` takes.
  await repo.updateAgent(tenant.organizationId, created.agent.id, { slug, updatedAt: new Date() });
  const row = (await repo.findAgentById(tenant.organizationId, created.agent.id)) ?? {
    ...created.agent,
    slug,
  };
  return viewOf(row, created.version);
}

/**
 * Tombstones a bot by slug (or, failing that, by name): the published version's `config.teamBot`
 * flips to `false` in place — the same narrow update `updateGenerateDefaults` uses — so the row,
 * its threads and its runs all stay. True when a live bot was released.
 */
export async function releaseTeamBot(tenant: TenantContext, slugOrName: string): Promise<boolean> {
  const wanted = slugOrName.trim().toLowerCase();
  const bots = await teamBotRows(tenant);
  const found = bots.find(
    ({ row }) => row.slug.toLowerCase() === wanted || row.name.toLowerCase() === wanted,
  );
  if (!found) {
    return false;
  }
  await repo.updateVersion(tenant.organizationId, found.version.id, {
    config: { ...found.version.config, [TEAM_BOT_CONFIG_KEY]: false },
  });
  return true;
}

/** Who `delegate` may ask: a hired catalog mode, or one of the desk's live bots. */
export type DelegationTarget =
  | { readonly kind: "mode"; readonly agent: VirtualAgent; readonly row: AgentRecord }
  | {
      readonly kind: "bot";
      readonly bot: TeamBotView;
      readonly row: AgentRecord;
      readonly version: AgentVersionRecord;
    };

/**
 * Resolves the `agent` argument of `delegate`: a mode id goes through the same hired-agent path
 * as before; anything else is tried as a `tb-` slug and then as a bot's name, case-insensitively.
 * Null when the desk has nothing by that name.
 */
export async function resolveDelegatable(tenant: TenantContext, name: string): Promise<DelegationTarget | null> {
  const asked = name.trim();
  if (isDelegableAgent(asked)) {
    const hired = await hiredAgentRow(tenant, asked);
    return hired ? { kind: "mode", agent: hired.agent, row: hired.row } : null;
  }
  const wanted = asked.toLowerCase();
  const bots = await teamBotRows(tenant);
  const found = bots.find(({ row }) => row.slug.toLowerCase() === wanted || row.name.toLowerCase() === wanted);
  if (!found) {
    return null;
  }
  return { kind: "bot", bot: viewOf(found.row, found.version), row: found.row, version: found.version };
}

/** Everyone `delegate` may ask on this desk: the hired modes, then the live bots. */
export async function delegationRoster(tenant: TenantContext): Promise<TeamRoster> {
  const [modes, bots] = await Promise.all([hiredAgentModes(tenant), listTeamBots(tenant)]);
  return { modes, bots };
}

/**
 * The sentence a run's prompt gains so the model knows `delegate`'s real targets: the mode labels
 * and each bot's `name (role)`. Empty when the desk could ask nobody, so the prompt gains nothing.
 */
export function delegationTargetsLine(roster: TeamRoster): string {
  const parts: string[] = [];
  if (roster.modes.length > 0) {
    parts.push(roster.modes.map((mode) => productModeLabel(mode)).join(", "));
  }
  if (roster.bots.length > 0) {
    parts.push(roster.bots.map((bot) => `${bot.name} (${bot.role})`).join(", "));
  }
  if (parts.length === 0) {
    return "";
  }
  const [modes, ...rest] = parts;
  const bots = rest.join(", ");
  return bots
    ? `Agents you may delegate to: ${modes}; desk bots: ${bots}.`
    : `Agents you may delegate to: ${modes}.`;
}
