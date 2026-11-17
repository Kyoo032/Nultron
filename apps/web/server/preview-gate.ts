import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isServerMode, type EnvLike } from "@agentforge/core";
import type { Request, RequestHandler, Response } from "express";
import { createRateLimiter, type RateLimiter } from "../../../packages/host/src/rate-limit";

/**
 * Form login for the preview desks (app.nultron-ai.xyz).
 *
 * The preview is not the hosted server. It runs with `AGENTFORGE_SERVER` unset, so the portal
 * session (`packages/host/src/auth/session.ts`) is never minted there, and Caddy's `basic_auth`
 * (outside this repo, `nultron-files/deploy/tencent/edge/sites/app.caddy`) is what used to answer
 * `401` with `WWW-Authenticate: Basic`. A browser dialog is the thing a scripted check cannot fill.
 *
 * This gate replaces that dialog. It is installed only when both credential variables are set and
 * the process is not in server mode (`fromEnv`). The cookie is an HMAC over an opaque id, not the
 * password. Login attempts spend a token from the same bucket primitive the hosted limiter uses
 * (`createRateLimiter` in `packages/host/src/rate-limit.ts`). Nothing here sends `WWW-Authenticate`.
 */
export class PreviewGate {
  static readonly USER_ENV = "PREVIEW_BASIC_USER";
  static readonly PASSWORD_ENV = "PREVIEW_BASIC_PASSWORD";

  /** Plain name on http (webdev proof). `__Host-` only where the cookie is `Secure`. */
  static readonly COOKIE = "nultron_preview";
  static readonly COOKIE_SECURE = "__Host-nultron_preview";

  static readonly LOGIN_PATH = "/login";
  static readonly LOGOUT_PATH = "/logout";

  /** Twelve hours, the same order of magnitude as the hosted session's idle window. */
  static readonly MAX_AGE_SECONDS = 12 * 60 * 60;

  /** Five immediate tries, then about one every six seconds. Keyed per client address. */
  static readonly ATTEMPT_BURST = 5;
  static readonly ATTEMPT_RPM = 10;

  static readonly BODY_LIMIT = 4096;
  static readonly MAX_SESSIONS = 200;

  /** Icons the login document links. Every other file stays behind the cookie. */
  static readonly PUBLIC_ASSETS = new Set(["/brand/favicon.ico", "/brand/favicon-32.png", "/brand/favicon-180.png"]);

  static readonly PAGE_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

  readonly #user: string;
  readonly #password: string;
  readonly #secure: boolean;
  readonly #key: Buffer;
  readonly #attempts: RateLimiter;
  readonly #now: () => number;
  readonly #sessions = new Map<string, number>();

  constructor(options: {
    readonly user: string;
    readonly password: string;
    readonly secure: boolean;
    readonly limiter?: RateLimiter;
    readonly now?: () => number;
  }) {
    this.#user = options.user;
    this.#password = options.password;
    this.#secure = options.secure;
    this.#key = PreviewGate.signingKey(options.user, options.password);
    this.#attempts =
      options.limiter ?? createRateLimiter({ rpm: PreviewGate.ATTEMPT_RPM, burst: PreviewGate.ATTEMPT_BURST });
    this.#now = options.now ?? Date.now;
  }

  /** Both variables set to a non-empty value. The password is not trimmed: spaces can be part of it. */
  static credentialsPresent(env: EnvLike): boolean {
    const user = env[PreviewGate.USER_ENV]?.trim() ?? "";
    const password = env[PreviewGate.PASSWORD_ENV] ?? "";
    return user.length > 0 && password.length > 0;
  }

  /**
   * The gate for this process, or null when it must not run.
   *
   * Server mode keeps the portal session and never this form, even if the variables are set on a
   * hosted container by mistake. A desk that does not set them is unchanged.
   */
  static fromEnv(env: EnvLike): PreviewGate | null {
    const user = env[PreviewGate.USER_ENV]?.trim() ?? "";
    const password = env[PreviewGate.PASSWORD_ENV] ?? "";
    if (isServerMode(env) || user.length === 0 || password.length === 0) {
      return null;
    }
    return new PreviewGate({
      user,
      password,
      secure: env.NODE_ENV?.trim() === "production",
    });
  }

  static cookieName(secure: boolean): string {
    return secure ? PreviewGate.COOKIE_SECURE : PreviewGate.COOKIE;
  }

