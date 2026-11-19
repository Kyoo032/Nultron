import { describe, expect, it } from "vitest";
import { CHOICE_PROFILES } from "./choice-profiles";
import { EVERYDAY_MODEL_IDS } from "./gateway-roles";
import { modelImageInput, PICTURE_MISREADS, type PictureMisread } from "./image-input";
import { JOB_FALLBACK_TAIL } from "./job-fallback";
import { JOB_MODE_PREFERENCES } from "./mode-defaults";
import { MODEL_POLICY_TABLE, modelPolicy } from "./model-policy";
import { CHAT_DEFAULT_PREFERENCES } from "./preferred";
import { bareModelId } from "./request-constraints";
import { isSupersededModel, SUPERSEDED_MODELS } from "./superseded";
import { FAST_TIER_GATEWAY_IDS, REASONING_TIER_GATEWAY_IDS } from "./tiers";

/**
 * Every id the product recommends, defaults to, or falls back on must be a model the policy table
 * knows. An id that is not gets the conservative unknown profile (no effort sent unless chosen, never
 * recommended, never a default), so a list that names one is a list that quietly does nothing.
 *
 * There is no allow-absent set any more: `hy3` entered the table on 2026-09-30 (probe), and the
 * `hy-3` / `hunyuan-3` / `hunyuan3` spellings, which the gateway never listed, left the lists. Do not
 * add an id to a list without adding it to `MODEL_POLICY_TABLE` with a `verified` note.
 */
const LISTS: Record<string, readonly string[]> = {
  CHAT_DEFAULT_PREFERENCES,
  EVERYDAY_MODEL_IDS: [...EVERYDAY_MODEL_IDS],
  JOB_FALLBACK_TAIL,
  ...Object.fromEntries(Object.entries(JOB_MODE_PREFERENCES).map(([mode, ids]) => [`JOB_MODE_PREFERENCES.${mode}`, ids])),
  // The Fastest and Reasoning tiers (Daily is CHAT_DEFAULT_PREFERENCES above) and the choice profiles, which
  // read the same two tier lists. Every profile, kind and provider is walked so a profile that later gets a
  // list of its own is covered without an edit here.
  FAST_TIER_GATEWAY_IDS: [...FAST_TIER_GATEWAY_IDS],
  REASONING_TIER_GATEWAY_IDS: [...REASONING_TIER_GATEWAY_IDS],
  ...Object.fromEntries(
    Object.values(CHOICE_PROFILES).flatMap((profile) =>
      Object.entries(profile.lists).flatMap(([kind, byProvider]) =>
        Object.entries(byProvider).map(([provider, refs]) => [
          `CHOICE_PROFILES.${profile.id}.${kind}.${provider}`,
          (refs ?? []).map((ref) => ref.model),
        ]),
      ),
    ),
  ),
};

/** The ids the 2026-09-30 recommendations name that were probed live and so have an entry of their own. */
const PROBED_2026_09_30 = [
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6-astra",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "deepseek-v4-1-flash",
  "hy3",
];

describe("preference lists only name models the policy table knows", () => {
  for (const [name, ids] of Object.entries(LISTS)) {
    it(name, () => {
      const unknown = ids.filter((id) => !modelPolicy(id).known);
      expect(unknown).toEqual([]);
    });
  }

  it("covers the meeting minutes list and every job mode", () => {
    expect(Object.keys(LISTS)).toEqual(
      expect.arrayContaining([
        "JOB_MODE_PREFERENCES.meeting",
        "JOB_MODE_PREFERENCES.documents",
        "JOB_MODE_PREFERENCES.finance",
        "JOB_MODE_PREFERENCES.legal",
      ]),
    );
    expect(LISTS["JOB_MODE_PREFERENCES.meeting"]).toContain("gpt-6-sol");
  });

  it("resolves every listed id to an entry with a verified note", () => {
    for (const ids of Object.values(LISTS)) {
      for (const id of ids) {
        expect(modelPolicy(id).verified.trim().length, id).toBeGreaterThan(10);
      }
    }
  });
});

