/**
 * The Meeting desk's front door (doc-flow, 2026-10-05): one prompt box, a drop zone for a recording or a
 * transcript, a paste option and a Run button. Nothing here is paid until Run is pressed, and the page says
 * so.
 *
 * The environment is node with no DOM, so the intake is rendered to markup. The drop itself (a browser
 * `DragEvent`) and what happens after it (create the meeting, upload, free) are driven in a browser; the
 * decisions behind them are pinned in `meeting-intake.test.ts`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingIntake, type MeetingIntakeProps } from "@/components/meeting-intake";
import { applyLocale, resetLocaleForTests } from "./i18n";

function props(overrides: Partial<MeetingIntakeProps> = {}): MeetingIntakeProps {
  return {
    prompt: "",
    onPrompt: vi.fn(),
    paste: "",
    onPasteChange: vi.fn(),
    onSavePaste: vi.fn(),
    showPaste: true,
    running: false,
    jobBusy: false,
    busy: false,
    uploading: false,
    fileDisabled: false,
    hasSource: false,
    hasMinutes: false,
    needsKey: false,
    alwaysTranslate: false,
    meetingTitle: null,
    recording: null,
    transcriptWords: null,
    notice: null,
    onFile: vi.fn(),
    onRun: vi.fn(),
    onCancel: vi.fn(),
    onNew: vi.fn(),
    ...overrides,
  };
}

const html = (overrides: Partial<MeetingIntakeProps> = {}) => renderToStaticMarkup(<MeetingIntake {...props(overrides)} />);

afterEach(() => resetLocaleForTests());

describe("the front door", () => {
  it("opens on one prompt box, a drop zone, a paste option and Run", () => {
    applyLocale("en");
    const out = html();
    for (const id of ["meeting-prompt", "meeting-drop", "meeting-file", "meeting-how", "meeting-paste", "meeting-run"]) {
      expect(out, id).toContain(`data-testid="${id}"`);
    }
    expect(out).toContain("What do you need from this meeting?");
    expect(out).toContain('placeholder="Minutes and who does what"');
    expect(out).toContain("Drop a recording or a transcript here");
  });

  it("has no title, language or model field up front: those are under More", () => {
    const out = html();
    for (const id of ["meeting-title", "meeting-locale", "meeting-model", "meeting-create"]) {
      expect(out, id).not.toContain(`data-testid="${id}"`);
    }
  });

  it("lets the file picker offer a recording and a transcript", () => {
    const out = html();
    expect(out).toContain("audio/*");
    expect(out).toContain(".vtt");
    expect(out).toContain(".pdf");
  });

  it("keeps the paste box closed until it is wanted", () => {
    const out = html();
    expect(out).toContain('data-testid="meeting-how"');
    expect(out).not.toMatch(/data-testid="meeting-how"[^>]* open/);
    expect(out).toContain("Or paste a transcript");
  });

  it("hides the paste option once the meeting has its transcript", () => {
    expect(html({ showPaste: false })).not.toContain('data-testid="meeting-how"');
  });
});

describe("Run", () => {
  it("says it is the paid step and uses the key, in one line", () => {
    applyLocale("en");
    const out = html();
    expect(out).toContain('data-testid="meeting-run-note"');
    expect(out).toContain("Run is the paid step: it uses your key to transcribe and write the minutes.");
  });

  it("says translating too when the owner asked for it every time", () => {
    const out = html({ alwaysTranslate: true });
    expect(out).toContain("write the minutes and translate them.");
  });

  it("cannot be pressed with nothing to run on", () => {
    expect(html()).toMatch(/<button[^>]*disabled=""[^>]*data-testid="meeting-run"/);
  });

  it("can be pressed once there is a recording or a transcript", () => {
    expect(html({ hasSource: true })).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="meeting-run"/);
  });

  it("is quiet while the hosted desk has no key", () => {
    expect(html({ hasSource: true, needsKey: true })).toMatch(/<button[^>]*disabled=""[^>]*data-testid="meeting-run"/);
  });

  it("reads Run again once there are minutes, which a regenerate keeps the owner's edits in", () => {
    applyLocale("en");
    expect(html({ hasSource: true, hasMinutes: true })).toContain("Run again");
    expect(html({ hasSource: true })).not.toContain("Run again");
  });

  it("offers Cancel only while a job runs", () => {
    expect(html()).not.toContain("meeting-cancel");
    expect(html({ jobBusy: true, hasSource: true })).toContain('data-testid="meeting-cancel"');
  });

  it("says it in Bahasa Indonesia", () => {
    applyLocale("id");
    const out = html();
    expect(out).toContain("Apa yang Anda butuhkan dari rapat ini?");
    expect(out).toContain("Jalankan");
    expect(out).toContain("Jalankan adalah langkah berbayar");
    expect(out).not.toContain("meeting.");
  });
});

describe("the drop zone", () => {
  it("says adding a file is free", () => {
    applyLocale("en");
    expect(html()).toContain("Adding a file is free. Nothing is paid until you press Run.");
  });

  it("names the recording that is in, and the way to start another meeting", () => {
    applyLocale("en");
    const out = html({ hasSource: true, recording: { name: "weekly.mp3", bytes: 2 * 1024 * 1024 } });
    expect(out).toContain('data-testid="meeting-recording"');
    expect(out).toContain("weekly.mp3 · 2.0 MB");
    expect(out).toContain("Drop another file to start a new meeting.");
  });

  it("names the transcript that is in", () => {
    applyLocale("en");
    const out = html({ hasSource: true, transcriptWords: 1234 });
    expect(out).toContain('data-testid="meeting-transcript-ready"');
    expect(out).toContain("Transcript ready · 1234 words");
  });

  it("shows a notice about the drop, such as a file that is neither", () => {
    const out = html({ notice: "That file is not a recording or a transcript." });
    expect(out).toContain('data-testid="meeting-drop-notice"');
    expect(out).toContain("That file is not a recording or a transcript.");
  });

  it("shows the file as it is added", () => {
    expect(html({ uploading: true })).toContain('data-testid="meeting-uploading"');
  });

  it("locks the picker while a recording is being made or a file is in flight", () => {
    expect(html({ fileDisabled: true })).toMatch(/<input[^>]*disabled=""[^>]*data-testid="meeting-file"/);
  });
});
