import { createServer } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../errors";
import {
  assertPublicHttpsUrl,
  assertResolvesPublic,
  defaultFetch,
  fetchPublicHttps,
  nextHopUrl,
  pinnedAgent,
  pinnedLookup,
} from "./safe-fetch";
import type { HostLookup } from "./safe-fetch";

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});

type Step = { status: number; headers?: Record<string, string>; body?: string };

/**
 * Every `fetchPublicHttps` case injects a resolver, so no suite depends on DNS being reachable and
 * no `.test` name is ever looked up for real. The default answers with a public address.
 */
const publicLookup: HostLookup = async () => [{ address: "93.184.216.34" }];

function lookupReturning(...addresses: string[]): HostLookup {
  return async () => addresses.map((address) => ({ address }));
}

function fakeFetch(plan: Record<string, Step>, seen: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    const step = plan[url];
    if (!step) {
      throw new Error(`unexpected fetch ${url}`);
    }
    return new Response(step.body ?? "", { status: step.status, headers: step.headers ?? {} });
  }) as typeof fetch;
}

describe("assertPublicHttpsUrl", () => {
  it("accepts public https and rejects everything else", () => {
    expect(assertPublicHttpsUrl("https://example.test/report").hostname).toBe("example.test");
    for (const bad of [
      "http://example.test",
      "https://user:pw@example.test",
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://169.254.169.254/latest/meta-data",
      "https://192.168.1.1/",
      "https://172.16.0.9/",
      "https://[::1]/",
      "https://[fd00::1]/",
      "https://printer.local/",
      "not a url",
    ]) {
      expect(() => assertPublicHttpsUrl(bad), bad).toThrow(ApiError);
    }
  });

  it("resolves relative redirects and re-validates them", () => {
    expect(nextHopUrl("https://a.test/dir/page", "/next")).toBe("https://a.test/next");
    expect(nextHopUrl("https://a.test/", null)).toBeNull();
    expect(() => nextHopUrl("https://a.test/", "http://127.0.0.1:3000/api/v1/settings")).toThrow(/HTTPS/);
    expect(() => nextHopUrl("https://a.test/", "https://169.254.169.254/")).toThrow(/public host/);
  });
});