describe("the models probed on 2026-09-30 have an entry of their own", () => {
  it("names each by exact id and cites the probe", () => {
    for (const id of PROBED_2026_09_30) {
      const policy = modelPolicy(id);
      const entry = MODEL_POLICY_TABLE.find((candidate) => candidate.key === policy.key);
      expect(entry, id).toBeDefined();
      expect(entry?.ids, id).toContain(id);
      expect(entry?.verified, id).toMatch(/probe 2026-09-30/);
    }
  });

  it("covers every new id the lists lead with: the Chat default, the Recommended set's newcomers and each mode head", () => {
    const newIds = ["gpt-6-luna", "gpt-6-sol", "claude-sonnet-5-5", "deepseek-v4-1-flash", "hy3"];
    const heads = [
      ...CHAT_DEFAULT_PREFERENCES.slice(0, 7),
      ...Object.values(JOB_MODE_PREFERENCES).map((ids) => ids[0] as string),
      JOB_FALLBACK_TAIL[0] as string,
    ];
    for (const id of newIds) {
      expect(heads, id).toContain(id);
      expect(PROBED_2026_09_30, id).toContain(id);
    }
  });
});

/**
 * What is wrong with an entry of `PICTURE_MISREADS`. A mark is a measurement, so it has to say when it was
 * made and what was seen; it names one exact model, which the policy table knows and which still reads
 * pictures (a model that cannot read them is `no` in `image-input.ts`, not a misreader).
 */
