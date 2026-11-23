import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { delegateToolKeys } from "../agents/delegation";
import { FULL_CHAT_TOOLS, VIRTUAL_AGENTS } from "../agents/virtual-agents";
import { MODE_HARNESS_SPECS } from "../harness/specs";
import { defineTool } from "../tools/define-tool";
import { invokeToolGuarded } from "./invoke-guarded";
import {
  createMediaPermission,
  mediaRequestArgs,
  mediaRequestKey,
  PAID_MEDIA_TOOLS,
  type MediaPermission,
  type MediaRequest,
  type PaidMediaTool,
} from "./media-permission";

const tenant = { tenantId: "t", workspaceId: "w", userId: "u" } as never;

type Call = { readonly tool: PaidMediaTool; readonly args: Record<string, unknown> };
type Gate = Pick<MediaPermission, "beforeCall" | "argsToRun">;

function requestId(tool: PaidMediaTool, args: unknown): string {
  const picked = mediaRequestArgs(tool, args);
  return JSON.stringify([tool, Object.keys(picked).sort().map((field) => [field, picked[field]])]);
}

function firstViolation(makeGate: (grants: MediaRequest[]) => Gate, grants: MediaRequest[], calls: Call[]): string | null {
  const gate = makeGate(grants);
  const unspent = new Map<string, number>();
  for (const grant of grants) {
    const id = requestId(grant.tool, grant.args);
    unspent.set(id, (unspent.get(id) ?? 0) + 1);
  }
  for (const [index, call] of calls.entries()) {
    const id = requestId(call.tool, call.args);
    const left = unspent.get(id) ?? 0;
    const refusal = gate.beforeCall(call.tool, call.args);
    if (refusal === null && left === 0) {
      return `call ${index} (${id}) started with no unspent grant for it`;
    }
    if (refusal !== null && left > 0) {
      return `call ${index} (${id}) was refused while a grant for it was unspent`;
    }
    if (refusal === null) {
      unspent.set(id, left - 1);
      const ran = gate.argsToRun(call.tool, call.args);
      if (requestId(call.tool, ran) !== id || JSON.stringify(sorted(ran)) !== JSON.stringify(sorted(mediaRequestArgs(call.tool, call.args)))) {
        return `call ${index} (${id}) ran with fields other than the ones the card showed: ${JSON.stringify(ran)}`;
      }
    }
  }
  return null;
}

function sorted(value: unknown): [string, unknown][] {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.keys(record).sort().map((field) => [field, record[field]]);
}

const realGate = (grants: MediaRequest[]): Gate => {
  const gate = createMediaPermission({ ask: true, grants });
  if (!gate) {
    throw new Error("an asking policy must build a gate");
  }
  return gate;
};

const CLASSES: readonly MediaRequest[] = [
  { tool: "image_generate", args: { prompt: "a red fox" } },
  { tool: "image_generate", args: { prompt: "a blue boat" } },
  { tool: "video_generate", args: { prompt: "a calm lake", model: "veo-3.1-lite", seconds: 12 } },
  { tool: "video_generate", args: { prompt: "a calm lake", model: "veo_3_1", seconds: 12 } },
];

function variants(request: MediaRequest): Call[] {
  const tidy: Call = { tool: request.tool, args: { ...request.args } };
  const noisy: Call = {
    tool: request.tool,
    args: {
      ...request.args,
      prompt: `  ${String(request.args.prompt).replace(" ", "\n  ")} `,
      image_url: "https://example.com/",
      style: "none",
      quality: "hd",
      n: 4,
      ...(request.args.model === undefined ? { model: "default" } : {}),
    },
  };
  return [tidy, noisy];
}

const BOUND = { grantsMax: 2, callsMax: 3 } as const;

function* sequences<T>(pool: readonly T[], maxLength: number): Generator<T[]> {
  yield [];
  if (maxLength === 0) {
    return;
  }
  for (const head of pool) {
    for (const tail of sequences(pool, maxLength - 1)) {
      yield [head, ...tail];
    }
  }
}

