/**
 * An in-memory stand-in for Meta's side of WhatsApp: the Graph API the host calls, and the signed
 * webhook bodies Meta calls the host with.
 *
 * One fixture, two users: the tests hand `sandbox.fetch` to the client (so a route that tried to
 * reach the real network would fail loudly), and `scripts/whatsapp-sandbox.ts` wraps the same object
 * in a real HTTP server so the whole app can be driven through the Customers page with no Meta
 * account. Phase 1 needs nothing from Meta to build and test; the live number is Phase 3.
 *
 * It signs requests the way Meta does: `X-Hub-Signature-256: sha256=` plus the hex HMAC-SHA256 of the
 * raw body under the app secret.
 */

import { signBody } from "../whatsapp";

export const SANDBOX_ACCESS_TOKEN = "EAAsandboxtokenforlocaldriveonly0123456789";
export const SANDBOX_APP_SECRET = "sandbox-app-secret-not-a-real-secret";
export const SANDBOX_VERIFY_TOKEN = "sandbox-verify-token";
export const SANDBOX_PHONE_NUMBER_ID = "105550000000001";

export type SandboxNumber = { id: string; displayPhone: string; verifiedName: string };

export const DEFAULT_NUMBERS: SandboxNumber[] = [
  { id: SANDBOX_PHONE_NUMBER_ID, displayPhone: "+62 812-0000-0001", verifiedName: "Sandbox Coffee" },
];

export type SentMessage = { id: string; phoneNumberId: string; to: string; text: string; at: number };

export type MetaSandboxOptions = {
  numbers?: SandboxNumber[];
  token?: string;
  appSecret?: string;
  now?: () => number;
};

/** A Graph error body, with the code the host maps (131047 is "re-engagement": the window had closed). */
export type GraphFailure = { status: number; code: number; message: string };

export function createMetaSandbox(options: MetaSandboxOptions = {}) {
  const numbers = options.numbers ?? DEFAULT_NUMBERS;
  const token = options.token ?? SANDBOX_ACCESS_TOKEN;
  const appSecret = options.appSecret ?? SANDBOX_APP_SECRET;
  const now = options.now ?? Date.now;
  const calls: Array<{ method: string; url: string; authorization: string | null; body: unknown }> = [];
  const sent: SentMessage[] = [];
  let counter = 0;
  let nextFailure: GraphFailure | null = null;

  function wamid(): string {
    counter += 1;
    return `wamid.SANDBOX${String(counter).padStart(6, "0")}`;
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function graphError(status: number, code: number, message: string): Response {
    return json(status, { error: { message, type: "OAuthException", code, fbtrace_id: "SANDBOX" } });
  }

  /** The Graph API, as far as the host uses it: read a number, send a text. */
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url: url.href, authorization, body });

    if (authorization !== `Bearer ${token}`) {
      return graphError(401, 190, "Invalid OAuth access token.");
    }
    const parts = url.pathname.split("/").filter(Boolean); // [version, id, 'messages'?]
    const id = parts[1] ?? "";
    const number = numbers.find((row) => row.id === id);
    if (!number) {
      return graphError(400, 100, `Unsupported get request. Object with ID '${id}' does not exist.`);
    }
    if (method === "GET" && parts.length === 2) {
      return json(200, { display_phone_number: number.displayPhone, verified_name: number.verifiedName, id });
    }
    if (method === "POST" && parts[2] === "messages") {
      if (nextFailure) {
        const failure = nextFailure;
        nextFailure = null;
        return graphError(failure.status, failure.code, failure.message);
      }
      const request = (body ?? {}) as { to?: string; text?: { body?: string } };
      const messageId = wamid();
      sent.push({ id: messageId, phoneNumberId: id, to: String(request.to ?? ""), text: String(request.text?.body ?? ""), at: now() });
      return json(200, {
        messaging_product: "whatsapp",
        contacts: [{ input: request.to, wa_id: request.to }],
        messages: [{ id: messageId }],
      });
    }
    return graphError(400, 100, "Unsupported request.");
  };

  /* ------------------------------------------------------------------ Meta → host: deliveries */

  type InboundInput = {
    phoneNumberId?: string;
    from?: string;
    name?: string;
    text?: string;
    id?: string;
    /** Unix milliseconds. */
    at?: number;
    /** A non-text type; the sandbox sends a payload shaped like Meta's for it. */
    type?: string;
  };

  /** A messages delivery, as the JSON string Meta would POST. */
  function inboundBody(input: InboundInput = {}): string {
    const phoneNumberId = input.phoneNumberId ?? SANDBOX_PHONE_NUMBER_ID;
    const from = input.from ?? "6281200000001";
    const type = input.type ?? "text";
    const message: Record<string, unknown> = {
      from,
      id: input.id ?? wamid(),
      timestamp: String(Math.floor((input.at ?? now()) / 1000)),
      type,
    };
    if (type === "text") {
      message.text = { body: input.text ?? "hello from the sandbox" };
    } else {
      message[type] = { id: "MEDIA-ID-NOT-FETCHED", caption: "a caption the host must never copy" };
    }
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-SANDBOX",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "628120000001", phone_number_id: phoneNumberId },
                contacts: [{ profile: { name: input.name ?? "Dewi" }, wa_id: from }],
                messages: [message],
              },
            },
          ],
        },
      ],
    });
  }

  /** A delivery report for a message the host sent. */
  function statusBody(input: {
    phoneNumberId?: string;
    messageId: string;
    status: "sent" | "delivered" | "read" | "failed";
    to?: string;
    at?: number;
    errorTitle?: string;
  }): string {
    const phoneNumberId = input.phoneNumberId ?? SANDBOX_PHONE_NUMBER_ID;
    const row: Record<string, unknown> = {
      id: input.messageId,
      status: input.status,
      timestamp: String(Math.floor((input.at ?? now()) / 1000)),
      recipient_id: input.to ?? "6281200000001",
    };
    if (input.status === "failed") {
      row.errors = [{ code: 131026, title: input.errorTitle ?? "Message undeliverable" }];
    }
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-SANDBOX",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "628120000001", phone_number_id: phoneNumberId },
                statuses: [row],
              },
            },
          ],
        },
      ],
    });
  }

  /** The signature header Meta would send for `body`. */
  function signature(body: string): string {
    return signBody(body, appSecret);
  }

  return {
    fetch: fetchImpl,
    token,
    appSecret,
    numbers,
    calls,
    sent,
    inboundBody,
    statusBody,
    signature,
    /** Make the next send fail the way Meta would. */
    failNextSend(failure: GraphFailure): void {
      nextFailure = failure;
    },
  };
}

export type MetaSandbox = ReturnType<typeof createMetaSandbox>;