describe("fetchPublicHttps", () => {
  it("follows safe redirects and returns the final body", async () => {
    const seen: string[] = [];
    const result = await fetchPublicHttps("https://a.test/start", {
      lookupImpl: publicLookup,
      fetchImpl: fakeFetch(
        {
          "https://a.test/start": { status: 302, headers: { location: "https://b.test/final" } },
          "https://b.test/final": { status: 200, headers: { "content-type": "text/html" }, body: "<p>hi</p>" },
        },
        seen,
      ),
    });
    expect(seen).toEqual(["https://a.test/start", "https://b.test/final"]);
    expect(result).toMatchObject({ finalUrl: "https://b.test/final", status: 200, contentType: "text/html" });
    expect(result.body.toString("utf8")).toBe("<p>hi</p>");
  });

  it("stops at a redirect into the local network", async () => {
    const seen: string[] = [];
    await expect(
      fetchPublicHttps("https://a.test/start", {
        lookupImpl: publicLookup,
        fetchImpl: fakeFetch(
          { "https://a.test/start": { status: 301, headers: { location: "http://127.0.0.1:3000/" } } },
          seen,
        ),
      }),
    ).rejects.toThrow(/HTTPS/);
    expect(seen).toEqual(["https://a.test/start"]);
  });

  it("caps hops and body size", async () => {
    const loop: Record<string, Step> = {};
    for (let i = 0; i < 8; i += 1) {
      loop[`https://a.test/${i}`] = { status: 302, headers: { location: `https://a.test/${i + 1}` } };
    }
    await expect(
      fetchPublicHttps("https://a.test/0", { lookupImpl: publicLookup, fetchImpl: fakeFetch(loop, []), maxHops: 3 }),
    ).rejects.toThrow(/Too many redirects/);
    await expect(
      fetchPublicHttps("https://a.test/big", {
        lookupImpl: publicLookup,
        fetchImpl: fakeFetch({ "https://a.test/big": { status: 200, body: "x".repeat(50) } }, []),
        maxBytes: 10,
      }),
    ).rejects.toThrow(/exceeds/);
  });

  it("keeps the first maxBytes of an oversized body when the caller asks to truncate", async () => {
    const result = await fetchPublicHttps("https://a.test/big", {
      lookupImpl: publicLookup,
      fetchImpl: fakeFetch({ "https://a.test/big": { status: 200, body: "x".repeat(50) } }, []),
      maxBytes: 10,
      oversize: "truncate",
    });
    expect(result.body.toString("utf8")).toBe("x".repeat(10));
    expect(result.truncated).toBe(true);
  });

  it("reports a body under the cap as whole", async () => {
    const result = await fetchPublicHttps("https://a.test/small", {
      lookupImpl: publicLookup,
      fetchImpl: fakeFetch({ "https://a.test/small": { status: 200, body: "xyz" } }, []),
      maxBytes: 10,
      oversize: "truncate",
    });
    expect(result.truncated).toBe(false);
  });

  it("maps a caller cancel to an aborted ApiError", async () => {
    const controller = new AbortController();
    controller.abort();
    const never = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    await expect(
      fetchPublicHttps("https://a.test/x", { lookupImpl: publicLookup, fetchImpl: never, signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "aborted",
    });
  });
});

/**
 * The bypasses the old hostname-prefix filter allowed. Each of these parsed to something the check
 * did not recognise, so `assertPublicHttpsUrl` returned and the server connected to the address
 * anyway. Regression-pinned one spelling at a time.
 */
describe("assertPublicHttpsUrl closes the IPv4-mapped and missing-CIDR holes", () => {
  it("refuses IPv4 addresses reached through an IPv6 literal", () => {
    for (const bad of [
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:7f00:1]/",
      "https://[::ffff:169.254.169.254]/",
      "https://[::ffff:a9fe:a9fe]/",
      "https://[::ffff:10.0.0.5]/",
      "https://[64:ff9b::7f00:1]/",
      "https://[64:ff9b::169.254.169.254]/",
      "https://[::127.0.0.1]/",
      "https://[2002:7f00:1::]/",
    ]) {
      expect(() => assertPublicHttpsUrl(bad), bad).toThrow(/public host/);
    }
  });

  it("refuses the IPv4 ranges the prefix list left out", () => {
    for (const bad of [
      "https://100.64.1.1/", // RFC 6598 carrier NAT — cloud internal endpoints
      "https://100.127.255.254/",
      "https://192.0.0.1/", // IETF protocol assignments
      "https://192.0.2.5/", // TEST-NET-1
      "https://198.18.0.1/", // benchmarking
      "https://198.51.100.7/", // TEST-NET-2
      "https://203.0.113.9/", // TEST-NET-3
      "https://224.0.0.1/", // multicast
      "https://255.255.255.255/",
      "https://0.0.0.0/",
    ]) {
      expect(() => assertPublicHttpsUrl(bad), bad).toThrow(/public host/);
    }
  });

  it("refuses the whole of fe80::/10 and the other IPv6 ranges, not just one spelling", () => {
    for (const bad of [
      "https://[fe80::1]/",
      "https://[fe9c::1]/", // inside fe80::/10, missed by a literal "fe80:" test
      "https://[febf:ffff::1]/",
      "https://[fec0::1]/", // deprecated site-local
      "https://[fc00::1]/",
      "https://[fdff::1]/",
      "https://[ff02::1]/", // multicast
      "https://[::]/",
      "https://[2001:db8::1]/", // documentation
    ]) {
      expect(() => assertPublicHttpsUrl(bad), bad).toThrow(/public host/);
    }
  });

  it("still accepts genuinely public addresses and names", () => {
    for (const good of [
      "https://example.com/",
      "https://fdic.gov/", // used to be refused for starting with "fd"
      "https://fc-barcelona.example/", // and this one for "fc"
      "https://8.8.8.8/",
      "https://[2606:4700::1111]/",
      "https://99.64.1.1/", // just below 100.64.0.0/10
      "https://100.63.255.255/",
      "https://100.128.0.1/", // just above it
      "https://172.15.0.1/",
      "https://172.32.0.1/",
    ]) {
      expect(() => assertPublicHttpsUrl(good), good).not.toThrow();
    }
  });

  it("refuses names that by convention mean this machine or this network", () => {
    for (const bad of [
      "https://localhost/",
      "https://app.localhost/",
      "https://printer.local/",
      "https://db.internal/",
      "https://wiki.intranet/",
      "https://router.home.arpa/",
      "https://1.0.0.127.in-addr.arpa/",
    ]) {
      expect(() => assertPublicHttpsUrl(bad), bad).toThrow(/public host/);
    }
  });
});

