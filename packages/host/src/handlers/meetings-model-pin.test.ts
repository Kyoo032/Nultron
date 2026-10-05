/**
 * Meeting mode — the request field that pins a model.
 *
 * The studio sends `modelPinned: true` next to `model` only when its picker was changed
 * (`apps/web/lib/model-choice.ts`). The two stream routes must hand that on to the run as
 * `modelExplicit`, the way every other job route does, or the job model fallback may swap a model the
 * person chose (`meeting/pinned-model.test.ts` covers what the run does with it).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HostRequest, HostResult } from "../types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-meetings-pin-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

const run = vi.hoisted(() => ({
  generateMinutes: vi.fn(async () => ({ id: "m-1" })),
  runMeeting: vi.fn(async () => ({ id: "m-1" })),
}));

vi.mock("../meeting/run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../meeting/run")>()),
  generateMinutes: run.generateMinutes,
  runMeeting: run.runMeeting,
}));
// The gate has its own tests; here an open gate keeps the request on its way to the run.
vi.mock("../gateway-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway-gate")>()),
  requireGatewayAllowedFor: () => ({ allowed: true }),
}));

type Handlers = typeof import("./meetings");
let handlers: Handlers;

function request(body: unknown): HostRequest {
  return { method: "POST", path: "/", query: {}, params: { meetingId: "m-1" }, headers: {}, body };
}

/** Drain the stream so the job has run to its end before the assertions look at the mock. */
async function drain(result: HostResult): Promise<void> {
  if (result.type !== "stream") {
    throw new Error(`expected stream, got ${result.type}`);
  }
  for await (const _chunk of result.events) {
    // Nothing to read: the run is a mock.
  }
}

type RunOptions = { model?: string; modelExplicit?: boolean; translate?: boolean };

function optionsOf(mock: typeof run.generateMinutes | typeof run.runMeeting): RunOptions {
  const call = mock.mock.calls[0] as unknown as [unknown, string, RunOptions] | undefined;
  return call?.[2] ?? {};
}

beforeAll(async () => {
  handlers = await import("./meetings");
}, 60_000);

afterEach(() => {
  run.generateMinutes.mockClear();
  run.runMeeting.mockClear();
});

afterAll(async () => {
  // The kernel SQLite lives in dataDir; close it so Windows releases the file before cleanup.
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const ROUTES = [
  {
    name: "minutes/stream",
    call: (body: unknown) => handlers.handlePostMeetingMinutes(request(body)),
    mock: run.generateMinutes,
  },
  {
    name: "run/stream",
    call: (body: unknown) => handlers.handlePostMeetingRunStream(request(body)),
    mock: run.runMeeting,
  },
] as const;

describe.each(ROUTES)("POST meetings/:id/$name and the model pin", ({ call, mock }) => {
  it("hands a picked model on as modelExplicit", async () => {
    await drain(await call({ model: "gpt-5.6-sol", modelPinned: true, translate: true }));
    expect(optionsOf(mock)).toMatchObject({ model: "gpt-5.6-sol", modelExplicit: true, translate: true });
  });

  it("leaves a seeded default rescuable: the model without the pin is not explicit", async () => {
    await drain(await call({ model: "gpt-5.6-sol", translate: true }));
    expect(optionsOf(mock)).toMatchObject({ model: "gpt-5.6-sol", modelExplicit: false });
  });

  it("never pins a request that names no model", async () => {
    await drain(await call({ modelPinned: true }));
    expect(optionsOf(mock).modelExplicit).toBe(false);
  });

  it("refuses a truthy stand-in for the flag", async () => {
    await drain(await call({ model: "gpt-5.6-sol", modelPinned: "true" }));
    expect(optionsOf(mock).modelExplicit).toBe(false);
  });
});
