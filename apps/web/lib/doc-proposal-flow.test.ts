import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askAgentOptions,
  askSection,
  agentNameOf,
  chosenSectionId,
  discardProposal,
  GENERALIST_AGENT_ID,
  keepProposal,
  pendingProposalFor,
  restoreVersion,
  withPendingProposal,
  withoutProposal,
} from "@/components/doc-page/doc-proposal-flow";
import { DocsError, errorFromPayload, parseDocPage, type DocProposal } from "@/lib/docs-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Reply = { readonly status: number; readonly body: unknown };
type Call = { readonly url: string; readonly method: string; readonly body: unknown };

function stubFetch(replies: readonly Reply[]): Call[] {
  const calls: Call[] = [];
  const queue = [...replies];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      calls.push({
        url: String(input),
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`unexpected request ${String(input)}`);
      }
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const PENDING: DocProposal = {
  id: "p1",
  artifactId: "art_1",
  sectionId: "s2",
  section: { id: "s2", heading: "2. What competitors charge", blocks: [{ type: "paragraph", text: "Pro at 49." }] },
  baseVersion: 5,
  agentId: "research",
  askedByUserId: "user_budi",
  status: "pending",
  keptVersion: null,
  createdAt: 1_000,
  updatedAt: 1_000,
};

const KEPT: DocProposal = { ...PENDING, status: "kept", keptVersion: 6, updatedAt: 2_000 };

const ASK = { agentId: "research", instruction: "Use the brochure.", baseVersion: 5 };

const nestedError = (code: string, status: number, extra: Record<string, unknown> = {}) => ({
  status,
  body: { error: { code, message: `${code} message`, ...extra } },
});

describe("the ask, keep and discard runners through the real client", () => {
  it("asks, shows the proposal as pending, and keeps it", async () => {
    const calls = stubFetch([
      { status: 201, body: { proposal: PENDING } },
      { status: 200, body: { proposal: KEPT, headVersion: 6, version: null, sectionAuthors: {}, bodyRefreshed: true } },
    ]);

    const asked = await askSection("art_1", "s2", ASK);
    expect(asked).toEqual({ ok: true, value: PENDING });
    expect(withPendingProposal([], PENDING)).toEqual([PENDING]);

    const kept = await keepProposal(PENDING);
    expect(kept).toEqual({ ok: true, value: KEPT });
    expect(withoutProposal([PENDING], PENDING.id)).toEqual([]);

    expect(calls).toEqual([
      { url: "/api/v1/docs/art_1/sections/s2/proposals", method: "POST", body: ASK },
      { url: "/api/v1/docs/proposals/p1/keep", method: "POST", body: {} },
    ]);
  });

  it("discards a pending proposal", async () => {
    const calls = stubFetch([{ status: 200, body: { proposal: { ...PENDING, status: "discarded" } } }]);

    const discarded = await discardProposal(PENDING);

    expect(discarded).toMatchObject({ ok: true, value: { id: "p1", status: "discarded" } });
    expect(calls).toEqual([{ url: "/api/v1/docs/proposals/p1/discard", method: "POST", body: {} }]);
  });

  it("try again sends the same instruction again, and the new proposal replaces the pending one for that section", async () => {
    const retried: DocProposal = { ...PENDING, id: "p2", baseVersion: 6, updatedAt: 3_000 };
    const calls = stubFetch([{ status: 201, body: { proposal: retried } }]);

    const again = await askSection("art_1", "s2", {
      agentId: "research",
      instruction: "Use the brochure.",
      baseVersion: 6,
    });

    expect(again.ok).toBe(true);
    expect(calls[0]).toEqual({
      url: "/api/v1/docs/art_1/sections/s2/proposals",
      method: "POST",
      body: { agentId: "research", instruction: "Use the brochure.", baseVersion: 6 },
    });
    const pending = withPendingProposal([PENDING, { ...PENDING, id: "other", sectionId: "s3" }], retried);
    expect(pending.map((proposal) => proposal.id)).toEqual(["other", "p2"]);
    expect(pendingProposalFor(pending, "s2")?.id).toBe("p2");
  });

  it("reports a keep refused as section_changed, so the page can say so and offer Try again", async () => {
    stubFetch([nestedError("section_changed", 409, { sectionIds: ["s2"] })]);

    expect(await keepProposal(PENDING)).toEqual({ ok: false, failure: "section_changed" });
  });

  it("reports a keep of a proposal that is gone as gone, not as a generic failure", async () => {
    stubFetch([nestedError("not_found", 404)]);

    expect(await keepProposal(PENDING)).toEqual({ ok: false, failure: "gone" });
  });

  it("reports a discard of a proposal that is gone as gone", async () => {
    stubFetch([nestedError("not_found", 404)]);

    expect(await discardProposal(PENDING)).toEqual({ ok: false, failure: "gone" });
  });

  it("reports a flat gateway_blocked refusal as gateway_blocked, the way the host writes it", async () => {
    stubFetch([{ status: 403, body: { error: "gateway_blocked", status: "invalid_key", message: "No key." } }]);

    const outcome = await askSection("art_1", "s2", ASK);

    expect(outcome).toEqual({ ok: false, failure: "gateway_blocked" });
  });

  it("reports agent_not_in_workspace as its own failure", async () => {
    stubFetch([nestedError("agent_not_in_workspace", 403)]);

    expect(await askSection("art_1", "s2", ASK)).toEqual({ ok: false, failure: "agent_not_in_workspace" });
  });

  it("reports section_changed on the ask as section_changed", async () => {
    stubFetch([nestedError("section_changed", 409, { sectionIds: ["s2"] })]);

    expect(await askSection("art_1", "s2", ASK)).toEqual({ ok: false, failure: "section_changed" });
  });

  it("reports any other ask failure as failed, including a section that does not exist", async () => {
    stubFetch([nestedError("section_not_found", 404)]);

    expect(await askSection("art_1", "s9", ASK)).toEqual({ ok: false, failure: "failed" });
  });
});

describe("restoring a version", () => {
  it("posts the base version and reports the new head", async () => {
    const calls = stubFetch([
      {
        status: 201,
        body: {
          headVersion: 7,
          version: {
            version: 7,
            kind: "document",
            changedSectionIds: ["s2"],
            baseVersion: 6,
            note: "restored v3",
            author: { kind: "person", userId: "user_me" },
            createdAt: 4_000,
          },
          sectionAuthors: {},
          bodyRefreshed: true,
        },
      },
    ]);

    const outcome = await restoreVersion("art_1", 3, 6);

    expect(outcome.ok && outcome.value.headVersion).toBe(7);
    expect(calls).toEqual([{ url: "/api/v1/docs/art_1/versions/3/restore", method: "POST", body: { baseVersion: 6 } }]);
  });

  it("reports a 409 as a conflict, and any other refusal as failed", async () => {
    stubFetch([nestedError("bad_base", 409)]);
    expect(await restoreVersion("art_1", 3, 99)).toEqual({ ok: false, failure: "conflict" });

    stubFetch([nestedError("not_found", 404)]);
    expect(await restoreVersion("art_1", 99, 6)).toEqual({ ok: false, failure: "failed" });
  });
});

describe("errorFromPayload", () => {
  it("reads the flat gateway_blocked body as its own code", () => {
    const error = errorFromPayload({ error: "gateway_blocked", status: "needs_key" }, 403);
    expect(error).toBeInstanceOf(DocsError);
    expect(error.code).toBe("gateway_blocked");
    expect(error.status).toBe(403);
  });
});

describe("the proposal list helpers", () => {
  it("keeps only one pending proposal per section", () => {
    const first = PENDING;
    const second = { ...PENDING, id: "p2" };
    expect(withPendingProposal([first], second)).toEqual([second]);
  });

  it("finds the pending proposal of a section, if there is one", () => {
    expect(pendingProposalFor([PENDING], "s2")).toEqual(PENDING);
    expect(pendingProposalFor([PENDING], "s1")).toBeUndefined();
  });
});

describe("the agents an ask can name", () => {
  it("lists the general assistant first, under the brand's name, then the brought-in agents without repeats", () => {
    const options = askAgentOptions("Ada", ["research", GENERALIST_AGENT_ID, "documents", "research"]);
    expect(options.map((option) => option.id)).toEqual([GENERALIST_AGENT_ID, "research", "documents"]);
    expect(options[0]).toEqual({ id: GENERALIST_AGENT_ID, label: "Ada" });
  });

  it("offers only the general assistant when the file is not in a Workspace", () => {
    expect(askAgentOptions("Ada", [])).toEqual([{ id: GENERALIST_AGENT_ID, label: "Ada" }]);
  });

  it("names the general assistant by the brand, and a brought-in agent by its own label", () => {
    expect(agentNameOf(GENERALIST_AGENT_ID, "Ada")).toBe("Ada");
    expect(agentNameOf("research", "Ada")).not.toBe("Ada");
  });

  it("keeps a chosen section when it still exists, and falls back to the first one when it does not", () => {
    expect(chosenSectionId(["s1", "s2"], "s2")).toBe("s2");
    expect(chosenSectionId(["s1", "s2"], "gone")).toBe("s1");
    expect(chosenSectionId([], "gone")).toBe("");
  });
});

describe("the parsed document page carries the proposals the block draws", () => {
  it("parses a pending proposal from the page read", () => {
    const doc = parseDocPage({
      artifactId: "art_1",
      title: "Memo",
      kind: "document",
      headVersion: 5,
      spec: {
        kind: "document",
        title: "Memo",
        theme: "plain",
        titlePage: false,
        sections: [{ id: "s2", heading: "2. Competitors", blocks: [{ type: "paragraph", text: "Old." }] }],
      },
      sectionAuthors: {},
      proposals: [PENDING],
    });
    expect(pendingProposalFor(doc.proposals, "s2")?.id).toBe("p1");
  });
});
