import { ApiError } from "@agentforge/core";
import { FINANCE_IMPORT_MAX_ROWS } from "@agentforge/core/finance";
import { HISTORY_BARS_MAX } from "@agentforge/core/market";

export type RequestLimits = Readonly<{ list: number; cost: number }>;

export const REQUEST_ARRAY_MAX = FINANCE_IMPORT_MAX_ROWS * 2;
export const REQUEST_COST_MAX = 60_000;
export const CONTAINER_COST = 6;

export const REQUEST_LIMITS: RequestLimits = { list: REQUEST_ARRAY_MAX, cost: REQUEST_COST_MAX };
export const BRIEFING_LIMITS: RequestLimits = { list: HISTORY_BARS_MAX + 200, cost: 250_000 };

function costOf(value: unknown): number {
  return value !== null && typeof value === "object" ? CONTAINER_COST : 1;
}

export function assertRequestWithin(
  value: unknown,
  label: string,
  limits: RequestLimits = REQUEST_LIMITS,
): void {
  const tooLarge = () =>
    new ApiError(
      "invalid_request",
      `${label} is larger than a request may be (over ${limits.cost} units, an object or list counting ${CONTAINER_COST} and any other value 1)`,
      400,
    );
  const pending: unknown[] = [value];
  let cost = costOf(value);
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== "object") {
      continue;
    }
    if (Array.isArray(node) && node.length > limits.list) {
      throw new ApiError("invalid_request", `${label} has a list over ${limits.list} items`, 400);
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      cost += costOf(child);
      if (cost > limits.cost) {
        throw tooLarge();
      }
      pending.push(child);
    }
  }
}
