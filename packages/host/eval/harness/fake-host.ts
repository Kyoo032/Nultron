/**
 * A scripted stand-in for the webdev host, for the unit tests: a `fetch` that answers by method and
 * path and remembers every request it was given. It speaks the host's real shapes (JSON bodies, the
 * `event:`/`data:` framing of `encodeSse`), so a case is exercised end to end without a network.
 */
export type SeenRequest = { method: string; path: string; headers: Headers; body: unknown };
export type FakeAnswer = Response | ((request: SeenRequest) => Response);

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function sse(events: ReadonlyArray<Record<string, unknown>>, options: { splitAt?: number } = {}): Response {
  const text = `: connected\n\n${events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")}`;
  const cut = options.splitAt ?? text.length;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text.slice(0, cut)));
      if (cut < text.length) {
        controller.enqueue(encoder.encode(text.slice(cut)));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function fakeHost(answers: Readonly<Record<string, FakeAnswer>>): { fetch: typeof fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const fake = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const request: SeenRequest = {
      method,
      path: `${url.pathname}${url.search}`,
      headers: new Headers(init?.headers),
      body: init?.body instanceof FormData ? init.body : typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    seen.push(request);
    const answer = answers[`${method} ${request.path}`];
    if (!answer) {
      return json({ error: { code: "not_found", message: `no fake for ${method} ${request.path}` } }, 404);
    }
    return typeof answer === "function" ? answer(request) : answer.clone();
  }) as typeof fetch;
  return { fetch: fake, seen };
}
