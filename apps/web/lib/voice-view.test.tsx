/**
 * The voice view and the mic, rendered to a string in each state, in both languages.
 *
 * `renderToStaticMarkup` runs no effects and has no layout, so this holds what a render shows: the
 * words, the labels, which controls exist, the order of the parts. What the page does with a real
 * microphone is driven in a browser (`.cursor/skills/verify-agentforge/features/voice.md`).
 */
import { GATEWAY_NAME } from "@agentforge/core/gateway";
import { VOICE_END_REASONS, VOICE_STATES, type VoiceHostFrame } from "@agentforge/core/voice";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ChatComposer } from "@/components/chat-composer";
import { VoiceMicButton } from "@/components/voice/voice-mic-button";
import { VoiceView, type VoiceViewProps } from "@/components/voice/voice-view";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import {
  initialVoiceViewState,
  VOICE_ERROR_CODES,
  voiceViewReducer,
  type VoiceViewAction,
  type VoiceViewState,
} from "./voice-view-state";

const LOCALES = ["en", "id"] as const;

const frame = (value: VoiceHostFrame): VoiceViewAction => ({ type: "frame", frame: value });
const ready = frame({ type: "ready", sessionId: "sess-1234", threadId: "t1", endsAt: 1 });

function stateFrom(actions: readonly VoiceViewAction[]): VoiceViewState {
  return actions.reduce(voiceViewReducer, initialVoiceViewState());
}

function liveIn(value: (typeof VOICE_STATES)[number], more: readonly VoiceViewAction[] = []): VoiceViewState {
  return stateFrom([{ type: "open" }, ready, frame({ type: "state", value }), ...more]);
}

const noop = () => {};

function render(view: VoiceViewState, extra: Partial<VoiceViewProps> = {}): string {
  return renderToStaticMarkup(
    <VoiceView
      view={view}
      onEnd={noop}
      onReconnect={noop}
      onMode={noop}
      onHoldStart={noop}
      onHoldEnd={noop}
      onRunCard={noop}
      {...extra}
    />,
  );
}

/** The mascot's own root element: its `data-state` and `data-busy`. */
function mascotOf(html: string): { state: string | null; busy: boolean } {
  const tag = /<span[^>]*data-testid="chat-mascot"[^>]*>/.exec(html)?.[0] ?? "";
  return { state: /data-state="([^"]+)"/.exec(tag)?.[1] ?? null, busy: tag.includes('data-busy="true"') };
}

afterEach(() => resetLocaleForTests());

