/**
 * Isolation for the harness's unit tests, run before every test module: `fetch` throws. A test that
 * needs one passes its own fake in; a call that reaches this one is a bug in the test, because the
 * smoke lever drives a billed gateway and a unit test must never do that.
 */
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`eval/harness tests must not call out (${new URL(target).host}); pass a fake fetch in.`);
}) as typeof fetch;
