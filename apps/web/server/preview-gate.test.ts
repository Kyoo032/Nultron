import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
