/**
 * Meeting delete — what goes with the folder (finding (a), verify-skill live pass 2026-10-01).
 *
 * The delete panel tells the owner a meeting's "recording, transcript and minutes go with it", but
 * `remove` only dropped the folder. The transcript and each set of minutes are `meeting` artifacts
 * (`run.ts` `persist`), so they stayed in `GET /api/v1/artifacts`, and the minutes' Knowledge card
 * kept answering Chat about a meeting the owner had deleted. Same family as the Legal matter and
 * the Data dataset deletes (`legal/store.test.ts`, `datasets.test.ts`).
 *
 * `createMeetingStore(rootDir)` takes its root as an argument, so the folders live in a temp dir;
 * the artifacts and cards are real rows in this file's own data dir (`test/setup.ts`).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { artifactStore } from "../artifacts";
import { listSources } from "../knowledge";
import { upsertWorkSource } from "../knowledge-ingest";
import { artifactWorkCard } from "../work-cards";
import { meetingDir } from "./store-files";
import { createMeetingStore, type MeetingStore } from "./store";

function newDesk(label: string): TenantContext {
  return {
    tenantId: "local-tenant",
    organizationId: "org-meeting-cascade",
    workspaceId: `ws-meeting-${label}-${crypto.randomUUID()}`,
    userId: "local",
    role: "owner",
  };
}

const MINUTES = {
  title: "Checkout weekly",
  heldOn: "",
  summary: "Ship the checkout fix on Friday.",
  attendees: [],
  decisions: [],
  actionItems: [],
  risks: [],
  openQuestions: [],
};

let root: string;
let store: MeetingStore;
// Fresh desks per case: artifacts and cards are rows in this file's one database.
let desk: TenantContext;
let otherDesk: TenantContext;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "af-meeting-cascade-"));
  store = createMeetingStore(root);
  desk = newDesk("a");
  otherDesk = newDesk("b");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function artifactIds(tenant: TenantContext): string[] {
  return (
    sql.prepare("SELECT id FROM artifacts WHERE workspace_id = ? ORDER BY id").all(tenant.workspaceId) as Array<{
      id: string;
    }>
  ).map((row) => row.id);
}

function seed(
  tenant: TenantContext,
  kind: "transcript" | "minutes",
  title: string,
  meta: Record<string, unknown> = {},
  mode: "meeting" | "documents" = "meeting",
): string {
  return artifactStore().create(tenant, {
    mode,
    kind: mode === "meeting" ? kind : "draft",
    title,
    mime: "text/markdown",
    body: `# ${title}`,
    meta,
  }).id;
}

/** A meeting the way `saveTranscript` and `generateMinutes` leave it: three artifacts, ids on the record. */
function seedMeeting(tenant: TenantContext, title: string) {
  const meeting = store.create(tenant, { title, locale: "en" });
  const transcriptId = seed(tenant, "transcript", `${title} — transcript`, { meetingId: meeting.id });
  const minutesId = seed(tenant, "minutes", `${title} — minutes`, { meetingId: meeting.id });
  const translationId = seed(tenant, "minutes", `${title} — notulen`, { meetingId: meeting.id });
  store.update(tenant, meeting.id, {
    status: "minuted",
    transcriptArtifactId: transcriptId,
    minutes: { locale: "en", minutes: MINUTES, artifactId: minutesId, model: "m", unverifiedNames: [], checks: null },
    translation: {
      locale: "id",
      minutes: MINUTES,
      artifactId: translationId,
      model: "m",
      unverifiedNames: [],
      checks: null,
    },
  });
  return { meeting, transcriptId, minutesId, translationId };
}

