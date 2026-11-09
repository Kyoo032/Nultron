/**
 * The e-mailed-code sign-in, which is the default and the only one the other hosted product uses, is
 * what it was before `PORTAL_SIGNIN_MODE` existed (owner, 2026-10-07: "the default behaviour must not
 * change by one byte").
 *
 * Four kinds of proof, because no one of them is enough:
 *
 *   - **The screens**, byte for byte: eighteen of them, rendered from fixed inputs, hashed, and compared
 *     with hashes made by the SAME function fed the view code from `main` (`9aba37e`; the two `userCode` screens since 2026-11-03).
 *   - **The route table**, as an exact list: a route added to the default mode is a failure here.
 *   - **The wire**: the password routes and the discovery route are the server's own 404 in the default
 *     mode, and the code routes still answer.
 *   - **The mailer and the boot rules**: the default mode still builds an SMTP mailer, and still refuses
 *     to boot in production without a mail host (that half is in `config.test.ts`).
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMailer, MailDeliveryError, MailDisabledError } from "../mail";
import { testConfig, startTestPortal, createAgent, hiddenValue, type PortalHarness } from "../testing/server";
import { renderCodeModePages } from "../testing/code-pages";
import { authorizeUrl, setupPilot } from "../testing/sign-in-kit";
import * as pages from "../views/pages";
import { translator } from "../views/i18n";
import { portalRoutes } from "./index";

/**
 * Produced by `renderCodeModePages` over the views of `main` at `9aba37e`; the two `userCode` screens since the
 * typed-code fix of 2026-11-03, whose form is a GET to `/activate?code=`. The `id.*` entries were produced again
 * by the same function on 2026-11-03, when the Indonesian catalog was revised, and `id.userCode` once more on
 * 2026-11-09, when that revision met the typed-code fix. The `en.*` entries did not move.
 */
const GOLDEN: Readonly<Record<string, string>> = {
  "en.signIn": "569f1f42a9868e94ba34c64af589dce01d892212ae02deb533c6699f4cae03d1",
  "en.signIn.error": "0422719e28d40da3c5fcb7abb19dd23c4f0d630f836dcaa065cd264ffb751e42",
  "en.enterCode": "f810f49131ec216f02aad943b7fde20bf01e4d7c185fd701d9c881770bdf4a88",
  "en.invite": "7b99a83ac26fd495441d477645517601035110393272892605ef74616d886647",
  "en.state": "790689fdee432252830f0241c63c63b1e43faf2b32b4d2e6ef5fab1dd32bbefc",
  "en.userCode": "2841901e5d2859eff7c29decedca58ec31effb239b5f4bc79d8a3cec2c45b558",
  "en.approve": "f37d934f52f6add3746dc66ceac2f9398826b88c1fcfd401c1e0b1a9ff1735d6",
  "en.signedOut": "e43360de1cadeaa4e1f739ff157810beb2cc02a6b9c56e3d2da1f2061c602f37",
  "en.error": "ade7dd40024801ef9ae291db0d1c5651cc9b2094de164456465e9eb84496b679",
  "id.signIn": "238b2d42547032e67ee4422db223a0f2e8307615e9927ff02a433b5cdd33ef3d",
  "id.signIn.error": "93866caf4718b2229f5e6be466f8fbe993a4e58c74a60c0715eb54dcedab4aaa",
  "id.enterCode": "1cf7931c5ab94c288bcdfdf1f5bf78193222effda9aac80cee8f04eab0988706",
  "id.invite": "6ad33a4100f5a524c0d1c27ed82814e67c42a91cf4e2309d90ae4d739209ea56",
  "id.state": "c9cd267aa5348677e2fddcc9c8c0be07ab690b3a1d04ef663364e9ead641b95a",
  "id.userCode": "d3d3e59a512d4ccdfcb58a2fe0b0f94eb28cc8ae56cb5ac9d052627370ab2c87",
  "id.approve": "baebcb2a9b6e40e8548b9295712be97579594b5c2bb5787297656b3f9c85058e",
  "id.signedOut": "6f7a8eb1464e0ba53bfa601cd9e755708d7d6a7e50852c066633cd1e1ca713a8",
  "id.error": "ae496c6a44fa2c07f7489fd1f8f348e8d6395984aea47c141e70b0ba704e3922",
};

/** Every route of the default mode, as `main` registers them. */
const CODE_MODE_ROUTES = [
  "GET /.well-known/jwks.json",
  "GET /activate",
  "GET /assets/logo.png",
  "GET /auth/session",
  "GET /authorize",
  "GET /logout",
  "GET /tenant/config",
  "POST /activate/email",
  "POST /activate/invite",
  "POST /activate/invite/resend",
  "POST /activate/verify",
  "POST /auth/device/approve",
  "POST /auth/device/code",
  "POST /auth/device/token",
  "POST /auth/logout",
  "POST /auth/token",
  "POST /authorize/email",
  "POST /authorize/invite",
  "POST /authorize/invite/resend",
  "POST /authorize/verify",
  "POST /logout",
];