describe("assertResolvesPublic", () => {
  it("refuses a public NAME that resolves into the local network", async () => {
    // The whole class the lexical check cannot see: localtest.me, <ip>.nip.io, or simply an
    // attacker's own domain with an A record pointing at the VM's metadata service.
    for (const address of ["127.0.0.1", "169.254.169.254", "10.1.2.3", "100.64.0.1", "::1", "::ffff:127.0.0.1"]) {
      await expect(assertResolvesPublic("innocent.example", lookupReturning(address)), address).rejects.toThrow(
        /public host/,
      );
    }
  });

  it("refuses when ANY answer is private, not only the first", async () => {
    await expect(
      assertResolvesPublic("innocent.example", lookupReturning("93.184.216.34", "169.254.169.254")),
    ).rejects.toThrow(/public host/);
  });

  it("never names the address it refused", async () => {
    await expect(assertResolvesPublic("innocent.example", lookupReturning("10.1.2.3"))).rejects.toThrow(
      /^(?!.*10\.1\.2\.3).*$/,
    );
  });

  it("allows a name that resolves to public addresses", async () => {
    await expect(
      assertResolvesPublic("example.com", lookupReturning("93.184.216.34", "2606:2800:220:1::1")),
    ).resolves.toBeUndefined();
  });

  it("does not resolve an IP literal, which was already judged on its bytes", async () => {
    let called = false;
    const spy: HostLookup = async () => {
      called = true;
      return [{ address: "10.0.0.1" }];
    };
    await expect(assertResolvesPublic("93.184.216.34", spy)).resolves.toBeUndefined();
    await expect(assertResolvesPublic("[2606:4700::1111]", spy)).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it("refuses a name that does not resolve, and says so differently from a private answer", async () => {
    const failing: HostLookup = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    await expect(assertResolvesPublic("nothing.invalid", failing)).rejects.toMatchObject({
      code: "invalid_endpoint",
      status: 400,
      message: "Could not resolve this URL's host",
    });
  });

  it("refuses an empty answer", async () => {
    await expect(assertResolvesPublic("nothing.invalid", lookupReturning())).rejects.toMatchObject({
      code: "invalid_endpoint",
      status: 400,
      message: "Could not resolve this URL's host",
    });
  });

  it("refuses an answer that is not an IP address", async () => {
    await expect(assertResolvesPublic("odd.example", lookupReturning("not-an-address"))).rejects.toMatchObject({
      code: "invalid_endpoint",
      status: 400,
    });
  });
});

describe("fetchPublicHttps resolves every hop", () => {
  it("refuses before the first request when the name resolves privately", async () => {
    const seen: string[] = [];
    await expect(
      fetchPublicHttps("https://innocent.example/x", {
        lookupImpl: lookupReturning("169.254.169.254"),
        fetchImpl: fakeFetch({ "https://innocent.example/x": { status: 200, body: "secret" } }, seen),
      }),
    ).rejects.toThrow(/public host/);
    expect(seen).toEqual([]);
  });

  it("refuses a redirect to a name that resolves privately, after the first hop succeeded", async () => {
    const seen: string[] = [];
    const lookupImpl: HostLookup = async (hostname) =>
      hostname === "a.test" ? [{ address: "93.184.216.34" }] : [{ address: "10.0.0.7" }];
    await expect(
      fetchPublicHttps("https://a.test/start", {
        lookupImpl,
        fetchImpl: fakeFetch(
          {
            "https://a.test/start": { status: 302, headers: { location: "https://inside.example/" } },
            "https://inside.example/": { status: 200, body: "secret" },
          },
          seen,
        ),
      }),
    ).rejects.toThrow(/public host/);
    expect(seen).toEqual(["https://a.test/start"]);
  });

  it("fails closed when the name does not resolve, before any request is made", async () => {
    const seen: string[] = [];
    const failing: HostLookup = async () => {
      throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    };
    await expect(
      fetchPublicHttps("https://flaky.example/x", {
        lookupImpl: failing,
        fetchImpl: fakeFetch({ "https://flaky.example/x": { status: 200, body: "reachable" } }, seen),
      }),
    ).rejects.toMatchObject({ code: "invalid_endpoint", status: 400, message: "Could not resolve this URL's host" });
    expect(seen).toEqual([]);
  });

  it("resolves each hop once and hands the request a dispatcher pinned to that answer", async () => {
    const resolved: string[] = [];
    const dispatchers: unknown[] = [];
    const lookupImpl: HostLookup = async (hostname) => {
      resolved.push(hostname);
      return [{ address: "93.184.216.34" }];
    };
    const plan: Record<string, Step> = {
      "https://a.test/start": { status: 302, headers: { location: "https://b.test/final" } },
      "https://b.test/final": { status: 200, body: "ok" },
    };
    const recordingFetch = (async (input: string, init?: RequestInit & { dispatcher?: unknown }) => {
      dispatchers.push(init?.dispatcher);
      const step = plan[input] as Step;
      return new Response(step.body ?? "", { status: step.status, headers: step.headers ?? {} });
    }) as unknown as typeof fetch;
    await fetchPublicHttps("https://a.test/start", { lookupImpl, fetchImpl: recordingFetch });
    expect(resolved).toEqual(["a.test", "b.test"]);
    expect(dispatchers).toHaveLength(2);
    for (const dispatcher of dispatchers) {
      expect(dispatcher).toBeDefined();
    }
    expect(dispatchers[0]).not.toBe(dispatchers[1]);
  });
});

describe("fetchPublicHttps never asks twice", () => {
  it("does not resolve a hop again after its answer was judged, so a later private answer is never seen", async () => {
    let asked = 0;
    const rebinding: HostLookup = async () => {
      asked += 1;
      return asked === 1 ? [{ address: "93.184.216.34" }] : [{ address: "169.254.169.254" }];
    };
    const result = await fetchPublicHttps("https://rebind.example/x", {
      lookupImpl: rebinding,
      fetchImpl: fakeFetch({ "https://rebind.example/x": { status: 200, body: "ok" } }, []),
    });
    expect(result.status).toBe(200);
    expect(asked).toBe(1);
  });
});

type LookupOptions = Parameters<LookupFunction>[1];

function ask(lookup: LookupFunction, hostname: string, options: LookupOptions) {
  return new Promise<{ error: unknown; address: unknown; family: number | undefined }>((resolve) => {
    lookup(hostname, options, (error, address, family) => resolve({ error, address, family }));
  });
}

describe("pinnedLookup", () => {
  const lookup = pinnedLookup("a.test", [{ address: "93.184.216.34" }, { address: "2606:2800:220:1::1" }]);

  it("hands back every vetted address when the connector asks for all of them", async () => {
    const answer = await ask(lookup, "a.test", { all: true });
    expect(answer.error).toBeNull();
    expect(answer.address).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
  });

  it("hands back the first vetted address, with its family, when the connector asks for one", async () => {
    const answer = await ask(lookup, "a.test", {});
    expect(answer).toMatchObject({ error: null, address: "93.184.216.34", family: 4 });
  });

  it("honours a family filter without leaving the vetted set", async () => {
    const answer = await ask(lookup, "a.test", { family: 6, all: true });
    expect(answer.address).toEqual([{ address: "2606:2800:220:1::1", family: 6 }]);
    const none = await ask(pinnedLookup("a.test", [{ address: "93.184.216.34" }]), "a.test", { family: 6, all: true });
    expect(none.error).toMatchObject({ code: "ENOTFOUND" });
  });

  it("answers for its own host only, whatever the case", async () => {
    expect((await ask(lookup, "A.TEST", {})).error).toBeNull();
    expect((await ask(lookup, "b.test", {})).error).toMatchObject({ code: "ENOTFOUND" });
  });
});

describe("pinnedAgent", () => {
  async function listen() {
    const hosts: string[] = [];
    const server = createServer((request, response) => {
      hosts.push(request.headers.host ?? "");
      response.end("pinned");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { port, hosts, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it("connects the socket to the pinned address for a name no resolver could answer", async () => {
    const listener = await listen();
    const agent = pinnedAgent("rebind.test", [{ address: "127.0.0.1" }]);
    try {
      const response = await defaultFetch(`http://rebind.test:${listener.port}/`, {
        dispatcher: agent,
      } as RequestInit);
      expect(await response.text()).toBe("pinned");
      expect(listener.hosts).toEqual([`rebind.test:${listener.port}`]);
    } finally {
      await agent.destroy();
      await listener.close();
    }
  });

  it("does not connect to a name it was not pinned for", async () => {
    const listener = await listen();
    const agent = pinnedAgent("rebind.test", [{ address: "127.0.0.1" }]);
    try {
      await expect(
        defaultFetch(`http://other.test:${listener.port}/`, { dispatcher: agent } as RequestInit),
      ).rejects.toThrow();
      expect(listener.hosts).toEqual([]);
    } finally {
      await agent.destroy();
      await listener.close();
    }
  });
});

describe("the default fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(undiciFetch).mockClear();
  });

  it("is undici's own fetch, from the package that builds the pinning Agent", () => {
    expect(defaultFetch).toBe(undiciFetch);
  });

  it("carries a hop through undici with the pinned Agent and never through globalThis.fetch", async () => {
    const globalFetch = vi.fn(async () => new Response("from the global fetch"));
    vi.stubGlobal("fetch", globalFetch);
    vi.mocked(undiciFetch).mockImplementationOnce(
      (async () => new Response("from undici", { status: 200 })) as unknown as typeof undiciFetch,
    );
    const result = await fetchPublicHttps("https://a.test/start", { lookupImpl: publicLookup });
    expect(result.body.toString()).toBe("from undici");
    expect(globalFetch).not.toHaveBeenCalled();
    const [url, init] = vi.mocked(undiciFetch).mock.calls[0] ?? [];
    expect(url).toBe("https://a.test/start");
    expect((init as { dispatcher?: unknown }).dispatcher).toBeInstanceOf(Agent);
  });

  it("honours the pinned Agent's lookup for a name no resolver can answer", async () => {
    const listener = createServer((_request, response) => response.end("pinned"));
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const { port } = listener.address() as AddressInfo;
    const agent = pinnedAgent("rebind.test", [{ address: "127.0.0.1" }]);
    try {
      const response = await defaultFetch(`http://rebind.test:${port}/`, { dispatcher: agent } as RequestInit);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("pinned");
    } finally {
      await agent.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});
