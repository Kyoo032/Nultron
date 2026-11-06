import { ApiError } from "@agentforge/core";
import { FINANCE_IMPORT_MAX_ROWS } from "@agentforge/core/finance";

export const REQUEST_ARRAY_MAX = FINANCE_IMPORT_MAX_ROWS * 2;

export function assertArraysWithin(value: unknown, label: string, max: number = REQUEST_ARRAY_MAX): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== "object") {
      continue;
    }
    if (Array.isArray(node)) {
      if (node.length > max) {
        throw new ApiError("invalid_request", `${label} has a list over ${max} items`, 400);
      }
      for (const item of node) {
        pending.push(item);
      }
    } else {
      for (const item of Object.values(node)) {
        pending.push(item);
      }
    }
  }
}