function markProblems(entry: PictureMisread): string[] {
  const problems: string[] = [];
  if (entry.id !== bareModelId(entry.id) || entry.id.length === 0) {
    problems.push("the id is not a bare lower-case id");
  }
  if (!modelPolicy(entry.id).known) {
    problems.push("not in the policy table");
  }
  if (modelImageInput(entry.id) !== "yes") {
    problems.push("does not read pictures at all, so there is nothing to misread");
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry.measured);
  const date = day ? new Date(`${entry.measured}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== entry.measured) {
    problems.push("has no evidence date (YYYY-MM-DD)");
  }
  if (entry.evidence.trim().length < 20) {
    problems.push("has no evidence");
  }
  return problems;
}

describe("the models marked as misreading pictures carry their evidence", () => {
  it("names each by exact id with a date and what was measured, once", () => {
    expect(PICTURE_MISREADS.length).toBeGreaterThan(0);
    for (const entry of PICTURE_MISREADS) {
      expect(markProblems(entry), entry.id).toEqual([]);
    }
    const ids = PICTURE_MISREADS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has a guard that can fail: it turns away a mark with no date, no evidence or a model that cannot read pictures", () => {
    const good: PictureMisread = {
      id: "gpt-6-luna",
      measured: "2026-11-13",
      evidence: "one picture, wrong four times in four",
    };
    expect(markProblems(good)).toEqual([]);
    expect(markProblems({ ...good, measured: "" })).toContain("has no evidence date (YYYY-MM-DD)");
    expect(markProblems({ ...good, measured: "2026-13-40" })).toContain("has no evidence date (YYYY-MM-DD)");
    expect(markProblems({ ...good, measured: "13 Nov 2026" })).toContain("has no evidence date (YYYY-MM-DD)");
    expect(markProblems({ ...good, evidence: "  " })).toContain("has no evidence");
    expect(markProblems({ ...good, id: "banana-unknown" })).toContain("not in the policy table");
    expect(markProblems({ ...good, id: "GPT-6-Luna" })).toContain("the id is not a bare lower-case id");
    expect(markProblems({ ...good, id: "glm-5.3" })).toContain(
      "does not read pictures at all, so there is nothing to misread",
    );
  });

  it("reaches the Chat default list at the one Luna id still on it, and no other", () => {
    // A new mark changes which model answers a picture turn on Daily, so it is a deliberate edit here.
    // `gpt-5.6-luna` is marked too but left every list when it was superseded (2026-11-10).
    const marked = CHAT_DEFAULT_PREFERENCES.filter((id) => PICTURE_MISREADS.some((entry) => entry.id === id));
    expect(marked).toEqual(["gpt-6-luna"]);
  });
});

describe("the Recommended set and the Chat default list agree", () => {
  it("lists every Recommended model in CHAT_DEFAULT_PREFERENCES, in the same order, ahead of the stand-ins", () => {
    const everyday = [...EVERYDAY_MODEL_IDS];
    expect(CHAT_DEFAULT_PREFERENCES.slice(0, everyday.length)).toEqual(everyday);
    for (const standIn of CHAT_DEFAULT_PREFERENCES.slice(everyday.length)) {
      expect(EVERYDAY_MODEL_IDS.has(standIn), standIn).toBe(false);
    }
  });

  it("makes GPT 6 Luna the Chat default", () => {
    expect(CHAT_DEFAULT_PREFERENCES[0]).toBe("gpt-6-luna");
  });
});

describe("no list the product walks by itself names a superseded model", () => {
  for (const [name, ids] of Object.entries(LISTS)) {
    it(name, () => {
      const offenders = ids
        .filter((id) => isSupersededModel(id))
        .map((id) => `${name} names ${id}, superseded by ${SUPERSEDED_MODELS[bareModelId(id)]?.successor}`);
      expect(offenders).toEqual([]);
    });
  }
});

describe("SUPERSEDED_MODELS", () => {
  const entries = Object.entries(SUPERSEDED_MODELS);

  it("keys every entry by a bare lower-case id, the only spelling isSupersededModel looks up", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [id] of entries) {
      expect(bareModelId(id), id).toBe(id);
    }
  });

  it("names a successor the policy table knows, with a verified note", () => {
    for (const [id, entry] of entries) {
      const policy = modelPolicy(entry.successor);
      expect(policy.known, `${id} -> ${entry.successor}`).toBe(true);
      expect(policy.verified.trim().length, `${id} -> ${entry.successor}`).toBeGreaterThan(10);
    }
  });

  it("never names a successor that is itself superseded, so no chain ends on an old id", () => {
    for (const [id, entry] of entries) {
      expect(isSupersededModel(entry.successor), `${id} -> ${entry.successor}`).toBe(false);
      expect(bareModelId(entry.successor), id).not.toBe(id);
    }
  });

  it("puts every successor in at least one list the product walks", () => {
    const listed = new Set(Object.values(LISTS).flatMap((ids) => ids.map((id) => bareModelId(id))));
    for (const [id, entry] of entries) {
      expect(listed.has(bareModelId(entry.successor)), `${id} -> ${entry.successor} is in no list`).toBe(true);
    }
  });

  it("is never dearer than what it replaces, on input or on output", () => {
    for (const [id, entry] of entries) {
      expect(entry.now[0], `${id} -> ${entry.successor}, input price`).toBeLessThanOrEqual(entry.was[0]);
      expect(entry.now[1], `${id} -> ${entry.successor}, output price`).toBeLessThanOrEqual(entry.was[1]);
    }
  });
});

describe("isSupersededModel", () => {
  it("matches whatever the case, the outer space or the vendor prefix", () => {
    expect(isSupersededModel("gpt-5.6-luna")).toBe(true);
    expect(isSupersededModel("GPT-5.6-Luna")).toBe(true);
    expect(isSupersededModel(" openai/gpt-5.6-luna ")).toBe(true);
  });

  it("refuses the model that replaced it, and a name that only exists on the prototype", () => {
    expect(isSupersededModel("gpt-6-luna")).toBe(false);
    expect(isSupersededModel("constructor")).toBe(false);
  });
});
