export function readRetryTurn(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  return (body as { retry?: unknown }).retry === true;
}

export function turnIsStored(rows: readonly { role: string; content: unknown }[], parts: unknown): boolean {
  const last = rows[rows.length - 1];
  return last !== undefined && last.role === "user" && JSON.stringify(last.content) === JSON.stringify(parts);
}
