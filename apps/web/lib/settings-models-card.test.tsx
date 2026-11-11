import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLocale, resetLocaleForTests } from "./i18n";
import {
  availabilityFrom,
  reasonKey,
  SettingsModelsCard,
  type ModelAvailabilityWire,
} from "@/components/settings-models-card";

vi.mock("@/lib/api-client", () => ({
  apiFetch: async () => ({ ok: true, json: async () => ({}) }) as Response,
}));

afterEach(() => resetLocaleForTests());

/** What the host answered for the prepaid key of 2026-11-11 after the three refusals were learned. */
const WIRE: ModelAvailabilityWire = {
  unavailable: [
    {
      id: "grok-imagine-video",
      kind: "video",
      status: "account_blocked",
      reason: "prepaid_async_requires_fixed_price",
      checkedAt: "2026-11-11T10:00:00.000Z",
    },
    {
      id: "kling-v3",
      kind: "video",
      status: "no_channel",
      reason: "no available channel",
      checkedAt: "2026-11-11T10:00:00.000Z",
    },
    {
      id: "veo_3_1-fast",
      kind: "video",
      status: "upstream_rejected",
      reason: "bad_response_status_code",
      checkedAt: "2026-11-11T10:00:00.000Z",
    },
    { id: "lumen-art-3", kind: "image", status: "not_on_key", reason: "not_listed", checkedAt: null },
    {
      id: "suno_music",
      kind: "music",
      status: "not_on_key",
      reason: "model_not_found",
      checkedAt: "2026-11-11T10:00:00.000Z",
    },
  ],
  kinds: {
    chat: { offered: 40 },
    image: { offered: 1 },
    video: { offered: 3 },
    speech: { offered: 1 },
    music: { offered: 0 },
    transcription: { offered: 2 },
  },
};

function html(availability: ModelAvailabilityWire | null, hasKey = true): string {
  return renderToStaticMarkup(
    <SettingsModelsCard availability={availability} onRefreshed={() => undefined} hasKey={hasKey} />,
  );
}

describe("availabilityFrom", () => {
  it("reads the host's answer and drops rows it cannot read", () => {
    const parsed = availabilityFrom({
      unavailable: [
        { id: "a", kind: "video", status: "no_channel", reason: "r", checkedAt: null },
        { id: 7, kind: "video", status: "no_channel" },
        null,
      ],
      kinds: { video: { offered: 2 }, chat: { offered: "many" } },
    });
    expect(parsed?.unavailable.map((row) => row.id)).toEqual(["a"]);
    expect(parsed?.kinds).toEqual({ video: { offered: 2 } });
  });

  it("answers nothing for an answer that is not an object", () => {
    expect(availabilityFrom(undefined)).toBeNull();
    expect(availabilityFrom("no")).toBeNull();
  });
});

describe("reasonKey", () => {
  it("separates a model the key never listed from one the gateway refused", () => {
    expect(reasonKey({ status: "not_on_key", reason: "not_listed" })).toBe("settings.models.reason.not_listed");
    expect(reasonKey({ status: "not_on_key", reason: "model_not_found" })).toBe("settings.models.reason.not_on_key");
    expect(reasonKey({ status: "no_channel", reason: "" })).toBe("settings.models.reason.no_channel");
    expect(reasonKey({ status: "account_blocked", reason: "" })).toBe("settings.models.reason.account_blocked");
    expect(reasonKey({ status: "upstream_rejected", reason: "" })).toBe("settings.models.reason.upstream_rejected");
  });
});

describe("SettingsModelsCard", () => {
  it("counts what each kind still offers and says plainly when a kind has none", () => {
    applyLocale("en");
    const markup = html(WIRE);
    expect(markup).toContain('data-testid="settings-models"');
    expect(markup).toMatch(/Video: 3 available/);
    expect(markup).toMatch(/Music: none on this key/);
  });

  it("lists the models this key cannot use, collapsed, each with a plain reason", () => {
    applyLocale("en");
    const markup = html(WIRE);
    // A native <details> without `open`: the list is there for the person who asks, hidden otherwise.
    expect(markup).toMatch(/<details[^>]*data-testid="settings-models-unavailable"/);
    expect(markup).not.toMatch(/<details[^>]*\sopen/);
    expect(markup).toContain("Models this key can&#x27;t use (5)");
    expect(markup).toContain("grok-imagine-video");
    expect(markup).toContain("A prepaid account cannot submit jobs that are billed after they finish");
    expect(markup).toContain("The gateway had no channel for it");
    expect(markup).toContain("This key&#x27;s model list does not include it.");
  });

  it("says so when every listed model is offered", () => {
    applyLocale("en");
    const markup = html({ unavailable: [], kinds: { chat: { offered: 10 } } });
    expect(markup).toContain("Models this key can&#x27;t use (0)");
    expect(markup).toContain("Every model this key lists is offered.");
  });

  it("is in Indonesian too", () => {
    applyLocale("id");
    const markup = html(WIRE);
    expect(markup).toContain("Model yang bisa dipakai kunci ini");
    expect(markup).toMatch(/Video: 3 tersedia/);
    expect(markup).toContain("Periksa lagi");
    expect(markup).not.toContain("Check again");
  });

  it("draws nothing without a key or without an answer", () => {
    applyLocale("en");
    expect(html(WIRE, false)).toBe("");
    expect(html(null)).toBe("");
  });
});
