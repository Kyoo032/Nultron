/**
 * The invite e-mail: what goes out, what is written about it, and what a refused send leaves behind.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createLogger } from "../log";
import { inviteMessage } from "../mail";
import type { PortalStore } from "../store/types";
import { seedFixture, type Fixture } from "../testing/fixtures";
import { createTestStore, type TestStore } from "../testing/pg";
import { createTestMailer } from "../testing/server";
import { issueInvite, mailInvite, type IssuedInvite } from "./index";

let harness: TestStore;
let store: PortalStore;
let fixture: Fixture;
const slug = `deliver${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const logLines: string[] = [];
const log = createLogger({ env: { PORTAL_LOG_LEVEL: "debug" }, sink: (_level, line) => logLines.push(line) });

beforeAll(async () => {
  harness = await createTestStore();
  store = harness.store;
  fixture = await seedFixture(store, { slug });
  // A tenant that has chosen a display name, which is what the subject line prints.
  await store.tx(fixture.tenant.id, (ops) =>
    ops.tenantConfig.upsert({ tenantId: fixture.tenant.id, branding: { product_name: "AIHub Pilot" } }),
  );
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

let seq = 0;
async function issued(): Promise<IssuedInvite> {
  seq += 1;
  const result = await issueInvite(store, { tenantSlug: slug, email: `invitee${seq}@${slug}.test` });
  if (!result.ok) throw new Error(`could not issue: ${result.reason}`);
  return result;
}

function send(mailer: ReturnType<typeof createTestMailer>, invite: IssuedInvite, extra: Record<string, unknown> = {}) {
  return mailInvite(
    { store, mailer, log },
    {
      tenantId: invite.tenantId,
      orgId: invite.orgId,
      inviteId: invite.inviteId,
      code: invite.code,
      email: invite.email,
      expiresAt: invite.expiresAt,
      action: "invite.mailed",
      ...extra,
    },
  );
}

describe("mailInvite", () => {
  it("mails the code to the address it is bound to, under the tenant's own product name, and keeps it out of the subject", async () => {
    const mailer = createTestMailer();
    const invite = await issued();

    expect(await send(mailer, invite)).toBe("sent");

    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0];
    expect(mail.to).toBe(invite.email);
    expect(mail.inviteCode).toBe(invite.code);
    expect(mail.subject).toBe("You are invited to AIHub Pilot");
    expect(mail.subject).not.toContain(invite.code);
    expect(mail.text).toContain(`It works for ${invite.email} only, once`);
    expect(mail.text).toContain(invite.expiresAt.slice(0, 10));
    // No link in a sign-in mail, for the reason the OTP mail has none.
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toMatch(/href=/);
  });

  it("writes the audit row that says it went, and never the code", async () => {
    const mailer = createTestMailer();
    const invite = await issued();
    await send(mailer, invite);

    const rows = await store.tx(fixture.tenant.id, (ops) =>
      ops.audit.list({ tenantId: fixture.tenant.id, action: "invite.mailed" }),
    );
    const row = rows.find((entry) => entry.targetId === invite.inviteId);
    expect(row?.actorKind).toBe("support");
    expect(JSON.stringify(row)).not.toContain(invite.code);
  });

  it("is in Indonesian when asked", async () => {
    const mailer = createTestMailer();
    const invite = await issued();

    await send(mailer, invite, { locale: "id" });

    expect(mailer.sent[0].subject).toBe("Anda diundang ke AIHub Pilot");
    expect(mailer.sent[0].text).toContain("Kode undangan Anda:");
  });

  it("reports a refused send, audits invite.send_failed, and logs the domain but not the address or the code", async () => {
    const mailer = createTestMailer();
    const invite = await issued();
    mailer.failNext();

    expect(await send(mailer, invite)).toBe("failed");

    expect(mailer.sent).toHaveLength(0);
    const failed = await store.tx(fixture.tenant.id, (ops) =>
      ops.audit.list({ tenantId: fixture.tenant.id, action: "invite.send_failed" }),
    );
    expect(failed.some((entry) => entry.targetId === invite.inviteId)).toBe(true);
    expect(logLines.join("\n")).not.toContain(invite.code);
    expect(logLines.join("\n")).not.toContain(invite.email);
  });

  it("records a tester's own re-send as the system, not as an operator", async () => {
    const mailer = createTestMailer();
    const invite = await issued();

    await send(mailer, invite, { action: "invite.resent" });

    const rows = await store.tx(fixture.tenant.id, (ops) =>
      ops.audit.list({ tenantId: fixture.tenant.id, action: "invite.resent" }),
    );
    expect(rows.find((entry) => entry.targetId === invite.inviteId)?.actorKind).toBe("system");
  });
});

describe("inviteMessage", () => {
  it("escapes an address in the HTML part, and bolds the code", () => {
    const message = inviteMessage({
      to: "a<b>@example.test",
      code: "ABCDE-FGHJK-LMNPQ-RSTUV",
      expiresAt: "2026-10-08T10:00:00.000Z",
    });

    expect(message.html).not.toContain("<b>@example.test");
    expect(message.html).toContain("<strong>ABCDE-FGHJK-LMNPQ-RSTUV</strong>");
    expect(message.text).toContain("stops working after 2026-10-08 (UTC)");
  });

  it("falls back to the portal's own product name when the tenant has not chosen one", () => {
    expect(inviteMessage({ to: "a@b.test", code: "ABCDE-FGHJK-LMNPQ-RSTUV", expiresAt: "2026-10-08T00:00:00Z" }).subject).toBe(
      "You are invited to Nultron",
    );
  });
});
