/**
 * A local stand-in for Meta's side of WhatsApp, over real HTTP, so the whole customer inbox can be
 * driven through the Customers page with no Meta account.
 *
 * It plays both halves of the conversation:
 *   - the Graph API the app calls (read a number, send a text), and
 *   - Meta's webhook, which it signs with the app secret exactly the way Meta does and POSTs to the app.
 *
 * ```
 * npx tsx scripts/whatsapp-sandbox.ts                      # listens on 127.0.0.1:3398
 * AGENTFORGE_WHATSAPP_API_URL=http://127.0.0.1:3398 \
 * AGENTFORGE_WHATSAPP_APP_SECRET=sandbox-app-secret-not-a-real-secret \
 * AGENTFORGE_WHATSAPP_VERIFY_TOKEN=sandbox-verify-token \
 *   pnpm dev
 * ```
 *
 * Then, in the app: Customers → connect a number → paste the number id and access token this prints.
 * To make a customer write:
 *
 * ```
 * curl -X POST http://127.0.0.1:3398/_sandbox/arrive \
 *   -H 'content-type: application/json' \
 *   -d '{"from":"6281200000001","name":"Dewi","text":"Ada kopi?"}'
 * ```
 *
 * Other controls (all JSON):
 *   POST /_sandbox/arrive      { from?, name?, text?, type?, phoneNumberId?, id? }  a customer message
 *   POST /_sandbox/status      { messageId, status: sent|delivered|read|failed }    a delivery report
 *   POST /_sandbox/fail-next   { status?, code?, message? }                         make the next send fail
 *   GET  /_sandbox/handshake                                                        run Meta's verify handshake
 *   GET  /_sandbox/state                                                            what the app has sent
 *
 * When the app sends a reply, this also reports it back as delivered and then read a moment later
 * (set AUTO_RECEIPTS=0 to turn that off), so the page shows its ticks without a second terminal.
 *
 * Dev tooling, never shipped: `AGENTFORGE_WHATSAPP_API_URL` is ignored in a packaged build and when
 * `NODE_ENV=production` (`packages/core/src/inbox/pinned.ts`), so this cannot re-point the real
 * product. Loopback only. Every credential here is a made-up sandbox value.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WHATSAPP_WEBHOOK_PATH } from "../packages/core/src/inbox";
import {
  SANDBOX_ACCESS_TOKEN,
  SANDBOX_APP_SECRET,
  SANDBOX_PHONE_NUMBER_ID,
  SANDBOX_VERIFY_TOKEN,
  createMetaSandbox,
} from "../packages/host/src/inbox/__fixtures__/meta-api";

const PORT = Number(process.env.PORT ?? 3398);
const HOST = "127.0.0.1";
const APP_URL = (process.env.APP_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const AUTO_RECEIPTS = process.env.AUTO_RECEIPTS !== "0";

const sandbox = createMetaSandbox();

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body, null, 2));
}

/** POST a signed delivery to the app, the way Meta would. */
async function deliverToApp(rawBody: string): Promise<{ status: number; body: string }> {
  const answer = await fetch(`${APP_URL}${WHATSAPP_WEBHOOK_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sandbox.signature(rawBody) },
    body: rawBody,
  });
  return { status: answer.status, body: await answer.text() };
}

/** After the app sends, report the message back as delivered and then read. */
function scheduleReceipts(messageId: string, to: string, phoneNumberId: string): void {
  if (!AUTO_RECEIPTS) {
    return;
  }
  for (const [status, after] of [
    ["delivered", 1200],
    ["read", 3200],
  ] as const) {
    setTimeout(() => {
      void deliverToApp(sandbox.statusBody({ messageId, status, to, phoneNumberId }))
        .then((result) => console.log(`[sandbox] ${status} report for ${messageId} → app answered ${result.status}`))
        .catch((error) => console.log(`[sandbox] ${status} report failed: ${String(error)}`));
    }, after);
  }
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
    const body = await readBody(request);

    try {
      if (url.pathname === "/_sandbox/state") {
        send(response, 200, {
          phoneNumberId: SANDBOX_PHONE_NUMBER_ID,
          sent: sandbox.sent,
          calls: sandbox.calls.map((call) => ({ ...call, authorization: call.authorization ? "Bearer <sandbox>" : null })),
        });
        return;
      }

      if (url.pathname === "/_sandbox/arrive") {
        const input = JSON.parse(body || "{}") as Parameters<typeof sandbox.inboundBody>[0];
        const result = await deliverToApp(sandbox.inboundBody(input));
        console.log(`[sandbox] customer message → app answered ${result.status}`);
        send(response, 200, { ok: result.status === 200, appStatus: result.status, appBody: result.body });
        return;
      }

      if (url.pathname === "/_sandbox/status") {
        const input = JSON.parse(body || "{}") as Parameters<typeof sandbox.statusBody>[0];
        const result = await deliverToApp(sandbox.statusBody(input));
        console.log(`[sandbox] ${input.status} report → app answered ${result.status}`);
        send(response, 200, { ok: result.status === 200, appStatus: result.status, appBody: result.body });
        return;
      }

      if (url.pathname === "/_sandbox/fail-next") {
        const input = JSON.parse(body || "{}") as { status?: number; code?: number; message?: string };
        sandbox.failNextSend({
          status: input.status ?? 400,
          code: input.code ?? 131047,
          message: input.message ?? "Re-engagement message",
        });
        send(response, 200, { ok: true });
        return;
      }

      if (url.pathname === "/_sandbox/handshake") {
        const challenge = "sandbox-challenge-1234";
        const query = new URLSearchParams({
          "hub.mode": "subscribe",
          "hub.verify_token": SANDBOX_VERIFY_TOKEN,
          "hub.challenge": challenge,
        });
        const answer = await fetch(`${APP_URL}${WHATSAPP_WEBHOOK_PATH}?${query.toString()}`);
        const text = await answer.text();
        send(response, 200, { ok: answer.status === 200 && text === challenge, appStatus: answer.status, appBody: text });
        return;
      }

      // Everything else is the Graph API itself, answered by the same fixture the tests use.
      const headers = new Headers();
      const authorization = request.headers.authorization;
      if (authorization) {
        headers.set("authorization", authorization);
      }
      const method = request.method ?? "GET";
      const answer = await sandbox.fetch(`http://${HOST}:${PORT}${url.pathname}`, {
        method,
        headers,
        body: method === "GET" || !body ? undefined : body,
      });
      const text = await answer.text();
      console.log(`[sandbox] ${method} ${url.pathname} → ${answer.status}`);
      if (method === "POST" && answer.status === 200 && url.pathname.endsWith("/messages")) {
        const latest = sandbox.sent[sandbox.sent.length - 1];
        if (latest) {
          scheduleReceipts(latest.id, latest.to, latest.phoneNumberId);
        }
      }
      response.writeHead(answer.status, { "Content-Type": "application/json" });
      response.end(text);
    } catch (error) {
      send(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`WhatsApp sandbox on http://${HOST}:${PORT}  (the app is expected at ${APP_URL})`);
  console.log(`  phone number id : ${SANDBOX_PHONE_NUMBER_ID}`);
  console.log(`  access token    : ${SANDBOX_ACCESS_TOKEN}`);
  console.log("  start the app with:");
  console.log(`    AGENTFORGE_WHATSAPP_API_URL=http://${HOST}:${PORT} \\`);
  console.log(`    AGENTFORGE_WHATSAPP_APP_SECRET=${SANDBOX_APP_SECRET} \\`);
  console.log(`    AGENTFORGE_WHATSAPP_VERIFY_TOKEN=${SANDBOX_VERIFY_TOKEN} \\`);
  console.log("    pnpm dev");
  console.log(`  a customer writes: curl -X POST http://${HOST}:${PORT}/_sandbox/arrive -H 'content-type: application/json' -d '{"text":"Ada kopi?"}'`);
});
