/**
 * `POST /api/v1/finance/auto` — a file's figures, matched to the Finance task they fit, with a free
 * preview of the KPIs and charts (docs/internal/doc-flow-plan.md section 3).
 *
 * Lane W registered the route; the body is `finance-tasks/auto.ts`. The owner's rule (plan 7a.1) is
 * that nothing paid runs on a drop: this answers the free code-only preview, and the write-up is the
 * existing `/finance/stream`, on a button.
 *
 * Deliberately NOT behind `requireGatewayAllowedFor`, exactly like `POST /finance/import`: the route
 * is code only (redact, score, parse with `assists: false`, compute, preview) and never reaches the
 * gateway, so a closed gate must not stop the owner seeing their own figures. The paid narrative is
 * the existing `POST /finance/stream`, behind a Run button (plan 7a.1). If a model call ever creeps
 * into this route, it needs the gate and the plan needs a new owner answer, not a quiet edit here.
 *
 * It is not a by-id route, so the tenancy harness does not list it. It still resolves the tenant
 * first, so a hosted request is scoped to the signed-in caller's own desk like every other Finance
 * route.
 */
import type { TenantContext } from "@agentforge/core";
import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { runFinanceAuto } from "../finance-tasks/auto";
import { getTenant } from "../tenant";

/**
 * The tenant and the request: a JSON body of `{ figuresText, proseText?, sheetNames?, prompt?, locale? }`
 * (the first three are what `POST /finance/import` answered). Answers
 * `{ fits, task, input, preview, rowsUsed, unplaced, warnings, pii, prompt, promptSource }`; the shape is
 * `FinanceAutoResult` in `finance-tasks/auto.ts`.
 */
export type FinanceAutoHandler = (tenant: TenantContext, request: HostRequest) => Promise<HostResult> | HostResult;

const financeAuto: FinanceAutoHandler = async (tenant, request) =>
  jsonOk(await runFinanceAuto(tenant, request.body ?? null));

export async function handlePostFinanceAuto(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    return await financeAuto(tenant, request);
  } catch (error) {
    return jsonError(error);
  }
}
