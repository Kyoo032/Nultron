/**
 * A `403 gateway_blocked` from a Finance call, read into the needs-key sentence (hosted only).
 *
 * The host answers the flat body `{ error: "gateway_blocked", status, message }`. Every Finance reader
 * used to read only the enveloped `{ error: { code, message } }`, so a closed gate printed the generic
 * fallback ("Could not read those figures"). Each reader is driven here through the real `apiFetch`
 * with a stubbed `fetch`, the same way `gateway-blocked.test.ts` drives the shared path. The Personal
 * app keeps the message it always had.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGateStateForTests } from "./gate-state";
import { gatewayBlockedMessage, resetGatewayBlockedForTests } from "./gateway-blocked";
import { resetSettingsReadForTests } from "./settings-read";
import { applyLocale, resetLocaleForTests } from "./i18n";
import {
  FinanceRequestError,
  financeFailure,
  parseFinanceFigures,
  regenerateFinanceSection,
  type FinanceResult,
} from "./finance-client";
import { importFinanceFile } from "./finance-import-client";
import { downloadFinanceExport } from "./finance-export";
import { parseBudgetFigures } from "./finance-budget-client";
import { parseRatiosStatement } from "./finance-ratios-client";

type Answer = { status: number; body: unknown };

const BLOCKED_BODY = {
  error: "gateway_blocked",
  status: "needs_key",
  message: "No gateway key is saved on this machine.",
};

let answer: Answer = { status: 403, body: BLOCKED_BODY };

beforeEach(() => {
  answer = { status: 403, body: BLOCKED_BODY };
  resetGateStateForTests();
  resetGatewayBlockedForTests();
  resetSettingsReadForTests();
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "Content-Type": "application/json" },
      }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetGateStateForTests();
  resetLocaleForTests();
});

/** The error a reader rejects with. A reader that resolves is a failure of this test, so it throws. */
async function refusal(call: () => Promise<unknown>): Promise<FinanceRequestError | Error> {
  try {
    await call();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the reader to reject");
}

const BRIEF = {} as FinanceResult["brief"];

/** Every Finance call the renderer makes that can reach the host's gate or answer with an error body. */
const CALLS: ReadonlyArray<{ name: string; call: () => Promise<unknown> }> = [
  { name: "parse", call: () => parseFinanceFigures("Revenue 100") },
  {
    name: "regenerate",
    call: () => regenerateFinanceSection({ brief: BRIEF, sectionIndex: 0, prompt: "", inputs: {} }),
  },
  { name: "budget parse", call: () => parseBudgetFigures("Sales 100", { fallbackError: "budget read failed" }) },
  { name: "ratios parse", call: () => parseRatiosStatement("Cash 100", "", "ratios read failed") },
  { name: "import", call: () => importFinanceFile(new File(["a,b\n1,2"], "figures.csv", { type: "text/csv" })) },
  {
    name: "export",
    call: () => downloadFinanceExport({ brief: BRIEF, format: "xlsx" }, "export failed"),
  },
];

describe("hosted: a flat 403 gateway_blocked reads as the needs-key sentence", () => {
  beforeEach(() => {
    vi.stubGlobal("__AGENTFORGE_SERVER__", "1");
  });

  for (const { name, call } of CALLS) {
    it(`${name} rejects with the needs-key sentence, never the generic fallback`, async () => {
      const error = await refusal(call);

      expect(error.message).toBe(gatewayBlockedMessage());
    });
  }

  it("parse and regenerate keep the typed gateway_blocked code the studio branches on", async () => {
    for (const { call } of CALLS.filter((entry) => entry.name === "parse" || entry.name === "regenerate")) {
      const error = await refusal(call);

      expect(error).toBeInstanceOf(FinanceRequestError);
      expect((error as FinanceRequestError).code).toBe("gateway_blocked");
      expect((error as FinanceRequestError).status).toBe(403);
    }
  });

  it("the sentence names Settings and carries none of the host's English or its code", async () => {
    const message = (await refusal(() => parseFinanceFigures("Revenue 100"))).message;

    expect(message).toMatch(/Settings/);
    expect(message).not.toMatch(/machine|gateway_blocked|No gateway key/);
  });

  it("speaks Indonesian on an id desk", async () => {
    const english = (await refusal(() => parseFinanceFigures("Revenue 100"))).message;
    applyLocale("id");
    const indonesian = (await refusal(() => parseFinanceFigures("Revenue 100"))).message;

    expect(indonesian).toBe(gatewayBlockedMessage());
    expect(indonesian).toMatch(/Pengaturan/);
    expect(indonesian).not.toBe(english);
  });

  it("an enveloped error keeps the host's own message: it is not a gateway block", async () => {
    answer = { status: 422, body: { error: { code: "invalid_finance", message: "No figures were read." } } };

    const error = (await refusal(() => parseFinanceFigures("Revenue 100"))) as FinanceRequestError;

    expect(error.message).toBe("No figures were read.");
    expect(error.code).toBe("invalid_finance");
  });

  it("financeFailure reads the flat body as the sentence, and any other body as it did before", () => {
    const blocked = financeFailure(BLOCKED_BODY, "fallback", 403);
    expect(blocked.message).toBe(gatewayBlockedMessage());
    expect(blocked.code).toBe("gateway_blocked");

    const other = financeFailure({ error: { code: "x", message: "host says no" } }, "fallback", 500);
    expect(other.message).toBe("host says no");
    expect(other.code).toBe("x");
  });
});

describe("the Personal app: the flat body is read exactly as it always was", () => {
  it("parse keeps its generic fallback and never shows the sentence", async () => {
    const error = (await refusal(() => parseFinanceFigures("Revenue 100"))) as FinanceRequestError;

    expect(error.message).not.toBe(gatewayBlockedMessage());
    expect(error.message).toMatch(/Could not read those figures/);
    expect(error.code).toBe("request_failed");
  });

  it("financeFailure does not read a flat block off the hosted build", () => {
    const error = financeFailure(BLOCKED_BODY, "fallback", 403);

    expect(error.message).toBe("fallback");
    expect(error.code).toBe("request_failed");
  });
});
