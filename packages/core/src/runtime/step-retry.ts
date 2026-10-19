export const STEP_RETRY_DELAYS_MS: readonly number[] = Object.freeze([400, 1200]);

const RETRY_STATUSES = new Set([502, 503]);

export type StepRetryGate = { sends: number };

export function takeStepSend(gate: StepRetryGate): boolean {
  const armed = gate.sends > 0;
  gate.sends += 1;
  return armed;
}

export type StepRetryOptions = {
  armed: boolean;
  signal?: AbortSignal | null;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function sendStepWithRetry(send: () => Promise<Response>, options: StepRetryOptions): Promise<Response> {
  const delays = options.delaysMs ?? STEP_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  let response = await send();
  if (!options.armed) {
    return response;
  }
  for (const delay of delays) {
    if (!RETRY_STATUSES.has(response.status)) {
      return response;
    }
    await response.body?.cancel().catch(() => undefined);
    await sleep(delay);
    options.signal?.throwIfAborted();
    response = await send();
  }
  return response;
}