function* grantLists(maxLength: number, from = 0): Generator<MediaRequest[]> {
  yield [];
  if (maxLength === 0) {
    return;
  }
  for (let index = from; index < CLASSES.length; index += 1) {
    for (const rest of grantLists(maxLength - 1, index)) {
      yield [CLASSES[index] as MediaRequest, ...rest];
    }
  }
}

function countCases(): number {
  const calls = CLASSES.flatMap(variants);
  let total = 0;
  for (const _ of grantLists(BOUND.grantsMax)) {
    for (const __ of sequences(calls, BOUND.callsMax)) {
      total += 1;
    }
  }
  return total;
}

const keyOf = (tool: PaidMediaTool, args: unknown) => requestId(tool, args);

function wrongGate(kind: "never-spends" | "any-grant-opens" | "raw-args-run" | "forgets-noise"): (grants: MediaRequest[]) => Gate {
  return (grants) => {
    const open = new Map<string, number>();
    for (const grant of grants) {
      const id = kind === "forgets-noise" ? JSON.stringify([grant.tool, grant.args]) : keyOf(grant.tool, grant.args);
      open.set(id, (open.get(id) ?? 0) + 1);
    }
    return {
      beforeCall(tool, args) {
        const id = kind === "forgets-noise" ? JSON.stringify([tool, args]) : keyOf(tool as PaidMediaTool, args);
        const refusal = { ok: false, reason: "permission", message: "", request: { tool, args: {} } } as never;
        if (kind === "any-grant-opens") {
          return grants.some((grant) => grant.tool === tool) ? null : refusal;
        }
        const left = open.get(id) ?? 0;
        if (left === 0) {
          return refusal;
        }
        if (kind !== "never-spends") {
          open.set(id, left - 1);
        }
        return null;
      },
      argsToRun: (tool, args) => (kind === "raw-args-run" ? args : mediaRequestArgs(tool as PaidMediaTool, args)),
    };
  };
}

describe("the paid media gate agrees with its specification", () => {
  it(`holds for every call sequence up to ${BOUND.callsMax} against every grant list up to ${BOUND.grantsMax}`, () => {
    const calls = CLASSES.flatMap(variants);
    let checked = 0;
    for (const grants of grantLists(BOUND.grantsMax)) {
      for (const sequence of sequences(calls, BOUND.callsMax)) {
        const violation = firstViolation(realGate, grants, sequence);
        if (violation) {
          throw new Error(`${violation}\n  grants: ${JSON.stringify(grants)}\n  calls: ${JSON.stringify(sequence)}`);
        }
        checked += 1;
      }
    }
    expect(checked).toBe(countCases());
    expect(checked).toBeGreaterThan(8000);
  });

  it("holds on a random search at a larger size", () => {
    const callArb = fc.constantFrom(...CLASSES.flatMap(variants));
    const grantArb = fc.constantFrom(...CLASSES);
    fc.assert(
      fc.property(fc.array(grantArb, { maxLength: 6 }), fc.array(callArb, { maxLength: 14 }), (grants, calls) => {
        expect(firstViolation(realGate, grants, calls)).toBeNull();
      }),
      { numRuns: 500 },
    );
  });

  it("starts at most one tool per grant when the model's calls run in parallel", async () => {
    let started = 0;
    const paid = defineTool({
      key: "video_generate",
      name: "fake",
      description: "fake",
      capability: "video_gen",
      schema: z.object({ prompt: z.string(), model: z.string().optional(), seconds: z.number().optional() }),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        started += 1;
        return { success: true };
      },
    } as never);
    const [lite, full] = [CLASSES[2], CLASSES[3]] as [MediaRequest, MediaRequest];
    const gate = realGate([lite, lite, full]);
    const burst = [lite, full, lite, lite, full, full, lite, full].map((request) =>
      invokeToolGuarded(paid, { ...request.args, style: "none" }, tenant, undefined, undefined, gate),
    );
    await Promise.all(burst);
    expect(started).toBe(3);
  });
});

