/**
 * Formal check of the paid media gate (SR-167). Run by the project skill `verify-paid-media-gate`
 * (`.claude/skills/verify-paid-media-gate/SKILL.md`) and by `ci:local` with the rest of core's tests.
 *
 * The promise: a paid picture or clip starts only for a request the person pressed Run on, and one
 * Run press starts it at most once. This file checks the real gate (`createMediaPermission`,
 * `invokeToolGuarded`) against a specification written here that uses no hash:
 *
 *   1. Every call sequence up to a stated bound, against every grant list up to a stated bound
 *      (`BOUND`). A pass covers all of them, not a sample.
 *   2. A random search over the same specification at a larger size.
 *   3. Parallel calls through the real `invokeToolGuarded`.
 *   4. The specification run against four deliberately wrong gates, so the check cannot go
 *      vacuous: if it ever stops failing them, it has stopped looking.
 *   5. The findings, as pinned counterexamples (`it.fails`). A finding stays red-by-design until the
 *      code is fixed; the day it is fixed `it.fails` itself fails, and the fix flips it to `it`.
 *
 * Not covered here: the host's reading of the request body (`paid-media-body.test.ts`), which
 * entries into a run carry the gate (`packages/host/src/paid-media-reach.property.test.ts`), the web
 * card, and whether a gateway price is what the card said.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { delegateToolKeys } from "../agents/delegation";
import { VIRTUAL_AGENTS } from "../agents/virtual-agents";
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

/**
 * The specification's name for "the same request": the tool and the normalised fields, as text. It
 * borrows `mediaRequestArgs` (what the card shows) and nothing else from the code under test, so a
 * key that merges two different requests shows up as a disagreement.
 */
function requestId(tool: PaidMediaTool, args: unknown): string {
  const picked = mediaRequestArgs(tool, args);
  return JSON.stringify([tool, Object.keys(picked).sort().map((field) => [field, picked[field]])]);
}

/**
 * Plays `calls` against a gate built from `grants` and returns the first way the gate disagrees with
 * the specification, or null. The specification: a call starts exactly when an unspent grant names
 * the same request; starting it spends that grant; what starts is the request the grant named.
 */
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

// ---------------------------------------------------------------------------------------------
// The scope of the exhaustive pass. Stated here so the claim "all of them" has a size.
// ---------------------------------------------------------------------------------------------

/** Four requests: two pictures that differ in the prompt, two clips that differ in the model (a 8x list price). */
const CLASSES: readonly MediaRequest[] = [
  { tool: "image_generate", args: { prompt: "a red fox" } },
  { tool: "image_generate", args: { prompt: "a blue boat" } },
  { tool: "video_generate", args: { prompt: "a calm lake", model: "veo-3.1-lite", seconds: 12 } },
  { tool: "video_generate", args: { prompt: "a calm lake", model: "veo_3_1", seconds: 12 } },
];

/** What a model really sends for a class: the tidy form, and a form with every kind of noise a live model adds. */
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

/** Grant lists are multisets: order does not matter to the gate, so each is listed once, in class order. */
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

// ---------------------------------------------------------------------------------------------
// Wrong gates, to prove the specification can fail. Each is a bug someone could write.
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------

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

  it("gives a delegated run neither paid tool, whichever agent it asks", () => {
    for (const agent of VIRTUAL_AGENTS) {
      for (const tool of PAID_MEDIA_TOOLS) {
        expect(delegateToolKeys(agent), `${agent.id} delegated`).not.toContain(tool);
      }
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
  /**
   * F1: the identity of a request is a 64-bit non-cryptographic fingerprint (`fingerprint` in
   * `media-permission.ts`, whose own comment says "Not a security hash"), so two different requests
   * can share a key, and a grant for one then lets the other start. These two are the same length
   * up to the tail, and were found with a collision search over a five-character tail (the search is
   * described in the skill; it took about five minutes on four cores). Both are 12-second clips; the
   * second is on a model that lists at 8x the price per second (`media-pricing.ts`: `veo-3.1-lite`
   * 0.05 USD/s, `veo_3_1` 0.40 USD/s at 720p). The tails are the only odd part of the prompts.
   */
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
  expect(countCases()).toBe(
    // grant lists: 1 + 4 + 10 = 15; call sequences over 8 calls: 1 + 8 + 64 + 512 = 585
    15 * 585,
  );
});
