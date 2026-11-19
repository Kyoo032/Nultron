export type ClientRuntimeEvent = {
  replace?: boolean;
  type: string;
  text?: string;
  toolKey?: string;
  input?: unknown;
  output?: unknown;
  message?: string;
  runId?: string;
  model?: string;
  /** `run.model_fallback`: the model that could not be reached and the one that answered in its place. */
  from?: string;
  to?: string;
  attempt?: number;
  attempts?: number;
};

export function consumeSse(buffer: string): { events: ClientRuntimeEvent[]; rest: string } {
  const chunks = buffer.split("\n\n");
  const rest = chunks.pop() ?? "";
  const events: ClientRuntimeEvent[] = [];
  for (const chunk of chunks) {
    const eventLine = chunk.split("\n").find((line) => line.startsWith("event:"));
    const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
    if (!eventLine || !dataLine) {
      continue;
    }
    try {
      const payload = JSON.parse(dataLine.replace(/^data:\s?/, "").trim()) as ClientRuntimeEvent;
      const type = eventLine.replace(/^event:\s?/, "").trim();
      events.push({ ...payload, type: payload.type || type });
    } catch {
      continue;
    }
  }
  return { events, rest };
}
