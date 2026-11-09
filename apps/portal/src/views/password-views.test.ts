import { describe, expect, it } from "vitest";
import { translator } from "./i18n";
import { changePasswordPage, passwordSignInPage } from "./pages";

const HIDDEN = {
  response_type: "code",
  client_id: "c",
  redirect_uri: "https://localhost:3443/auth/callback",
  state: "s",
};

/** Payloads a value on these screens could carry. Each contains one of `< > " '`. */
const INJECTIONS = [
  '"><script>alert(1)</script>',
  "</textarea><img src=x onerror=alert(1)>",
  "' onmouseover='alert(1)",
  "</style><svg/onload=alert(1)>",
];

function expectNoInjectedMarkup(markup: string, payload: string): void {
  expect(markup).not.toContain(payload);
  for (const opening of ["<script", "<svg", "<textarea"]) {
    expect(markup).not.toContain(opening);
  }
  // The shell's brand mark is the one image, and one `</style>` closes the one stylesheet.
  expect(markup.split("<img")).toHaveLength(2);
  expect(markup.split("</style>")).toHaveLength(2);
}

describe("the password sign-in page", () => {
  const screen = (locale: "en" | "id", extra: Record<string, unknown> = {}) =>
    passwordSignInPage({
      locale,
      t: translator(locale, { passwordMode: true }),
      action: "/authorize/password",
      csrfToken: "csrf-fixed",
      hidden: HIDDEN,
      ...extra,
    });

  it("has a text field for the identifier and a password field, and the password field has no value", () => {
    const markup = screen("en", { identifier: "person.name" });
    expect(markup).toContain('id="identifier" name="identifier" type="text" autocomplete="username"');
    expect(markup).toMatch(/id="password" name="password" type="password" autocomplete="current-password"/);
    expect(markup).toContain('value="person.name"');
    const passwordInput = /<input id="password"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(passwordInput).not.toContain("value=");
    expect(markup).toContain('name="csrf_token" value="csrf-fixed"');
    expect(markup).toContain("<footer>Never share your password with anyone.</footer>");
  });

  it("shows a refusal as one sentence under the heading", () => {
    const markup = screen("en", { error: translator("en")("password.invalid") });
    expect(markup).toContain('<p class="bad">That username or password is not right.');
  });

  it("escapes the identifier it shows back, whatever it holds", () => {
    for (const payload of INJECTIONS) {
      expectNoInjectedMarkup(screen("en", { identifier: payload }), payload);
    }
  });

  it("is in Indonesian too, with no English left on the form", () => {
    const markup = screen("id");
    expect(markup).toContain('<html lang="id">');
    expect(markup).toContain("Nama pengguna atau email");
    expect(markup).toContain("Kata sandi");
    expect(markup).not.toContain("Username or e-mail");
    expect(markup).not.toMatch(/\{\w+\}/);
  });

  it("adds its own spacing to the shared stylesheet and does not replace it", () => {
    const markup = screen("en");
    expect(markup).toContain("label:not(:first-of-type){margin-top:1rem}");
    expect(markup).toContain("footer{margin-top:1.5rem;font-size:.8rem;color:var(--muted)}label:not(");
  });
});

describe("the change-password page", () => {
  const screen = (locale: "en" | "id", extra: Record<string, unknown> = {}) =>
    changePasswordPage({
      locale,
      t: translator(locale),
      action: "/authorize/password/change",
      csrfToken: "csrf-fixed",
      hidden: HIDDEN,
      identifier: "person.name",
      minLength: 12,
      ...extra,
    });

  it("asks for the current password and the new one twice, and carries the identifier hidden", () => {
    const markup = screen("en");
    expect(markup).toContain('name="identifier" value="person.name"');
    for (const name of ["current_password", "new_password", "confirm_password"]) {
      const input = new RegExp(`<input id="${name}"[^>]*>`).exec(markup)?.[0] ?? "";
      expect(input, name).toContain('type="password"');
      expect(input, name).not.toContain("value=");
    }
    expect(markup).toMatch(/id="new_password"[^>]*autocomplete="new-password"[^>]*minlength="12"/);
    expect(markup).toContain("At least 12 characters, and not your username or e-mail.");
  });

  it("escapes the identifier it carries", () => {
    for (const payload of INJECTIONS) {
      expectNoInjectedMarkup(screen("en", { identifier: payload }), payload);
    }
  });

  it("is in Indonesian too", () => {
    const markup = screen("id");
    expect(markup).toContain("Pilih kata sandi baru");
    expect(markup).toContain("Minimal 12 karakter");
    expect(markup).not.toMatch(/\{\w+\}/);
  });
});