  /**
   * SHA-256 both sides first so `timingSafeEqual` always compares 32 bytes. A shorter password
   * must not return early, and a mismatch in length must not throw.
   */
  static credentialsMatch(givenUser: string, givenPassword: string, user: string, password: string): boolean {
    const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
    const userOk = timingSafeEqual(digest(givenUser), digest(user));
    const passwordOk = timingSafeEqual(digest(givenPassword), digest(password));
    return userOk && passwordOk;
  }

  static signingKey(user: string, password: string): Buffer {
    return createHash("sha256").update(`nultron-preview-gate-v1\0${user}\0${password}`, "utf8").digest();
  }

  static fixedEqual(left: string, right: string): boolean {
    const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
    return timingSafeEqual(digest(left), digest(right));
  }

  /**
   * Last `X-Forwarded-For` hop only when the socket is loopback, which is Caddy in the preview's
   * network namespace. A direct connection ignores the header: the client could set it.
   */
  static clientKey(req: Request): string {
    const remote = req.socket?.remoteAddress ?? "";
    const forwarded = req.header("x-forwarded-for");
    if (forwarded && PreviewGate.isLoopback(remote)) {
      const last = forwarded.split(",").at(-1)?.trim();
      if (last) {
        return last.slice(0, 128);
      }
    }
    return remote || "unknown";
  }

  static isLoopback(address: string): boolean {
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  }

