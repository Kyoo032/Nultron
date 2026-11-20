import {
  ApiError,
  isProductMode,
  MAX_TEAM_BOTS,
  requireProductModes,
  resolveWorkspaceModes,
  sanitizeTeamBotProposal,
  teamBotSlug,
  TEAM_BOT_SLUG_PREFIX,
  type ProductMode,
} from "@agentforge/core";
import { db, listLocalWorkspaces, updateLocalWorkspace } from "@agentforge/db";
import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import { createTeamBot, delegationRoster, listTeamBots, releaseTeamBot } from "../team-bots";
import { proposeTeam } from "../team-propose";

/**
 * The team routes: who `delegate` may ask on this desk. `GET` reads the roster (hired modes plus
 * live bots); `propose` drafts a team from a brief; `hire` unions modes into the desk's
 * `productModes` and creates the bots; `release` removes a mode or tombstones a bot. Every answer
 * is the roster afterwards, so the caller never has to re-read.
 */

const BRIEF_MAX = 2_000;

/** The desk's current modes, read the same way `virtual-agents.ts` reads them. */
async function deskModes(tenant: { organizationId: string; workspaceId: string }): Promise<ProductMode[]> {
  const rows = await listLocalWorkspaces(db, tenant.organizationId);
  const desk = rows.find((row) => row.id === tenant.workspaceId);
  return resolveWorkspaceModes(desk?.productModes);
}

export async function handleGetTeam(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    return jsonOk(await delegationRoster(tenant));
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostTeamPropose(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const body = (request.body ?? {}) as { brief?: unknown };
    const brief = typeof body.brief === "string" ? body.brief.trim() : "";
    if (!brief || brief.length > BRIEF_MAX) {
      return jsonOk({ error: { code: "invalid_request", message: "A brief of 1 to 2000 characters is required" } }, 400);
    }
    return jsonOk(await proposeTeam(tenant, brief));
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostTeamHire(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const body = (request.body ?? {}) as { modes?: unknown; bots?: unknown };

    if (body.modes !== undefined) {
      const wanted = requireProductModes(body.modes);
      const current = await deskModes(tenant);
      const union = requireProductModes([...current, ...wanted]);
      if (union.join(",") !== current.join(",")) {
        await updateLocalWorkspace(db, tenant.organizationId, tenant.workspaceId, { productModes: union });
      }
    }

    const proposals = Array.isArray(body.bots) ? body.bots : [];
    const parsed = proposals
      .map((proposal) => sanitizeTeamBotProposal(proposal))
      .filter((proposal) => proposal !== null);
    if (parsed.length > 0) {
      const existing = await listTeamBots(tenant);
      const takenSlugs = new Set(existing.map((bot) => bot.slug));
      const remaining = Math.max(0, MAX_TEAM_BOTS - existing.length);
      let hired = 0;
      for (const proposal of parsed) {
        if (hired >= remaining) {
          break;
        }
        // Re-hiring the same set changes nothing: a live bot with this slug is skipped, not duplicated.
        if (takenSlugs.has(`${TEAM_BOT_SLUG_PREFIX}${teamBotSlug(proposal.name)}`)) {
          continue;
        }
        const bot = await createTeamBot(tenant, proposal);
        takenSlugs.add(bot.slug);
        hired += 1;
      }
    }

    return jsonOk(await delegationRoster(tenant));
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostTeamRelease(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const body = (request.body ?? {}) as { mode?: unknown; bot?: unknown };
    const mode = typeof body.mode === "string" ? body.mode.trim() : "";
    const bot = typeof body.bot === "string" ? body.bot.trim() : "";

    if (mode) {
      if (!isProductMode(mode)) {
        throw new ApiError("invalid_request", "Unknown mode", 400);
      }
      if (mode === "chat") {
        throw new ApiError("invalid_request", "The generalist agent cannot be released", 400);
      }
      const current = await deskModes(tenant);
      const next = current.filter((entry) => entry !== mode);
      if (next.length !== current.length) {
        await updateLocalWorkspace(db, tenant.organizationId, tenant.workspaceId, { productModes: next });
      }
    } else if (bot) {
      const released = await releaseTeamBot(tenant, bot);
      if (!released) {
        throw new ApiError("not_found", "No live team bot by that name", 404);
      }
    } else {
      throw new ApiError("invalid_request", "Name a mode or a bot to release", 400);
    }

    return jsonOk(await delegationRoster(tenant));
  } catch (error) {
    return jsonError(error);
  }
}