describe.each(LOCALES)("the voice view (%s)", (locale) => {
  it("names itself, can be closed, and says everything is saved as text", () => {
    applyLocale(locale);
    const html = render(liveIn("listening"));
    expect(html).toContain('role="dialog"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toContain(t("voice.view.title"));
    expect(html).toContain(`aria-label="${t("voice.view.close")}"`);
    expect(html).toContain(t("voice.view.savedNote"));
    expect(html).toContain(t("voice.view.end"));
  });

  it("does not trap the focus: it is a non-modal dialog, and every control is a plain button", () => {
    applyLocale(locale);
    const html = render(liveIn("listening"));
    expect(html).toContain('aria-modal="false"');
    expect(html).not.toContain('tabindex="0"');
    expect(html).not.toMatch(/tabindex="[1-9]/);
  });

  it("shows the connecting state while the session is being made", () => {
    applyLocale(locale);
    const html = render(stateFrom([{ type: "open" }]));
    expect(html).toContain('data-phase="opening"');
    expect(html).toContain(t("voice.state.connecting"));
    expect(mascotOf(html)).toEqual({ state: "idle", busy: false });
    expect(html).toContain(t("voice.view.captionsEmpty"));
  });

  it.each([
    ["listening", "listening", true],
    ["hearing", "listening", true],
    ["thinking", "thinking", true],
    ["speaking", "answering", true],
    ["connecting", "idle", false],
  ] as const)("in `%s` shows the word, the %s pose, busy=%s, and announces the state", (value, pose, busy) => {
    applyLocale(locale);
    const html = render(liveIn(value));
    const word = t(`voice.state.${value}`);
    expect(html).toContain(`data-state="${value}"`);
    expect(html).toContain(`>${word}</p>`);
    expect(mascotOf(html)).toEqual({ state: pose, busy });
    // The announcement: a polite live region carrying the catalog's sentence.
    expect(html).toMatch(/role="status" aria-live="polite"/);
    expect(html).toContain(t("voice.a11y.stateLive", { state: word }));
  });

  it("shows the cut-in hint only while the agent speaks", () => {
    applyLocale(locale);
    for (const value of VOICE_STATES) {
      const html = render(liveIn(value));
      expect(html.includes(t("voice.hint.bargeIn")), value).toBe(value === "speaking");
    }
  });

  it("labels the captions, with the shell's name for the agent and the catalog's as a fallback", () => {
    applyLocale(locale);
    const view = liveIn("listening", [
      frame({ type: "caption", role: "user", id: "u1", text: "what is on today", final: true }),
      frame({ type: "caption", role: "assistant", id: "a1", text: "Two meetings", final: false }),
    ]);
    const named = render(view, { assistantName: "Zara" });
    expect(named).toContain(t("voice.view.you"));
    expect(named).toContain(">Zara<");
    expect(named).toContain("what is on today");
    expect(named).toContain("Two meetings");
    expect(named).toContain('data-final="false"');
    expect(named).not.toContain(t("voice.view.captionsEmpty"));
    const fallback = render(view);
    expect(fallback).toContain(`>${t("voice.view.assistant")}<`);
  });

  it("marks a reply that was cut short", () => {
    applyLocale(locale);
    const view = liveIn("listening", [
      frame({ type: "caption", role: "assistant", id: "a1", text: "Two mee", final: true, interrupted: true }),
    ]);
    expect(render(view)).toContain(t("voice.caption.interrupted"));
    const whole = liveIn("listening", [
      frame({ type: "caption", role: "assistant", id: "a1", text: "Done", final: true }),
    ]);
    expect(render(whole)).not.toContain(t("voice.caption.interrupted"));
  });

  it("shows the card with its label, its summary and one button, then what started", () => {
    applyLocale(locale);
    const view = liveIn("listening", [
      frame({ type: "card", card: { prompt: "make the deck", summary: "Make the Q3 deck" } }),
    ]);
    const html = render(view);
    expect(html).toContain(t("voice.card.label"));
    expect(html).toContain("Make the Q3 deck");
    expect(html).toContain(t("voice.card.run"));
    expect(html).not.toContain(t("voice.card.started"));
    // The prompt is what the tap sends; the view does not print it.
    expect(html).not.toContain("make the deck");

    const started = render(voiceViewReducer(view, { type: "card_started" }));
    expect(started).toContain(t("voice.card.started"));
    expect(started).not.toContain('data-testid="voice-card-run"');
  });

  it("offers hands-free and push-to-talk, with the current one pressed", () => {
    applyLocale(locale);
    const hands = render(liveIn("listening"));
    expect(hands).toContain(t("voice.mode.handsFree"));
    expect(hands).toContain(t("voice.mode.pushToTalk"));
    expect(hands).toContain(`aria-label="${t("voice.mode.switchLabel")}"`);
    expect(hands).toMatch(/aria-pressed="true"[^>]*data-testid="voice-mode-hands-free"/);
    expect(hands).toMatch(/aria-pressed="false"[^>]*data-testid="voice-mode-push-to-talk"/);
  });

  it("shows the big hold button in push-to-talk and not in hands-free", () => {
    applyLocale(locale);
    const hands = render(liveIn("listening"));
    expect(hands).not.toContain('data-testid="voice-hold"');
    const ptt = render(voiceViewReducer(liveIn("listening"), { type: "mode", value: "push_to_talk" }));
    expect(ptt).toContain('data-testid="voice-hold"');
    expect(ptt).toContain(t("voice.mode.hold"));
    expect(ptt).toMatch(/aria-pressed="true"[^>]*data-testid="voice-mode-push-to-talk"/);
  });

  it("disables the hold button until the session is live", () => {
    applyLocale(locale);
    const connecting = voiceViewReducer(stateFrom([{ type: "open" }]), { type: "mode", value: "push_to_talk" });
    expect(render(connecting)).toMatch(/<button[^>]*disabled=""[^>]*data-testid="voice-hold"/);
  });

  it.each(VOICE_END_REASONS)("says why it ended: %s", (reason) => {
    applyLocale(locale);
    const view = voiceViewReducer(liveIn("speaking"), { type: "frame", frame: { type: "ended", reason } });
    const html = render(view);
    expect(html).toContain(t(`voice.ended.${reason}`));
    expect(html).toContain('data-phase="ended"');
    // Nothing live is left on screen: no hold button, no end button, no state word.
    expect(html).not.toContain('data-testid="voice-end"');
    expect(html).not.toContain('data-testid="voice-hold"');
    expect(html).not.toContain('data-testid="voice-state"');
    // The way back, except where the person ended it themselves.
    expect(html.includes('data-testid="voice-reconnect"')).toBe(reason !== "user");
    if (reason !== "user") {
      expect(html).toContain(t("voice.reconnect.button"));
    }
    expect(mascotOf(html)).toEqual({ state: "idle", busy: false });
  });

  it("says the screen locked, with the way back", () => {
    applyLocale(locale);
    const html = render(voiceViewReducer(liveIn("listening"), { type: "backgrounded" }));
    expect(html).toContain(t("voice.phone.backgrounded"));
    expect(html).toContain('data-kind="backgrounded"');
    expect(html).toContain(t("voice.reconnect.button"));
  });

  it.each(VOICE_ERROR_CODES)("says what went wrong: %s", (code) => {
    applyLocale(locale);
    const html = render(stateFrom([{ type: "open" }, { type: "failed", code }]));
    const line = t(`voice.error.${code}`, { gatewayName: GATEWAY_NAME });
    expect(html).toContain(line.replace(/&/g, "&amp;").replace(/'/g, "&#x27;"));
    expect(html).not.toContain("{gatewayName}");
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-kind="error"');
  });

  it("names the gateway in the no-key line, never typing the product's own name for it", () => {
    applyLocale(locale);
    const html = render(stateFrom([{ type: "open" }, { type: "failed", code: "gateway_blocked" }]));
    expect(html).toContain(GATEWAY_NAME);
  });

  it("offers Talk again for what can change, and not for an old browser or an http page", () => {
    applyLocale(locale);
    const open = (code: (typeof VOICE_ERROR_CODES)[number]) =>
      render(stateFrom([{ type: "open" }, { type: "failed", code }]));
    expect(open("micDenied")).toContain('data-testid="voice-reconnect"');
    expect(open("connect")).toContain('data-testid="voice-reconnect"');
    expect(open("unsupported")).not.toContain('data-testid="voice-reconnect"');
    expect(open("insecure")).not.toContain('data-testid="voice-reconnect"');
  });
});

describe.each(LOCALES)("the mic in the composer (%s)", (locale) => {
  const composer = (voice?: Parameters<typeof ChatComposer>[0]["voice"]) =>
    renderToStaticMarkup(
      <ChatComposer threadId={null} modalities={["text"]} onDelta={noop} onComplete={noop} voice={voice} />,
    );

  it("is hidden when the host has voice off, or says nothing about it", () => {
    applyLocale(locale);
    expect(composer(undefined)).not.toContain("composer-mic");
    expect(composer({ available: false, active: false, disabled: false, onToggle: noop })).not.toContain(
      "composer-mic",
    );
  });

  it("is shown between the message box and Send when voice is on", () => {
    applyLocale(locale);
    const html = composer({ available: true, active: false, disabled: false, onToggle: noop });
    const text = html.indexOf('data-testid="composer-text"');
    const mic = html.indexOf('data-testid="composer-mic"');
    const send = html.indexOf('data-testid="composer-send"');
    expect(mic).toBeGreaterThan(text);
    expect(send).toBeGreaterThan(mic);
    expect(html).toContain(`aria-label="${t("voice.mic.start")}"`);
    expect(html).toContain('aria-pressed="false"');
  });

  it("ends voice while it is open: the same button, named for what it does", () => {
    applyLocale(locale);
    const html = composer({ available: true, active: true, disabled: false, onToggle: noop });
    expect(html).toContain(`aria-label="${t("voice.mic.stop")}"`);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("composer-mic-active");
  });

  it("is disabled, with the reason, while a Chat reply is streaming", () => {
    applyLocale(locale);
    const html = composer({ available: true, active: false, disabled: true, onToggle: noop });
    expect(html).toMatch(/aria-disabled="true"/);
    expect(html).toContain(`title="${t("voice.mic.disabledHint")}"`);
    expect(html).toMatch(/aria-describedby="([^"]+)"/);
    expect(html).toContain(t("voice.mic.disabledHint"));
  });

  it("stays usable to end voice even when a reply is streaming", () => {
    applyLocale(locale);
    const html = renderToStaticMarkup(
      <VoiceMicButton voice={{ available: true, active: true, disabled: true, onToggle: noop }} busy />,
    );
    expect(html).not.toContain("aria-disabled");
  });
});