  /** A path on this origin, or `/`. Never an absolute URL and never back to the login route. */
  static queryString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  static hasControl(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 31 || code === 127) {
        return true;
      }
    }
    return false;
  }

  static safeNext(value: string | null | undefined): string {
    if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\") || PreviewGate.hasControl(value)) {
      return "/";
    }
    try {
      const url = new URL(value, "http://preview.local");
      if (url.origin !== "http://preview.local") {
        return "/";
      }
      if (url.pathname === PreviewGate.LOGIN_PATH || url.pathname === PreviewGate.LOGOUT_PATH) {
        return "/";
      }
      return `${url.pathname}${url.search}`;
    } catch {
      return "/";
    }
  }

  static readCookie(header: string | undefined, name: string): string | null {
    if (!header) {
      return null;
    }
    for (const part of header.split(";")) {
      const index = part.indexOf("=");
      if (index === -1 || part.slice(0, index).trim() !== name) {
        continue;
      }
      try {
        const value = decodeURIComponent(part.slice(index + 1).trim());
        return value.length > 0 ? value : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  static isAsset(path: string): boolean {
    if (
      path.startsWith("/assets/") ||
      path.startsWith("/src/") ||
      path.startsWith("/@") ||
      path.startsWith("/node_modules/") ||
      path.startsWith("/brand/") ||
      path.startsWith("/fonts/")
    ) {
      return true;
    }
    return path.slice(path.lastIndexOf("/") + 1).includes(".");
  }

  static escape(value: string): string {
    return value.replace(/[&<>"']/g, (char) => {
      switch (char) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }

  middleware(): RequestHandler {
    return (req, res, next) => {
      this.dispatch(req, res).then(
        (handled) => {
          if (!handled) {
            next();
          }
        },
        (error: unknown) => next(error),
      );
    };
  }

  private async dispatch(req: Request, res: Response): Promise<boolean> {
    const method = req.method.toUpperCase();
    const path = req.path;

    if (method === "POST" && path === PreviewGate.LOGOUT_PATH) {
      this.logout(req, res);
      return true;
    }

    if (this.session(req)) {
      if ((method === "GET" || method === "HEAD") && path === PreviewGate.LOGIN_PATH) {
        this.redirect(res, PreviewGate.safeNext(PreviewGate.queryString(req.query.next)));
        return true;
      }
      return false;
    }

    if (method === "GET" || method === "HEAD") {
      // Liveness is one word and is how Caddy and the image healthcheck reach the process
      // without a browser. It stays public, as `GET /healthz` already is.
      if (path === "/healthz" || PreviewGate.PUBLIC_ASSETS.has(path)) {
        return false;
      }
      if (path === PreviewGate.LOGIN_PATH) {
        this.sendPage(res, { status: 200, next: PreviewGate.safeNext(PreviewGate.queryString(req.query.next)) });
        return true;
      }
    }

    if (method === "POST" && path === PreviewGate.LOGIN_PATH) {
      await this.login(req, res);
      return true;
    }

    const api = path === "/api" || path.startsWith("/api/");
    if (api || PreviewGate.isAsset(path) || (method !== "GET" && method !== "HEAD")) {
      this.unauthorized(res, path);
      return true;
    }

    this.redirect(res, `/login?next=${encodeURIComponent(PreviewGate.safeNext(req.originalUrl))}`);
    return true;
  }

  private session(req: Request): { id: string; exp: number } | null {
    const raw = PreviewGate.readCookie(req.header("cookie"), PreviewGate.cookieName(this.#secure));
    if (!raw) {
      return null;
    }
    return this.open(raw);
  }

  private logout(req: Request, res: Response): void {
    const current = this.session(req);
    if (current) {
      this.#sessions.delete(current.id);
    }
    this.writeCookie(res, "", 0);
    this.redirect(res, PreviewGate.LOGIN_PATH, 303);
  }

  private async login(req: Request, res: Response): Promise<void> {
    const type = (req.header("content-type") ?? "").toLowerCase();
    const next = PreviewGate.safeNext(PreviewGate.queryString(req.query.next));
    if (!type.startsWith("application/x-www-form-urlencoded")) {
      this.sendPage(res, { status: 400, next, error: "form" });
      return;
    }
    const body = await PreviewGate.readBody(req);
    if (!body.ok) {
      this.sendPage(res, { status: 413, next, error: "form" });
      return;
    }
    const params = new URLSearchParams(body.text);
    const givenUser = params.get("username") ?? "";
    const givenPassword = params.get("password") ?? "";
    const destination = PreviewGate.safeNext(params.get("next") ?? next);
    const decision = this.#attempts.take(PreviewGate.clientKey(req), Date.now());
    const match = PreviewGate.credentialsMatch(givenUser, givenPassword, this.#user, this.#password);
    if (!decision.allowed) {
      this.sendPage(res, {
        status: 429,
        next: destination,
        username: givenUser,
        error: "locked",
        retry: decision.retryAfterSeconds,
      });
      return;
    }
    if (!match) {
      this.sendPage(res, { status: 401, next: destination, username: givenUser, error: "wrong" });
      return;
    }
    const id = randomBytes(16).toString("base64url");
    const exp = this.#now() + PreviewGate.MAX_AGE_SECONDS * 1000;
    this.remember(id, exp);
    this.writeCookie(res, this.seal(id, exp), PreviewGate.MAX_AGE_SECONDS);
    this.redirect(res, destination, 303);
  }

  private remember(id: string, exp: number): void {
    const now = this.#now();
    for (const [key, until] of this.#sessions) {
      if (until <= now) {
        this.#sessions.delete(key);
      }
    }
    if (this.#sessions.size >= PreviewGate.MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest) {
        this.#sessions.delete(oldest);
      }
    }
    this.#sessions.set(id, exp);
  }

  private seal(id: string, exp: number): string {
    const payload = Buffer.from(JSON.stringify({ id, exp }), "utf8").toString("base64url");
    const mac = createHmac("sha256", this.#key).update(payload).digest("base64url");
    return `${payload}.${mac}`;
  }

  private open(token: string): { id: string; exp: number } | null {
    const dot = token.indexOf(".");
    if (dot <= 0 || token.includes(".", dot + 1)) {
      return null;
    }
    const payload = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = createHmac("sha256", this.#key).update(payload).digest("base64url");
    if (!PreviewGate.fixedEqual(mac, expected)) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const record = parsed as { id?: unknown; exp?: unknown };
    if (
      typeof record.id !== "string" ||
      record.id.length < 8 ||
      typeof record.exp !== "number" ||
      !Number.isFinite(record.exp)
    ) {
      return null;
    }
    const now = this.#now();
    if (record.exp <= now || record.exp > now + PreviewGate.MAX_AGE_SECONDS * 1000 + 60_000) {
      this.#sessions.delete(record.id);
      return null;
    }
    if (this.#sessions.get(record.id) !== record.exp) {
      return null;
    }
    return { id: record.id, exp: record.exp };
  }

  private writeCookie(res: Response, value: string, maxAge: number): void {
    const parts = [
      `${PreviewGate.cookieName(this.#secure)}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAge}`,
    ];
    if (this.#secure) {
      parts.push("Secure");
    }
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  private redirect(res: Response, location: string, status = 302): void {
    res.status(status);
    res.setHeader("Location", location);
    res.setHeader("Cache-Control", "no-store");
    res.end();
  }

  /** API answers JSON. A file answers plain text. Neither answer is the login document, and neither challenges Basic. */
  private unauthorized(res: Response, path: string): void {
    const api = path === "/api" || path.startsWith("/api/");
    res.status(401);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (api) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "preview_auth_required" }));
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Unauthorized\n");
  }

  private sendPage(
    res: Response,
    options: {
      readonly status: number;
      readonly next: string;
      readonly username?: string;
      readonly error?: "wrong" | "locked" | "form";
      readonly retry?: number;
    },
  ): void {
    const copy = options.error ? PreviewGate.copy(options.error, options.retry) : null;
    res.status(options.status);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", PreviewGate.PAGE_CSP);
    if (options.status === 429 && options.retry) {
      res.setHeader("Retry-After", String(options.retry));
    }
    res.end(PreviewGate.page({ next: options.next, username: options.username ?? "", copy }));
  }

  static copy(kind: "wrong" | "locked" | "form", retry = 1): { readonly en: string; readonly id: string } {
    if (kind === "locked") {
      return {
        en: `Too many sign-in attempts. Try again in ${retry} seconds.`,
        id: `Terlalu banyak percobaan masuk. Coba lagi dalam ${retry} detik.`,
      };
    }
    if (kind === "form") {
      return {
        en: "Send the username and password in the form.",
        id: "Kirim nama pengguna dan kata sandi lewat formulir.",
      };
    }
    return {
      en: "That username or password is not right.",
      id: "Nama pengguna atau kata sandi itu tidak tepat.",
    };
  }

  static page(options: {
    readonly next: string;
    readonly username: string;
    readonly copy: { readonly en: string; readonly id: string } | null;
  }): string {
    const error = options.copy
      ? `<p class="error" role="alert" data-testid="preview-error">${PreviewGate.escape(options.copy.en)} <span lang="id">${PreviewGate.escape(options.copy.id)}</span></p>`
      : "";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · Nultron</title>
<link rel="icon" href="/brand/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #f3f5fa; color: #0b1020;
    font-family: "DM Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    width: min(100%, 400px); margin: 24px; padding: 28px 24px 24px;
    background: #fff; border: 1px solid #e4e7ef; border-radius: 4px;
  }
  h1 { margin: 0; font-size: 28px; letter-spacing: -0.011em; line-height: 1.2; }
  h1 span { display: block; margin-top: 4px; font-size: 15px; font-weight: 400; color: #5a6072; }
  p.lead { margin: 16px 0 0; color: #2c3244; line-height: 1.6; }
  form { margin-top: 20px; display: grid; gap: 14px; }
  label { display: grid; gap: 6px; font-size: 15px; }
  label span { color: #5a6072; font-size: 13px; }
  input {
    width: 100%; padding: 10px 12px; border: 1px solid #e4e7ef; border-radius: 4px;
    background: #fff; color: #0b1020; font: inherit; font-size: 16px;
  }
  input:focus { outline: 2px solid #0e58f0; border-color: #0e58f0; }
  button {
    margin-top: 4px; padding: 10px 14px; border: 1px solid #0e58f0; border-radius: 4px;
    background: #0e58f0; color: #fff; font: inherit; font-size: 16px; cursor: pointer;
    box-shadow: 0 3px 0 #0a3ea8;
  }
  .error { margin: 16px 0 0; color: #b42318; line-height: 1.5; }
  .error span { display: block; color: #5a6072; }
</style>
</head>
<body>
<main data-testid="preview-login">
  <h1>Sign in <span lang="id">Masuk</span></h1>
  <p class="lead">This preview is private. <span lang="id">Pratinjau ini bersifat pribadi.</span></p>
  ${error}
  <form method="post" action="/login" data-testid="preview-login-form">
    <input type="hidden" name="next" value="${PreviewGate.escape(options.next)}">
    <label>Username <span lang="id">Nama pengguna</span>
      <input name="username" autocomplete="username" required data-testid="preview-username" value="${PreviewGate.escape(options.username)}">
    </label>
    <label>Password <span lang="id">Kata sandi</span>
      <input type="password" name="password" autocomplete="current-password" required data-testid="preview-password">
    </label>
    <button type="submit" data-testid="preview-submit">Sign in / Masuk</button>
  </form>
</main>
</body>
</html>`;
  }

  private static async readBody(req: Request): Promise<{ ok: true; text: string } | { ok: false }> {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    try {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > PreviewGate.BODY_LIMIT) {
          over = true;
          continue;
        }
        chunks.push(buffer);
      }
    } catch {
      return { ok: false };
    }
    if (over) {
      return { ok: false };
    }
    return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
  }
}
