import { apiFetch } from "./api-client";
import { ChannelError } from "./channels-client";

export type EmailChannel = {
  id: string;
  workspaceId: string;
  agentId: string;
  address: string;
  unknownSenderPolicy: "ignore" | "refuse";
  status: "active" | "disabled";
  createdAt: number;
  allowlistSize: number;
};

export type EmailAllowlistEntry = {
  id: string;
  channelId: string;
  pattern: string;
  userId: string | null;
};

function errorFrom(payload: unknown, fallback: string): ChannelError {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: { code?: unknown; message?: unknown } }).error;
    if (error && typeof error === "object") {
      const message = typeof error.message === "string" && error.message.trim() ? error.message : fallback;
      const code = typeof error.code === "string" ? error.code : "channel_error";
      return new ChannelError(code, message);
    }
  }
  return new ChannelError("channel_error", fallback);
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw errorFrom(data, fallback);
  }
  return data as T;
}

export async function loadEmailChannels(): Promise<EmailChannel[]> {
  const res = await apiFetch("/api/v1/channels/email");
  const data = await readJson<{ channels: EmailChannel[] }>(res, "Could not load the desk's email channels");
  return data.channels ?? [];
}

export async function createEmailChannel(input: {
  address: string;
  agentId: string;
  unknownSenderPolicy: "ignore" | "refuse";
}): Promise<EmailChannel> {
  const res = await apiFetch("/api/v1/channels/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<EmailChannel>(res, "Could not create the email channel");
}

export async function removeEmailChannel(channelId: string): Promise<void> {
  const res = await apiFetch(`/api/v1/channels/email/${encodeURIComponent(channelId)}`, { method: "DELETE" });
  await readJson(res, "Could not remove the email channel");
}

export async function loadEmailAllowlist(channelId: string): Promise<EmailAllowlistEntry[]> {
  const res = await apiFetch(`/api/v1/channels/email/${encodeURIComponent(channelId)}/allowlist`);
  const data = await readJson<{ entries: EmailAllowlistEntry[] }>(res, "Could not load the allowlist");
  return data.entries ?? [];
}

export async function addEmailAllowlistEntry(
  channelId: string,
  pattern: string,
  userId: string | null = null,
): Promise<EmailAllowlistEntry> {
  const res = await apiFetch(`/api/v1/channels/email/${encodeURIComponent(channelId)}/allowlist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pattern, userId }),
  });
  return readJson<EmailAllowlistEntry>(res, "Could not add the allowlist entry");
}

export async function removeEmailAllowlistEntry(channelId: string, entryId: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/channels/email/${encodeURIComponent(channelId)}/allowlist/${encodeURIComponent(entryId)}`,
    { method: "DELETE" },
  );
  await readJson(res, "Could not remove the allowlist entry");
}