/** The password mode's: the four code posts go, the two password posts come, and one discovery route. */
const PASSWORD_MODE_ROUTES = [
  "GET /.well-known/jwks.json",
  "GET /activate",
  "GET /assets/logo.png",
  "GET /auth/session",
  "GET /auth/signin-mode",
  "GET /authorize",
  "GET /logout",
  "GET /tenant/config",
  "POST /activate/password",
  "POST /activate/password/change",
  "POST /auth/device/approve",
  "POST /auth/device/code",
  "POST /auth/device/token",
  "POST /auth/logout",
  "POST /auth/token",
  "POST /authorize/password",
  "POST /authorize/password/change",
  "POST /logout",
];

function table(portal: PortalHarness): string[] {
  return portalRoutes(portal.runtime)
    .map((route) => `${route.method} ${route.path}`)
    .sort();
}

let portal: PortalHarness;
let password: PortalHarness;

beforeAll(async () => {
  portal = await startTestPortal({ trustProxy: true });
  await setupPilot(portal);
  password = await startTestPortal({ trustProxy: true, config: { signInMode: "password" } });
}, 180_000);

afterAll(async () => {
  await portal?.close();
  await password?.close();
});

describe("the screens of the e-mailed-code sign-in", () => {
  it("are byte for byte what main renders, in English and in Indonesian", () => {
    const rendered = renderCodeModePages({ translator, ...pages } as never);
    expect(Object.keys(rendered).sort()).toEqual(Object.keys(GOLDEN).sort());
    const actual = Object.fromEntries(
      Object.entries(rendered).map(([name, markup]) => [
        name,
        createHash("sha256").update(markup, "utf8").digest("hex"),
      ]),
    );
    expect(actual).toEqual(GOLDEN);
  });

  it("carry no stylesheet the password screens added", () => {
    const rendered = renderCodeModePages({ translator, ...pages } as never);
    for (const [name, markup] of Object.entries(rendered)) {
      expect(markup, name).not.toContain("label:not(:first-of-type)");
      expect(markup, name).toContain("footer{margin-top:1.5rem;font-size:.8rem;color:var(--muted)}</style>");
    }
  });

  it("read the password variants of the two shared sentences only when asked to", () => {
    expect(translator("en")("footer.note")).toBe("Never share a sign-in code with anyone.");
    expect(translator("en", { passwordMode: false })("footer.note")).toBe("Never share a sign-in code with anyone.");
    expect(translator("en", { passwordMode: true })("footer.note")).toBe("Never share your password with anyone.");
    expect(translator("id")("signedOut.body")).toContain("email dan kode");
    expect(translator("id", { passwordMode: true })("signedOut.body")).toContain("nama pengguna dan kata sandi");
  });
});

describe("the route table", () => {
  it("is exactly main's in the default mode", () => {
    expect(table(portal)).toEqual(CODE_MODE_ROUTES);
  });

  it("is the password mode's own in password mode, and nothing is shared that could be confused", () => {
    expect(table(password)).toEqual(PASSWORD_MODE_ROUTES);
  });
});

describe("the default mode on the wire", () => {
  it("still asks for an e-mail address and says never to share a sign-in code", async () => {
    const reply = await createAgent(portal.origin).get(authorizeUrl("state-code"));
    expect(reply.status).toBe(200);
    expect(reply.text).toContain('name="email"');
    expect(reply.text).not.toContain('name="identifier"');
    expect(reply.text).not.toContain('type="password"');
    expect(reply.text).toContain("Never share a sign-in code with anyone.");
    expect(reply.text).toContain('action="/authorize/email"');
  });

  it("answers the password routes and the discovery route as paths that do not exist", async () => {
    const agent = createAgent(portal.origin);
    const page = await agent.get(authorizeUrl("state-code-2"));
    const token = hiddenValue(page.text, "csrf_token") as string;
    for (const path of [
      "/authorize/password",
      "/authorize/password/change",
      "/activate/password",
      "/activate/password/change",
    ]) {
      const reply = await agent.postForm(path, { csrf_token: token, identifier: "x", password: "y" });
      expect(reply.status, path).toBe(404);
      expect(reply.json(), path).toEqual({ error: "not_found" });
    }
    const mode = await agent.get("/auth/signin-mode");
    expect(mode.status).toBe(404);
    expect(mode.json()).toEqual({ error: "not_found" });
  });

  it("still routes the e-mail step: it is refused for want of a token, not for want of a route", async () => {
    const reply = await createAgent(portal.origin).postForm("/authorize/email", {
      csrf_token: "forged",
      response_type: "code",
      client_id: "agentforge-web",
      redirect_uri: "https://localhost:3443/auth/callback",
      state: "s",
      email: "x@y.test",
    });
    expect(reply.status).toBe(403);
  });
});

describe("the mailer", () => {
  it("is still SMTP in the default mode, so a code is still mailed", async () => {
    // A port nothing listens on: the send fails the way a real transport does, and says so.
    const config = testConfig({ smtp: { ...testConfig().smtp, port: 1 } });
    const mailer = createMailer(config);
    await expect(mailer.send({ to: "someone@example.test", subject: "s", text: "t" })).rejects.toBeInstanceOf(
      MailDeliveryError,
    );
    await mailer.close();
  });

  it("is a mailer that refuses in password mode, and opens no connection", async () => {
    const mailer = createMailer(testConfig({ signInMode: "password" }));
    await expect(mailer.send({ to: "someone@example.test", subject: "s", text: "t" })).rejects.toBeInstanceOf(
      MailDisabledError,
    );
    await mailer.close();
  });
});
