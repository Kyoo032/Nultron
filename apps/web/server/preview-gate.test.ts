import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Request } from "express";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createRateLimiter } from "../../../packages/host/src/rate-limit";
import { PreviewGate } from "./preview-gate";

const USER = "preview";
const PASSWORD = "correct-horse";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

function gate(options?: { secure?: boolean; burst?: number; now?: () => number }): PreviewGate {
  return new PreviewGate({
    user: USER,
    password: PASSWORD,
    secure: options?.secure ?? true,
    limiter: createRateLimiter({ rpm: 60, burst: options?.burst ?? 8 }),
    now: options?.now,
  });
}

async function listen(preview: PreviewGate): Promise<number> {
  const app = express();
  app.disable("x-powered-by");
  app.use(preview.middleware());
  app.use((_req, res) => {
    res.status(200).type("text/plain").send("desk");
  });
  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no port");
  }
  return address.port;
}

function request(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const body = options.body;
  const headers = { ...(options.headers ?? {}) };
  if (body !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function setCookie(headers: http.IncomingHttpHeaders): string {
  const raw = headers["set-cookie"];
  if (Array.isArray(raw)) {
    return raw.join("\n");
  }
  return raw ?? "";
}

function cookieHeader(setCookieHeader: string): string {
  return setCookieHeader.split(";")[0] ?? "";
}

function asRequest(remote: string, headers: Record<string, string> = {}): Request {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    socket: { remoteAddress: remote },
    header(name: string) {
      return lower.get(name.toLowerCase());
    },
  } as Request;
}

describe("PreviewGate.fromEnv", () => {
  it("stays off without the variables and on a hosted server", () => {
    expect(PreviewGate.fromEnv({})).toBeNull();
    expect(PreviewGate.fromEnv({ PREVIEW_BASIC_USER: USER })).toBeNull();
    expect(
      PreviewGate.fromEnv({
        AGENTFORGE_SERVER: "1",
        PREVIEW_BASIC_USER: USER,
        PREVIEW_BASIC_PASSWORD: PASSWORD,
      }),
    ).toBeNull();
  });

  it("turns on for a preview and marks the cookie Secure in production", async () => {
    const preview = PreviewGate.fromEnv({
      NODE_ENV: "production",
      PREVIEW_BASIC_USER: `  ${USER}  `,
      PREVIEW_BASIC_PASSWORD: PASSWORD,
    });
    if (!preview) {
      throw new Error("preview gate was not installed");
    }
    const port = await listen(preview);
    const response = await request(port, {
      method: "POST",
      path: "/login",
      body: new URLSearchParams({ username: USER, password: PASSWORD }).toString(),
    });
    const cookie = setCookie(response.headers);
    expect(response.status).toBe(303);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("__Host-nultron_preview=");
  });
});

describe("preview form login", () => {
  it("redirects a logged-out page to the login form", async () => {
    const port = await listen(gate());
    const response = await request(port, { path: "/chat" });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/login?next=%2Fchat");
    expect(response.body).not.toContain("<form");
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it("answers 401 JSON for a logged-out API route", async () => {
    const port = await listen(gate());
    const response = await request(port, { path: "/api/v1/workspaces" });
    expect(response.status).toBe(401);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).toContain("preview_auth_required");
    expect(response.body).not.toContain("<form");
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it("blocks a logged-out static asset", async () => {
    const port = await listen(gate());
    const asset = await request(port, { path: "/assets/index.js" });
    const logo = await request(port, { path: "/brand/logo.png" });
    expect(asset.status).toBe(401);
    expect(asset.headers["content-type"]).toContain("text/plain");
    expect(asset.body).toBe("Unauthorized\n");
    expect(asset.body).not.toContain("<form");
    expect(logo.status).toBe(401);
    expect(asset.headers["www-authenticate"]).toBeUndefined();
  });

  it("lets the login document and its icons through", async () => {
    const port = await listen(gate());
    const page = await request(port, { path: "/login" });
    const icon = await request(port, { path: "/brand/favicon.ico" });
    expect(page.status).toBe(200);
    expect(page.body).toContain('data-testid="preview-login"');
    expect(page.body).toContain("Username");
    expect(page.body).toContain("Password");
    expect(page.body).toContain("Nultron");
    expect(page.body).toContain("data:image/png;base64,");
    expect(page.body).toContain('data-testid="preview-password-toggle"');
    expect(page.body).not.toContain("Nama pengguna");
    expect(icon.status).toBe(200);
    expect(icon.body).toBe("desk");
  });

  it("uses one language, Indonesian when Accept-Language asks for it", async () => {
    const port = await listen(gate());
    const page = await request(port, { path: "/login", headers: { "accept-language": "fr, id;q=0.9, en;q=0.4" } });
    expect(page.status).toBe(200);
    expect(page.body).toContain('lang="id"');
    expect(page.body).toContain("Nama pengguna");
    expect(page.body).toContain("Kata sandi");
    expect(page.body).not.toContain(">Username<");
  });

  it("sets a signed cookie with the hosted flags on success", async () => {
    const port = await listen(gate({ secure: true }));
    const response = await request(port, {
      method: "POST",
      path: "/login",
      body: new URLSearchParams({ username: USER, password: PASSWORD, next: "/chat" }).toString(),
    });
    const cookie = setCookie(response.headers);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/chat");
    expect(cookie).toContain("__Host-nultron_preview=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${PreviewGate.MAX_AGE_SECONDS}`);
    expect(cookie).not.toContain(PASSWORD);
    expect(cookie).not.toContain("Domain=");

    const desk = await request(port, { path: "/chat", headers: { cookie: cookieHeader(cookie) } });
    expect(desk.status).toBe(200);
    expect(desk.body).toBe("desk");
  });

  it("rejects a wrong password and does not set a session cookie", async () => {
    const port = await listen(gate());
    const response = await request(port, {
      method: "POST",
      path: "/login",
      body: new URLSearchParams({ username: USER, password: "nope" }).toString(),
    });
    expect(response.status).toBe(401);
    expect(response.body).toContain('data-testid="preview-error"');
    expect(response.body).toContain('data-reason="wrong"');
    expect(response.body).toContain("That username or password is not right.");
    expect(response.body).not.toContain("Nama pengguna atau kata sandi");
    expect(setCookie(response.headers)).toBe("");
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it("locks further attempts with a clear error", async () => {
    const port = await listen(gate({ burst: 2 }));
    const body = new URLSearchParams({ username: USER, password: "nope" }).toString();
    const first = await request(port, { method: "POST", path: "/login", body });
    const second = await request(port, { method: "POST", path: "/login", body });
    const third = await request(port, { method: "POST", path: "/login", body });
    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(third.status).toBe(429);
    expect(third.body).toContain('data-reason="locked"');
    expect(third.body).toContain("Too many sign-in attempts.");
    expect(third.body).not.toContain("Terlalu banyak percobaan masuk.");
    expect(third.headers["retry-after"]).toBeDefined();
    expect(setCookie(third.headers)).toBe("");

    const other = await request(port, {
      method: "POST",
      path: "/login",
      headers: { "x-forwarded-for": "203.0.113.8" },
      body: new URLSearchParams({ username: USER, password: PASSWORD }).toString(),
    });
    expect(other.status).toBe(303);
  });

  it("drops the session on logout", async () => {
    const port = await listen(gate());
    const loggedIn = await request(port, {
      method: "POST",
      path: "/login",
      body: new URLSearchParams({ username: USER, password: PASSWORD }).toString(),
    });
    const cookie = cookieHeader(setCookie(loggedIn.headers));
    const goodbye = await request(port, { method: "POST", path: "/logout", headers: { cookie } });
    expect(goodbye.status).toBe(303);
    expect(goodbye.headers.location).toBe("/login");
    expect(setCookie(goodbye.headers)).toContain("Max-Age=0");
    const again = await request(port, { path: "/chat", headers: { cookie } });
    expect(again.status).toBe(302);
  });

  it("refuses a cookie after it expires", async () => {
    let now = 1_000_000;
    const port = await listen(gate({ now: () => now }));
    const loggedIn = await request(port, {
      method: "POST",
      path: "/login",
      body: new URLSearchParams({ username: USER, password: PASSWORD }).toString(),
    });
    const cookie = cookieHeader(setCookie(loggedIn.headers));
    now += PreviewGate.MAX_AGE_SECONDS * 1000 + 1;
    const again = await request(port, { path: "/chat", headers: { cookie } });
    expect(again.status).toBe(302);
  });

  it("ignores an off-site next", async () => {
    const port = await listen(gate());
    const response = await request(port, {
      method: "POST",
      path: "/login",
      body: new URLSearchParams({ username: USER, password: PASSWORD, next: "https://evil.example/phish" }).toString(),
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/");
  });

  it("does not follow a next that normalises to a protocol-relative URL", async () => {
    const port = await listen(gate());
    const payloads = ["/.//evil.com", "/..//evil.com", "/%2e%2e//evil.com", "//evil.com", "/\\evil.com"];
    for (const next of payloads) {
      const response = await request(port, {
        method: "POST",
        path: "/login",
        body: new URLSearchParams({ username: USER, password: PASSWORD, next }).toString(),
      });
      expect(response.status).toBe(303);
      expect(response.headers.location).toBe("/");
    }
  });

  it("rejects a forged or tampered cookie", async () => {
    const port = await listen(gate());
    const loggedIn = await request(port, {
      method: "POST",
      path: "/login",
      body: new URLSearchParams({ username: USER, password: PASSWORD }).toString(),
    });
    const cookie = cookieHeader(setCookie(loggedIn.headers));
    const split = cookie.indexOf("=");
    const value = cookie.slice(split + 1);
    const flipped = `${value.slice(0, -1)}${value.endsWith("a") ? "b" : "a"}`;
    const tampered = await request(port, {
      path: "/chat",
      headers: { cookie: `${cookie.slice(0, split + 1)}${flipped}` },
    });
    const forged = await request(port, {
      path: "/chat",
      headers: { cookie: "__Host-nultron_preview=not-a-cookie" },
    });
    expect(tampered.status).toBe(302);
    expect(forged.status).toBe(302);
    expect(tampered.headers.location).toContain("/login");
  });

  it("leaves GET /healthz public", async () => {
    const port = await listen(gate());
    const response = await request(port, { path: "/healthz" });
    expect(response.status).toBe(200);
    expect(response.body).toBe("desk");
  });

  it("refuses a cross-site login or logout, and a foreign Origin", async () => {
    const port = await listen(gate());
    const body = new URLSearchParams({ username: USER, password: PASSWORD }).toString();
    const cross = await request(port, {
      method: "POST",
      path: "/login",
      headers: { "sec-fetch-site": "cross-site" },
      body,
    });
    const foreign = await request(port, {
      method: "POST",
      path: "/login",
      headers: { origin: "https://evil.example" },
      body,
    });
    expect(cross.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect(setCookie(cross.headers)).toBe("");
    expect(cross.body).not.toContain("<form");

    const loggedIn = await request(port, { method: "POST", path: "/login", body });
    const cookie = cookieHeader(setCookie(loggedIn.headers));
    const logout = await request(port, {
      method: "POST",
      path: "/logout",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(logout.status).toBe(403);
    const desk = await request(port, { path: "/chat", headers: { cookie } });
    expect(desk.status).toBe(200);
  });

  it("still accepts a same-origin login", async () => {
    const port = await listen(gate());
    const response = await request(port, {
      method: "POST",
      path: "/login",
      headers: { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ username: USER, password: PASSWORD }).toString(),
    });
    expect(response.status).toBe(303);
  });

  it("spends the rate-limit token before reading the body", async () => {
    const port = await listen(gate({ burst: 1 }));
    const first = await request(port, {
      method: "POST",
      path: "/login",
      body: new URLSearchParams({ username: USER, password: "nope" }).toString(),
    });
    expect(first.status).toBe(401);
    const huge = `username=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASSWORD)}&pad=${"x".repeat(8000)}`;
    const second = await request(port, { method: "POST", path: "/login", body: huge });
    expect(second.status).toBe(429);
    expect(setCookie(second.headers)).toBe("");
  });

  it("answers 413 and does not sign in when the body passes 4 KB", async () => {
    const port = await listen(gate());
    const huge = `username=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASSWORD)}&pad=${"x".repeat(8000)}`;
    const response = await request(port, { method: "POST", path: "/login", body: huge });
    expect(response.status).toBe(413);
    expect(setCookie(response.headers)).toBe("");
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });
});

describe("PreviewGate.safeNext", () => {
  it.each(["/.//evil.com", "/..//evil.com", "/%2e%2e//evil.com", "//evil.com", "/\\evil.com"])(
    "rejects %s",
    (next) => {
      expect(PreviewGate.safeNext(next)).toBe("/");
    },
  );

  it("keeps a same-origin path", () => {
    expect(PreviewGate.safeNext("/chat?x=1")).toBe("/chat?x=1");
  });
});

describe("PreviewGate.clientKey", () => {
  it("ignores X-Forwarded-For from a non-loopback socket", () => {
    const first = PreviewGate.clientKey(asRequest("203.0.113.9", { "x-forwarded-for": "198.51.100.1" }));
    const second = PreviewGate.clientKey(asRequest("203.0.113.9", { "x-forwarded-for": "198.51.100.2" }));
    expect(first).toBe("203.0.113.9");
    expect(second).toBe(first);
  });

  it("trusts the last loopback hop and keys IPv6 by /64", () => {
    expect(PreviewGate.clientKey(asRequest("127.0.0.1", { "x-forwarded-for": "198.51.100.4, 203.0.113.8" }))).toBe(
      "203.0.113.8",
    );
    const one = PreviewGate.clientKey(asRequest("::1", { "x-forwarded-for": "2001:db8:1:2::1" }));
    const two = PreviewGate.clientKey(asRequest("::ffff:127.0.0.1", { "x-forwarded-for": "2001:db8:1:2:aaaa::9" }));
    const other = PreviewGate.clientKey(asRequest("127.0.0.1", { "x-forwarded-for": "2001:db8:1:3::1" }));
    expect(one).toBe("2001:db8:1:2::/64");
    expect(two).toBe(one);
    expect(other).toBe("2001:db8:1:3::/64");
  });

  it("keys an IPv4-mapped address by the embedded IPv4", () => {
    expect(PreviewGate.rateAddress("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });
});

describe("server.ts installs the gate before the API", () => {
  it("reads the preview variables before handleNodeRequest", () => {
    const source = readFileSync(fileURLToPath(new URL("../server.ts", import.meta.url)), "utf8");
    const installed = source.indexOf("PreviewGate.fromEnv(process.env)");
    const api = source.indexOf("void handleNodeRequest");
    expect(installed).toBeGreaterThan(-1);
    expect(installed).toBeLessThan(api);
  });
});