describe("which tool sets can bind a paid tool", () => {
  it("lists image_generate and video_generate only in the Chat harness spec", () => {
    const carriers = Object.entries(MODE_HARNESS_SPECS)
      .filter(([, spec]) => PAID_MEDIA_TOOLS.some((tool) => spec.tools.includes(tool)))
      .map(([mode]) => mode);
    expect(
      carriers,
      "A job run binds only what its mode's harness spec lists and has no gate. A spec that lists a paid tool lets a studio or worker job spend with no Run press.",
    ).toEqual(["chat"]);
  });

  it("gives a delegated run neither paid tool, whichever agent or team bot it asks", () => {
    for (const agent of VIRTUAL_AGENTS) {
      for (const tool of PAID_MEDIA_TOOLS) {
        expect(delegateToolKeys(agent), `${agent.id} delegated`).not.toContain(tool);
      }
    }
    for (const tool of PAID_MEDIA_TOOLS) {
      expect(delegateToolKeys({ tools: FULL_CHAT_TOOLS }), "team bot delegated").not.toContain(tool);
    }
  });
});

describe("the specification can fail", () => {
  const calls = CLASSES.flatMap(variants);
  const wrong = ["never-spends", "any-grant-opens", "raw-args-run", "forgets-noise"] as const;

  for (const kind of wrong) {
    it(`catches a gate that ${{
      "never-spends": "never spends a grant",
      "any-grant-opens": "opens for any request of a tool the person approved one of",
      "raw-args-run": "runs the model's own fields instead of the card's",
      "forgets-noise": "does not see through whitespace, placeholders and extra fields",
    }[kind]}`, () => {
      let caught: string | null = null;
      for (const grants of grantLists(BOUND.grantsMax)) {
        for (const sequence of sequences(calls, BOUND.callsMax)) {
          caught ??= firstViolation(wrongGate(kind), grants, sequence);
        }
      }
      expect(caught).not.toBeNull();
    });
  }
});

describe("findings (pinned counterexamples; each flips to a plain `it` when its fix lands)", () => {
  const CHEAP: MediaRequest = {
    tool: "video_generate",
    args: { prompt: "a calm lake at dawn, soft light \u764b\u6215\u7d25\u8410\u4e24", model: "veo-3.1-lite", seconds: 12 },
  };
  const DEAR: MediaRequest = {
    tool: "video_generate",
    args: { prompt: "a calm lake at dawn, very soft light \u59b0\u87d6\u7e90\u5028\u4e4b", model: "veo_3_1", seconds: 12 },
  };

  it("the pair is two different requests", () => {
    expect(requestId(CHEAP.tool, CHEAP.args)).not.toBe(requestId(DEAR.tool, DEAR.args));
    expect(mediaRequestArgs(DEAR.tool, DEAR.args).model).toBe("veo_3_1");
    expect(mediaRequestArgs(CHEAP.tool, CHEAP.args).model).toBe("veo-3.1-lite");
  });

  it.fails("F1: two different requests never share a key", () => {
    expect(mediaRequestKey(CHEAP.tool, CHEAP.args)).not.toBe(mediaRequestKey(DEAR.tool, DEAR.args));
  });

  it.fails("F1: a grant for the cheap clip never lets the dear clip start", () => {
    const gate = realGate([CHEAP]);
    expect(gate.beforeCall(DEAR.tool, DEAR.args)).not.toBeNull();
  });
});

it("reports the size of the exhaustive pass", () => {
  const grantListCount = 1 + 4 + 10;
  const callSequenceCount = 1 + 8 + 64 + 512;
  expect(countCases()).toBe(grantListCount * callSequenceCount);
});