describe("meeting delete reaches its artifacts and their Knowledge card", () => {
  it("removes the transcript, the minutes, the translation and the minutes' work card, and nothing else", async () => {
    const mine = seedMeeting(desk, "Checkout weekly");
    const sibling = seedMeeting(desk, "Board sync");
    const unrelated = seed(desk, "minutes", "A document", {}, "documents");
    await upsertWorkSource(
      desk,
      artifactWorkCard({
        type: "Meeting",
        artifactId: mine.minutesId,
        title: "Checkout weekly — minutes",
        markdown: "Ship the fix.",
      }),
    );
    await upsertWorkSource(
      desk,
      artifactWorkCard({
        type: "Meeting",
        artifactId: sibling.minutesId,
        title: "Board sync — minutes",
        markdown: "Hire two.",
      }),
    );
    expect(listSources(desk)).toHaveLength(2);

    expect(store.remove(desk, mine.meeting.id)).toBe(true);

    expect(existsSync(meetingDir(root, desk.tenantId, desk.workspaceId, mine.meeting.id))).toBe(false);
    expect(artifactIds(desk)).toEqual(
      [sibling.transcriptId, sibling.minutesId, sibling.translationId, unrelated].sort(),
    );
    const cards = listSources(desk);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.origin).toEqual({ kind: "artifact", id: sibling.minutesId });
    expect(store.get(desk, sibling.meeting.id)).not.toBeNull();
  });

  it("also removes artifacts the record no longer points at (a re-run replaced them) and ones saved before the meeting was tagged", () => {
    const mine = seedMeeting(desk, "Retro");
    const replacedMinutes = seed(desk, "minutes", "Retro — minutes", { meetingId: mine.meeting.id });
    // Saved by a build that did not stamp `meetingId`: only the record's ids can find it.
    const legacy = seed(desk, "transcript", "Old — transcript");
    const legacyMeeting = store.create(desk, { title: "Old", locale: "en" });
    store.update(desk, legacyMeeting.id, { status: "transcribed", transcriptArtifactId: legacy });

    expect(store.remove(desk, mine.meeting.id)).toBe(true);
    expect(artifactIds(desk)).toEqual([legacy]);
    expect(artifactIds(desk)).not.toContain(replacedMinutes);

    expect(store.remove(desk, legacyMeeting.id)).toBe(true);
    expect(artifactIds(desk)).toEqual([]);
  });

  it("never reaches across desks, whether by the record's ids or by the tag", () => {
    const mine = seedMeeting(desk, "Checkout weekly");
    const theirs = seedMeeting(otherDesk, "Their meeting");
    // A record can name an id, but only an artifact of the same desk and of mode `meeting` is deleted.
    const foreignDoc = seed(otherDesk, "minutes", "Their document", {}, "documents");
    store.update(desk, mine.meeting.id, { transcriptArtifactId: foreignDoc });
    const foreignTagged = seed(otherDesk, "transcript", "Tagged for my id", { meetingId: mine.meeting.id });

    expect(store.remove(otherDesk, mine.meeting.id)).toBe(false);
    expect(artifactIds(desk)).toHaveLength(3);

    expect(store.remove(desk, mine.meeting.id)).toBe(true);
    expect(artifactIds(desk)).toEqual([]);
    expect(artifactIds(otherDesk)).toEqual(
      [theirs.transcriptId, theirs.minutesId, theirs.translationId, foreignDoc, foreignTagged].sort(),
    );
  });

  it("is all or nothing: a failed artifact delete keeps the folder and every artifact", () => {
    const mine = seedMeeting(desk, "Checkout weekly");
    sql.exec(
      `CREATE TRIGGER meeting_cascade_test_fail BEFORE DELETE ON artifacts
       WHEN old.id = '${mine.translationId}'
       BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`,
    );
    try {
      expect(() => store.remove(desk, mine.meeting.id)).toThrow(/simulated failure/);
      expect(artifactIds(desk)).toEqual([mine.transcriptId, mine.minutesId, mine.translationId].sort());
      expect(store.get(desk, mine.meeting.id)).not.toBeNull();
      expect(existsSync(meetingDir(root, desk.tenantId, desk.workspaceId, mine.meeting.id))).toBe(true);
    } finally {
      sql.exec("DROP TRIGGER IF EXISTS meeting_cascade_test_fail");
    }
    // The failure is retryable once whatever blocked it is gone.
    expect(store.remove(desk, mine.meeting.id)).toBe(true);
    expect(artifactIds(desk)).toEqual([]);
  });

  it("removes a meeting that never produced anything", () => {
    const empty = store.create(desk, { title: "Nothing yet", locale: "id" });
    expect(store.remove(desk, empty.id)).toBe(true);
    expect(store.remove(desk, empty.id)).toBe(false);
  });
});
