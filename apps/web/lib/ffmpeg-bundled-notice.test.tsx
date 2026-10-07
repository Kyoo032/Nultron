/**
 * What a person sees in the packaged app when the ffmpeg that comes with the installer will not run.
 *
 * The packaged installer carries ffmpeg and ffprobe (`apps/desktop/resources/ffmpeg/`), so nobody installs
 * anything by hand there. If the bundled copy still fails, every surface that used to say "install ffmpeg"
 * (the Edit banner, the onboarding setup check, the Meeting studio note) says "reinstall" instead, in English and
 * in Indonesian, and shows no command to copy and no install link. The host decides (`setup.bundled` on the Edit
 * doctor, `ffmpegBundled` on the Meeting capability); these tests hold what the renderer does with that.
 *
 * A desk without the flag keeps the install guide, byte for byte: `edit-hosted-needs-key.test.tsx` pins that markup.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FfmpegSetupNotice } from "@/components/ffmpeg-setup-notice";
import type { EditDoctor } from "./edit-client";
import { meetingFfmpegNoteKey, onboardingFfmpegLaterKey } from "./ffmpeg-notice-copy";
import { applyLocale, resetLocaleForTests, t } from "./i18n";

vi.mock("@/lib/api-client", () => ({
  isElectron: () => true,
  apiFetch: async () => ({ ok: true, json: async () => ({}) }) as Response,
}));

const BUNDLED: EditDoctor = {
  ffmpeg: {
    found: false,
    path: null,
    version: null,
    reason: "exec_failed",
    setup: {
      platform: "windows",
      summary: "The video tools that come with this app could not start. Reinstall the app to fix this.",
      installCommand: "",
      installUrl: "",
      steps: ["Run the installer again. Your desks and files are kept.", "Open the app and press Check again."],
      envVar: "AGENTFORGE_FFMPEG_PATH",
      bundled: true,
    },
  },
};

const DESK: EditDoctor = {
  ffmpeg: {
    found: false,
    path: null,
    version: null,
    reason: "missing",
    setup: {
      platform: "windows",
      summary: "ffmpeg was not found.",
      installCommand: "winget install --id Gyan.FFmpeg -e",
      installUrl: "https://ffmpeg.org/download.html#build-windows",
      steps: ["Open a terminal and run: winget install --id Gyan.FFmpeg -e"],
      envVar: "AGENTFORGE_FFMPEG_PATH",
    },
  },
};

const INSTALL_ADVICE = [
  /winget/i,
  /Gyan/i,
  /brew/i,
  /apt install/i,
  /sudo/i,
  /terminal/i,
  /AGENTFORGE_FFMPEG_PATH/,
  /ffmpeg-install-command/,
  /Install guide/i,
];

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

function render(doctor: EditDoctor, variant: "compact" | "full"): string {
  return renderToStaticMarkup(<FfmpegSetupNotice doctor={doctor} onDoctor={() => {}} variant={variant} />);
}

describe("the Edit banner and the onboarding setup check", () => {
  for (const variant of ["compact", "full"] as const) {
    it(`${variant}: says to reinstall, shows no install command, link or step list, and keeps Check again`, () => {
      const html = render(BUNDLED, variant);

      expect(html).toContain('data-testid="edit-needs-ffmpeg"');
      expect(html).toMatch(/Reinstall Nultron/);
      expect(html).toContain('data-testid="ffmpeg-recheck"');
      expect(html).not.toContain("ffmpeg-setup-steps");
      for (const advice of INSTALL_ADVICE) {
        expect(html, `${variant} ${advice}`).not.toMatch(advice);
      }
    });
  }

  it("says it in Indonesian too, and no English install advice remains", () => {
    applyLocale("id");
    const html = render(BUNDLED, "compact");

    expect(html).toMatch(/Pasang ulang Nultron/);
    expect(html).toMatch(/Periksa lagi/);
    expect(html).not.toMatch(/Reinstall|Check again/);
    for (const advice of INSTALL_ADVICE) {
      expect(html, String(advice)).not.toMatch(advice);
    }
  });

  it("a desk (no bundled flag) still gets the install command", () => {
    const html = render(DESK, "compact");

    expect(html).toContain("winget install --id Gyan.FFmpeg -e");
    expect(html).toContain('data-testid="ffmpeg-install-command"');
  });
});

describe("the catalog copy", () => {
  it("has the three bundled lines in both languages, with the product name filled in", () => {
    for (const locale of ["en", "id"] as const) {
      applyLocale(locale);
      for (const key of [
        "edit.ffmpeg.bundledUnavailable",
        "onboarding.ffmpegBundledLater",
        "meeting.noFfmpegBundled",
      ]) {
        const text = t(key, { productName: "Nultron" });
        expect(text, `${locale} ${key}`).not.toBe(key);
        expect(text, `${locale} ${key}`).toContain("Nultron");
        expect(text, `${locale} ${key}`).not.toContain("{productName}");
        expect(text, `${locale} ${key}`).not.toMatch(/winget|brew|sudo|terminal|AGENTFORGE_FFMPEG_PATH/i);
      }
    }
  });
});

describe("which line the onboarding check and the Meeting studio use", () => {
  it("onboarding: the bundled line for the packaged app's own copy, the install-later line otherwise", () => {
    expect(onboardingFfmpegLaterKey(BUNDLED)).toBe("onboarding.ffmpegBundledLater");
    expect(onboardingFfmpegLaterKey(DESK)).toBe("onboarding.ffmpegLater");
    expect(onboardingFfmpegLaterKey(null)).toBe("onboarding.ffmpegLater");
  });

  it("meeting: nothing when ffmpeg works, the bundled line when the packaged copy failed, else the install line", () => {
    expect(meetingFfmpegNoteKey(null)).toBeNull();
    expect(meetingFfmpegNoteKey({ ffmpeg: true, ffmpegBundled: true })).toBeNull();
    expect(meetingFfmpegNoteKey({ ffmpeg: false, ffmpegBundled: true })).toBe("meeting.noFfmpegBundled");
    expect(meetingFfmpegNoteKey({ ffmpeg: false, ffmpegBundled: false })).toBe("meeting.noFfmpeg");
    expect(meetingFfmpegNoteKey({ ffmpeg: false })).toBe("meeting.noFfmpeg");
  });
});
