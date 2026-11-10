/**
 * Isolation for the voice eval's unit tests, run before every test module: a `fetch` to anywhere but this
 * machine's loopback throws. The tests start their own fake host on a loopback port and talk to that; a call
 * that would reach a real desk, a gateway or the internet is a bug in the test.
 */
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(target).hostname.replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`eval/voice tests must not call out (${host}); talk to the fake host on loopback.`);
  }
  return realFetch(input, init);
}) as typeof fetch;
