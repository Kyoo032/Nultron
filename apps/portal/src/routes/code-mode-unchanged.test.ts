/**
 * The e-mailed-code sign-in, which is the default and the only one the other hosted product uses, is
 * what it was before `PORTAL_SIGNIN_MODE` existed (owner, 2026-10-07: "the default behaviour must not
 * change by one byte").
 *
 * Four kinds of proof, because no one of them is enough:
 *
 *   - **The screens**, byte for byte: eighteen of them, rendered from fixed inputs, hashed, and compared
 *     with hashes made by the SAME function fed the view code from `main` (`9aba37e`).
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

/** Produced by `renderCodeModePages` over the views of `main` at `9aba37e`. */
const GOLDEN: Readonly<Record<string, string>> = {
  "en.signIn": "569f1f42a9868e94ba34c64af589dce01d892212ae02deb533c6699f4cae03d1",
  "en.signIn.error": "0422719e28d40da3c5fcb7abb19dd23c4f0d630f836dcaa065cd264ffb751e42",
  "en.enterCode": "f810f49131ec216f02aad943b7fde20bf01e4d7c185fd701d9c881770bdf4a88",
  "en.invite": "7b99a83ac26fd495441d477645517601035110393272892605ef74616d886647",
  "en.state": "790689fdee432252830f0241c63c63b1e43faf2b32b4d2e6ef5fab1dd32bbefc",
  "en.userCode": "c03155e8f3bbeb995ebc6cbc06ea2ab391df3ac45a767947668faff9127c22ef",
  "en.approve": "f37d934f52f6add3746dc66ceac2f9398826b88c1fcfd401c1e0b1a9ff1735d6",
  "en.signedOut": "e43360de1cadeaa4e1f739ff157810beb2cc02a6b9c56e3d2da1f2061c602f37",
  "en.error": "ade7dd40024801ef9ae291db0d1c5651cc9b2094de164456465e9eb84496b679",
  "id.signIn": "36b4bc86c5d68e240deb8185e78c1cce7f4d3319650686aabbb9defba7da2bca",
  "id.signIn.error": "3a2ee6410a4d15ff84e2f6183aaf8342a1f1c3be95d6b8ec163c5ff3aab87b25",
  "id.enterCode": "63cf6bac6932915ffcc62e625d5eae55cdba5bfb38321e09c2f5a5ebbe88b843",
  "id.invite": "2593227842fa20be872acc439b631146f01727e3057894e47e3ee6942873541d",
  "id.state": "23212fca357210e12ef0c3227e6efc166017ec4636839b8fdd5bc735a7d492c8",
  "id.userCode": "2a6d36d716d59359488565d8f73b7b0d1124bc8fb853eb0cf5377e8e274103c8",
  "id.approve": "baebcb2a9b6e40e8548b9295712be97579594b5c2bb5787297656b3f9c85058e",
  "id.signedOut": "4de83b7bb8da75d55ef354b9d1cb18a0da96223488d7c60e1c03ce84dd851ba0",
  "id.error": "e87373dc8c7eb09401fff644f8688520f4efcab8c73ceabf1f4b17bbd6c464bd",
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
    expect(translator("id")("signedOut.body")).toContain("e-mail dan kode");
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
