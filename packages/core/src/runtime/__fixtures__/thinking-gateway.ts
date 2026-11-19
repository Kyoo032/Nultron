import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";

export type ThinkingGatewayMode = "A" | "B" | "unfinished" | "clean" | "401";

export async function startThinkingGateway(
  mode: ThinkingGatewayMode,
  options: { port?: number; beforeDrop?: () => Promise<void>; onRequest?: (count: number) => void } = {},
) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gemini-3.5-flash", object: "model" }] }));
      return;
    }
    requests += 1;
    options.onRequest?.(requests);
    req.resume();
    if (mode === "401") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unauthorized", code: 401 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const responses = req.url?.includes("/responses");
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const gemini = (text: string, thought: boolean, finish = false) => ({
      candidates: [
        {
          content: { role: "model", parts: [{ text, ...(thought ? { thought: true } : {}) }] },
          ...(finish ? { finishReason: "STOP" } : {}),
          index: 0,
        },
      ],
    });
    if (responses) {
      send({ type: "response.created", response: { id: "resp_1", created_at: 1, model: "gpt-5.6" } });
      send({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1", summary: [] },
      });
      send({
        type: "response.reasoning_summary_part.added",
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
      send({
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        delta: "Weighing the options.",
      });
    } else {
      send(gemini("Weighing the options.", true));
    }
    if (requests === 1 && mode !== "clean") {
      await (options.beforeDrop?.() ?? setTimeout(150));
      if (mode === "A") {
        res.socket?.destroy();
      } else {
        if (mode === "B") res.write('data: {"candidates":');
        res.end();
      }
      return;
    }
    if (responses) {
      if (mode !== "clean") {
        send({
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "message", id: "msg_1", role: "assistant", content: [] },
        });
        send({ type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "ok" });
      }
      send({
        type: "response.completed",
        response: { id: "resp_1", incomplete_details: null, usage: { input_tokens: 3, output_tokens: 2 } },
      });
    } else {
      send(gemini(mode === "clean" ? "" : "ok", mode === "clean", true));
    }
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing gateway address");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
