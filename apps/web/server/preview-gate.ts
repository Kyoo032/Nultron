import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isServerMode, localeFromAcceptLanguage, type AppLocale, type EnvLike } from "@agentforge/core";
import type { Request, RequestHandler, Response } from "express";
import { createRateLimiter, type RateLimiter } from "../../../packages/host/src/rate-limit";

type PreviewCopy = {
  readonly title: string;
  readonly lead: string;
  readonly username: string;
  readonly password: string;
  readonly show: string;
  readonly hide: string;
  readonly submit: string;
  readonly busy: string;
  readonly wrong: (retry: number) => string;
  readonly locked: (retry: number) => string;
  readonly form: (retry: number) => string;
};

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
 * password. The HMAC key is 32 random bytes minted once for this process (`processKey`): a restart
 * drops every preview session, and the sessions live in this one process. Login attempts spend a
 * token from the same bucket primitive the hosted limiter uses (`createRateLimiter` in
 * `packages/host/src/rate-limit.ts`). Nothing here sends `WWW-Authenticate`.
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

  /** Inline document only: the script is ours, the mark and DM Sans are data URLs, and the bundle stays private. */
  static readonly PAGE_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

  /** Same key the desk boot script reads (`apps/web/lib/theme.ts`). Light unless the person chose dark. */
  static readonly THEME_STORAGE_KEY = "agentforge-theme";

  static readonly #assets = new Map<string, string>();

  /** One key for the life of the process. A second process, or a restart, will not honour these cookies. */
  static #processKey: Buffer | null = null;

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
    this.#key = PreviewGate.processKey();
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

  static requireProduction(env: EnvLike): PreviewGate {
    if (env.NODE_ENV !== "production") {
      throw new Error("The live preview requires NODE_ENV=production.");
    }
    const gate = PreviewGate.fromEnv(env);
    if (!gate) {
      throw new Error("The live preview requires server mode off and both PREVIEW_BASIC_USER and PREVIEW_BASIC_PASSWORD.");
    }
    return gate;
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

  /** 32 random bytes, created the first time a gate is constructed in this process. */
  static processKey(): Buffer {
    PreviewGate.#processKey ??= randomBytes(32);
    return PreviewGate.#processKey;
  }

  static fixedEqual(left: string, right: string): boolean {
    const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
    return timingSafeEqual(digest(left), digest(right));
  }

  /**
   * Last `X-Forwarded-For` hop only when the socket is loopback, which is Caddy in the preview's
   * network namespace. A direct connection ignores the header: the client could set it. An IPv6
   * address is then keyed by its /64, so a temporary address in the same prefix shares one bucket.
   */
  static clientKey(req: Request): string {
    const remote = req.socket?.remoteAddress ?? "";
    const forwarded = req.header("x-forwarded-for");
    let chosen = remote;
    if (forwarded && PreviewGate.isLoopback(remote)) {
      const last = forwarded.split(",").at(-1)?.trim();
      if (last) {
        chosen = last;
      }
    }
    if (!chosen) {
      return "unknown";
    }
    return PreviewGate.rateAddress(chosen);
  }

  /**
   * IPv4 stays as written. An IPv4-mapped IPv6 address is keyed by the embedded IPv4, so mapped
   * clients do not collapse into one /64 of `::ffff:0:0`. Every other IPv6 address is its first 64 bits.
   */
  static rateAddress(address: string): string {
    let bare = address.trim().toLowerCase();
    if (bare.startsWith("[")) {
      const end = bare.indexOf("]");
      if (end > 1) {
        bare = bare.slice(1, end);
      }
    }
    const zone = bare.indexOf("%");
    if (zone >= 0) {
      bare = bare.slice(0, zone);
    }
    if (bare.length === 0) {
      return "unknown";
    }
    if (PreviewGate.isLoopback(bare)) {
      return bare;
    }
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare)) {
      return bare;
    }
    const groups = PreviewGate.expandIpv6(bare);
    if (!groups) {
      return bare.slice(0, 128);
    }
    const mapped =
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0xffff;
    if (mapped) {
      const hi = groups[6] ?? 0;
      const lo = groups[7] ?? 0;
      return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    }
    const hex = (value: number | undefined): string => (value ?? 0).toString(16);
    return `${hex(groups[0])}:${hex(groups[1])}:${hex(groups[2])}:${hex(groups[3])}::/64`;
  }

  /** Eight hextets, or null when the text is not an IPv6 address. A dotted tail is expanded first. */
  static expandIpv6(input: string): number[] | null {
    let value = input.toLowerCase();
    const dotted = value.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) {
      const parts = (dotted[2] ?? "").split(".").map((part) => Number(part));
      if (parts.length !== 4 || parts.some((part) => part > 255)) {
        return null;
      }
      const hi = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
      const lo = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
      value = `${dotted[1] ?? ""}${hi.toString(16)}:${lo.toString(16)}`;
    }
    const halves = value.split("::");
    if (halves.length > 2) {
      return null;
    }
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    if (halves.length === 1 && head.length !== 8) {
      return null;
    }
    const missing = 8 - head.length - tail.length;
    if (missing < 0) {
      return null;
    }
    const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
    if (groups.length !== 8) {
      return null;
    }
    const nums: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return null;
      }
      nums.push(Number.parseInt(group, 16));
    }
    return nums;
  }

  static isLoopback(address: string): boolean {
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  }

  /**
   * A same-origin form post. `Sec-Fetch-Site: cross-site` is refused first. `Origin: null` is
   * accepted only with `Sec-Fetch-Site: same-origin`: that is what Chrome sends for this page,
   * because it is `Referrer-Policy: no-referrer`. The same literal with `same-site`, or with the
   * header missing, is a sibling port or subdomain and is refused. A missing Origin (curl) is
   * still allowed. A real Origin must match this request's scheme, hostname and port.
   */
  static sameSitePost(req: Request): boolean {
    const site = req.header("sec-fetch-site")?.trim().toLowerCase();
    if (site === "cross-site") {
      return false;
    }
    const origin = req.header("origin")?.trim();
    if (origin?.toLowerCase() === "null") {
      return site === "same-origin";
    }
    if (!origin) {
      return true;
    }
    return PreviewGate.originMatchesHost(origin, req.header("host") ?? "", PreviewGate.requestScheme(req));
  }

  /**
   * The scheme the browser used. A loopback socket (Caddy, in the preview's network namespace)
   * may say so with `X-Forwarded-Proto`. Any other socket is the connection itself.
   */
  static requestScheme(req: Request): "http" | "https" {
    const remote = req.socket?.remoteAddress ?? "";
    const forwarded = req.header("x-forwarded-proto");
    if (forwarded && PreviewGate.isLoopback(remote)) {
      const first = forwarded.split(",")[0]?.trim().toLowerCase();
      if (first === "http" || first === "https") {
        return first;
      }
    }
    return req.protocol === "https" ? "https" : "http";
  }

  /**
   * Scheme, hostname and port. A port the header leaves out is 443 for https and 80 for http.
   * Hostname alone is not a match: another port on the same host is a different origin.
   */
  static originMatchesHost(origin: string, hostHeader: string, scheme: "http" | "https"): boolean {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.username !== "" || url.password !== "") {
      return false;
    }
    const originScheme = url.protocol === "https:" ? "https" : url.protocol === "http:" ? "http" : null;
    if (!originScheme) {
      return false;
    }
    const host = PreviewGate.splitHost(hostHeader);
    if (!host) {
      return false;
    }
    const originPort = url.port || (originScheme === "https" ? "443" : "80");
    const hostPort = host.port ?? (scheme === "https" ? "443" : "80");
    return originScheme === scheme && host.hostname === url.hostname.toLowerCase() && hostPort === originPort;
  }

  /** `host` or `host:port`, and `[ipv6]` or `[ipv6]:port`. The port is null when the header omits it. */
  static splitHost(hostHeader: string): { hostname: string; port: string | null } | null {
    const value = hostHeader.trim().toLowerCase();
    if (value.length === 0) {
      return null;
    }
    if (value.startsWith("[")) {
      const ipv6 = /^(\[[0-9a-f:.]+\])(?::(\d+))?$/.exec(value);
      if (!ipv6) {
        return null;
      }
      try {
        const hostname = new URL(`http://${ipv6[1]}`).hostname;
        return { hostname, port: ipv6[2] ?? null };
      } catch {
        return null;
      }
    }
    const colon = value.lastIndexOf(":");
    if (colon === -1) {
      return { hostname: value, port: null };
    }
    const hostname = value.slice(0, colon);
    const port = value.slice(colon + 1);
    if (hostname.length === 0 || !/^\d+$/.test(port)) {
      return null;
    }
    return { hostname, port };
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

  /**
   * A path on this origin, or `/`. Percent-encoding is decoded until it stops changing, then the
   * URL parser runs: `/.//evil.com` and `/%252f%252fevil.com` both become a pathname of `//…`.
   * A backslash is rejected before and after that parse.
   */
  static safeNext(value: string | null | undefined): string {
    if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\") || PreviewGate.hasControl(value)) {
      return "/";
    }
    const decoded = PreviewGate.decodeFully(value);
    if (decoded === null) {
      return "/";
    }
    try {
      const url = new URL(decoded, "http://preview.local");
      if (url.origin !== "http://preview.local" || url.username !== "" || url.password !== "") {
        return "/";
      }
      const out = `${url.pathname}${url.search}`;
      if (PreviewGate.offPath(out)) {
        return "/";
      }
      if (url.pathname === PreviewGate.LOGIN_PATH || url.pathname === PreviewGate.LOGOUT_PATH) {
        return "/";
      }
      return out;
    } catch {
      return "/";
    }
  }

  /** Percent-decode until the text stops changing. Null when a step is not a same-origin path. */
  static decodeFully(value: string): string | null {
    let current = value;
    for (let round = 0; round < 8; round += 1) {
      if (PreviewGate.offPath(current)) {
        return null;
      }
      let next: string;
      try {
        next = decodeURIComponent(current);
      } catch {
        return null;
      }
      if (next === current) {
        return current;
      }
      current = next;
    }
    return PreviewGate.offPath(current) ? null : current;
  }

  /** True when a path would leave this origin: a second slash, a backslash, or a control character. */
  static offPath(value: string): boolean {
    return !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || PreviewGate.hasControl(value);
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
        this.sendPage(req, res, { status: 200, next: PreviewGate.safeNext(PreviewGate.queryString(req.query.next)) });
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
    if (!PreviewGate.sameSitePost(req)) {
      this.forbidden(res);
      return;
    }
    const current = this.session(req);
    if (current) {
      this.#sessions.delete(current.id);
    }
    this.writeCookie(res, "", 0);
    this.redirect(res, PreviewGate.LOGIN_PATH, 303);
  }

  private async login(req: Request, res: Response): Promise<void> {
    const next = PreviewGate.safeNext(PreviewGate.queryString(req.query.next));
    if (!PreviewGate.sameSitePost(req)) {
      this.forbidden(res);
      return;
    }
    // The token is spent before the body is read, so a locked address cannot upload a large body.
    const decision = this.#attempts.take(PreviewGate.clientKey(req), Date.now());
    if (!decision.allowed) {
      this.discard(req, res);
      this.sendPage(req, res, {
        status: 429,
        next,
        error: "locked",
        retry: decision.retryAfterSeconds,
      });
      return;
    }
    const type = (req.header("content-type") ?? "").toLowerCase();
    if (!type.startsWith("application/x-www-form-urlencoded")) {
      this.discard(req, res);
      this.sendPage(req, res, { status: 400, next, error: "form" });
      return;
    }
    let answered = false;
    const body = await PreviewGate.readBody(req, () => {
      answered = true;
      if (!res.headersSent) {
        this.sendPage(req, res, { status: 413, next, error: "form" });
      }
    });
    if (!body.ok) {
      if (!answered && !res.headersSent) {
        this.sendPage(req, res, { status: 413, next, error: "form" });
      }
      if (!req.destroyed) {
        req.destroy();
      }
      return;
    }
    const params = new URLSearchParams(body.text);
    const givenUser = params.get("username") ?? "";
    const givenPassword = params.get("password") ?? "";
    const destination = PreviewGate.safeNext(params.get("next") ?? next);
    const match = PreviewGate.credentialsMatch(givenUser, givenPassword, this.#user, this.#password);
    if (!match) {
      this.sendPage(req, res, { status: 401, next: destination, username: givenUser, error: "wrong" });
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

  /** Drop the rest of the body once the response has been written. A locked post must not be buffered. */
  private discard(req: Request, res: Response): void {
    res.once("finish", () => {
      if (!req.destroyed) {
        req.destroy();
      }
    });
  }

  private forbidden(res: Response): void {
    res.status(403);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end("Forbidden\n");
  }

  private redirect(res: Response, location: string, status = 302): void {
    const target = location.startsWith("/") && !location.startsWith("//") && !location.includes("\\") ? location : "/";
    res.status(status);
    res.setHeader("Location", target);
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
    req: Request,
    res: Response,
    options: {
      readonly status: number;
      readonly next: string;
      readonly username?: string;
      readonly error?: "wrong" | "locked" | "form";
      readonly retry?: number;
    },
  ): void {
    const locale = PreviewGate.localeOf(req);
    const text = PreviewGate.text(locale);
    const message = options.error ? text[options.error](options.retry ?? 1) : null;
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
    res.end(
      PreviewGate.page({
        locale,
        text,
        next: options.next,
        username: options.username ?? "",
        error: options.error ?? null,
        message,
      }),
    );
  }

  /** One language per document, the same rule as `localeFromAcceptLanguage`: no opinion is English. */
  static localeOf(req: Request): AppLocale {
    return localeFromAcceptLanguage(req.header("accept-language")) ?? "en";
  }

  static text(locale: AppLocale): PreviewCopy {
    if (locale === "id") {
      return {
        title: "Masuk",
        lead: "Pratinjau ini bersifat pribadi.",
        username: "Nama pengguna",
        password: "Kata sandi",
        show: "Tampilkan",
        hide: "Sembunyikan",
        submit: "Masuk",
        busy: "Sedang masuk…",
        wrong: () => "Nama pengguna atau kata sandi itu tidak tepat.",
        locked: (retry) => `Terlalu banyak percobaan masuk. Coba lagi dalam ${retry} detik.`,
        form: () => "Kirim nama pengguna dan kata sandi lewat formulir.",
      };
    }
    return {
      title: "Sign in",
      lead: "This preview is private.",
      username: "Username",
      password: "Password",
      show: "Show",
      hide: "Hide",
      submit: "Sign in",
      busy: "Signing in…",
      wrong: () => "That username or password is not right.",
      locked: (retry) => `Too many sign-in attempts. Try again in ${retry} seconds.`,
      form: () => "Send the username and password in the form.",
    };
  }

  /** The size-tuned mark and DM Sans, read once. A missing file leaves the wordmark and the system stack. */
  static asset(relative: string, mime: string): string {
    const cached = PreviewGate.#assets.get(relative);
    if (cached !== undefined) {
      return cached;
    }
    let uri = "";
    try {
      const bytes = readFileSync(fileURLToPath(new URL(relative, import.meta.url)));
      uri = `data:${mime};base64,${bytes.toString("base64")}`;
    } catch {
      uri = "";
    }
    PreviewGate.#assets.set(relative, uri);
    return uri;
  }

  static page(options: {
    readonly locale: AppLocale;
    readonly text: PreviewCopy;
    readonly next: string;
    readonly username: string;
    readonly error: "wrong" | "locked" | "form" | null;
    readonly message: string | null;
  }): string {
    const text = options.text;
    const alert = options.message
      ? `<p class="alert" role="alert" data-testid="preview-error" data-reason="${options.error}">${PreviewGate.escape(options.message)}</p>`
      : "";
    const invalid = options.error ? "true" : "false";
    const mark = PreviewGate.asset("../components/brand-art/mark-64.png", "image/png");
    const font = PreviewGate.asset("../app/fonts/dm-sans-400-latin.woff2", "font/woff2");
    const face = font
      ? `@font-face{font-family:"DM Sans";font-style:normal;font-weight:400;font-display:swap;src:url("${font}") format("woff2");}`
      : "";
    return `<!doctype html>
<html lang="${options.locale}" class="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${PreviewGate.escape(text.title)} · Nultron</title>
<link rel="icon" href="/brand/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
<script>(function(){try{var d=document.documentElement;var dark=localStorage.getItem(${JSON.stringify(PreviewGate.THEME_STORAGE_KEY)})==="dark";d.classList.toggle("light",!dark);d.classList.toggle("dark",dark)}catch(e){}})();</script>
<style>
${face}
:root {
  color-scheme: light;
  --surface: #ffffff;
  --surface-2: #f3f5fa;
  --line: #e4e7ef;
  --text: #0b1020;
  --text-2: #2c3244;
  --text-3: #5a6072;
  --accent: #0e58f0;
  --accent-edge: color-mix(in srgb, var(--accent) 72%, #000000);
  --danger: #b42318;
  --nultron-blue: #1277c8;
  --nultron-cyan: #19bddc;
  --nultron-blue-text: #116eb8;
  --nultron-cyan-text: #107589;
  --font: "DM Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --r-nav: 10px;
  --r-card: 18px;
  --shadow-float: 0 10px 30px -12px color-mix(in srgb, var(--accent) 38%, transparent);
  --motion: 120ms cubic-bezier(0.22, 0.61, 0.36, 1);
}
.dark {
  color-scheme: dark;
  --surface: #1a1d26;
  --surface-2: #232734;
  --line: #313646;
  --text: #f2f4fa;
  --text-2: #c9cedc;
  --text-3: #9aa1b4;
  --accent: #6ea4ff;
  --danger: #f87171;
  --nultron-blue-text: #5fb0f1;
  --nultron-cyan-text: #44e3eb;
  --shadow-float: 0 10px 30px -12px color-mix(in srgb, var(--accent) 26%, transparent);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
  color: var(--text);
  font-family: var(--font);
  background-color: var(--surface);
  background-image:
    radial-gradient(55% 38% at 92% -4%, color-mix(in srgb, var(--nultron-cyan) 12%, transparent), transparent 72%),
    radial-gradient(60% 30% at 8% 104%, color-mix(in srgb, var(--nultron-blue) 8%, transparent), transparent 70%),
    linear-gradient(180deg, color-mix(in srgb, var(--nultron-blue) 10%, var(--surface)) 0, color-mix(in srgb, var(--nultron-cyan) 5%, var(--surface)) 46%, var(--surface) 80%);
}
.card {
  width: min(100%, 420px);
  padding: 28px 24px 24px;
  background: var(--surface);
  border-radius: var(--r-card);
  box-shadow: var(--shadow-float);
}
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
.brand img { width: 40px; height: 40px; border-radius: 10px; display: block; }
.wordmark {
  width: fit-content;
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.035em;
  line-height: 1;
  color: var(--nultron-blue-text);
  background: linear-gradient(100deg, var(--nultron-blue-text) 0%, var(--nultron-blue-text) 38%, var(--nultron-cyan-text) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
h1 { margin: 0; font-size: 28px; font-weight: 600; letter-spacing: -0.035em; line-height: 1.15; }
.lead { margin: 8px 0 0; color: var(--text-2); font-size: 15px; line-height: 1.6; }
.alert {
  margin: 18px 0 0;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--line));
  border-radius: var(--r-nav);
  background: color-mix(in srgb, var(--danger) 12%, var(--surface));
  color: var(--danger);
  font-size: 15px;
  line-height: 1.5;
}
form { margin-top: 22px; display: grid; gap: 16px; }
.field label {
  display: block;
  margin: 0 0 5px;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.4;
  color: color-mix(in srgb, var(--text) 70%, transparent);
}
.input {
  width: 100%;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text);
  font-family: var(--font);
  font-size: 16px;
  line-height: 1.4;
  padding: 8px 10px;
  border-radius: var(--r-nav);
}
.input:focus { outline: none; border-color: var(--accent); }
.input[aria-invalid="true"] { border-color: var(--danger); }
.password { position: relative; }
.password .input { padding-right: 96px; }
.toggle {
  position: absolute;
  top: 4px;
  right: 4px;
  height: calc(100% - 8px);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  font-family: var(--font);
  font-size: 13px;
  font-weight: 600;
  padding: 0 10px;
  border-radius: 8px;
  cursor: pointer;
}
.toggle:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  margin-top: 4px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--surface);
  font-family: var(--font);
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
  padding: 12px 14px;
  border-radius: var(--r-nav);
  box-shadow: 0 3px 0 var(--accent-edge);
  cursor: pointer;
  transition: translate var(--motion), box-shadow var(--motion), filter var(--motion);
}
.btn:hover { filter: brightness(1.08); }
.btn:focus-visible, .toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn:active:not(:disabled) { translate: 0 2px; box-shadow: 0 1px 0 var(--accent-edge); }
.btn:disabled {
  background: var(--line);
  border-color: var(--line);
  color: var(--text-3);
  box-shadow: none;
  filter: none;
  cursor: not-allowed;
}
@media (prefers-reduced-motion: reduce) {
  .btn { transition: none; }
}
@media (forced-colors: active) {
  .wordmark { background: none; color: LinkText; -webkit-text-fill-color: currentColor; }
}
</style>
</head>
<body>
<main class="card" data-testid="preview-login">
  <div class="brand">
    <img src="${mark}" width="40" height="40" alt="" data-testid="preview-mark">
    <p class="wordmark">Nultron</p>
  </div>
  <h1>${PreviewGate.escape(text.title)}</h1>
  <p class="lead">${PreviewGate.escape(text.lead)}</p>
  ${alert}
  <form method="post" action="/login" data-testid="preview-login-form">
    <input type="hidden" name="next" value="${PreviewGate.escape(options.next)}">
    <div class="field">
      <label for="preview-username">${PreviewGate.escape(text.username)}</label>
      <input class="input" id="preview-username" name="username" autocomplete="username" required spellcheck="false" aria-invalid="${invalid}" data-testid="preview-username" value="${PreviewGate.escape(options.username)}">
    </div>
    <div class="field">
      <label for="preview-password">${PreviewGate.escape(text.password)}</label>
      <div class="password">
        <input class="input" id="preview-password" type="password" name="password" autocomplete="current-password" required aria-invalid="${invalid}" data-testid="preview-password">
        <button class="toggle" type="button" data-testid="preview-password-toggle" aria-controls="preview-password" aria-pressed="false">${PreviewGate.escape(text.show)}</button>
      </div>
    </div>
    <button class="btn" type="submit" data-testid="preview-submit">${PreviewGate.escape(text.submit)}</button>
  </form>
</main>
<script>
(function () {
  var showLabel = ${JSON.stringify(text.show)};
  var hideLabel = ${JSON.stringify(text.hide)};
  var busyLabel = ${JSON.stringify(text.busy)};
  var input = document.getElementById("preview-password");
  var toggle = document.querySelector("[data-testid='preview-password-toggle']");
  var form = document.querySelector("[data-testid='preview-login-form']");
  var button = document.querySelector("[data-testid='preview-submit']");
  if (toggle && input) {
    toggle.addEventListener("click", function () {
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.setAttribute("aria-pressed", show ? "true" : "false");
      toggle.textContent = show ? hideLabel : showLabel;
    });
  }
  if (form && button) {
    form.addEventListener("submit", function () {
      button.disabled = true;
      button.textContent = busyLabel;
    });
  }
})();
</script>
</body>
</html>`;
  }

  /**
   * Read at most `BODY_LIMIT` bytes. The moment the body passes that, `onOver` runs (so the
   * caller can answer 413) and the request is destroyed. Nothing past the limit is kept.
   */
  private static readBody(
    req: Request,
    onOver: () => void,
  ): Promise<{ ok: true; text: string } | { ok: false }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (result: { ok: true; text: string } | { ok: false }): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };
      req.on("data", (chunk: Buffer | string) => {
        if (settled) {
          return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > PreviewGate.BODY_LIMIT) {
          onOver();
          req.destroy();
          finish({ ok: false });
          return;
        }
        chunks.push(buffer);
      });
      req.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
      req.on("error", () => finish({ ok: false }));
    });
  }
}
