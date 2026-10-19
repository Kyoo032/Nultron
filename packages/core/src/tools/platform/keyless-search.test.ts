import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KEYLESS_ARXIV_GAP_MS,
  KEYLESS_ORIGINS,
  KEYLESS_USER_AGENT,
  resetKeylessSearchState,
  searchKeyless,
} from "./keyless-search";

type MockResponse = {
  status: number;
  body: string;
  location?: string;
};

function responseFor(spec: MockResponse): Response {
  return {
    status: spec.status,
    headers: { get: (name: string) => (name.toLowerCase() === "location" ? (spec.location ?? null) : null) },
    text: async () => spec.body,
  } as unknown as Response;
}

const wikiPage = {
  pages: [
    {
      key: "Photosynthesis",
      title: "Photosynthesis",
      excerpt: 'Plants <span class="searchmatch">make</span> sugar.',
      description: "Biological process",
    },
    { key: "Chlorophyll", title: "Chlorophyll", excerpt: "Green pigment in leaves", description: "" },
    { key: "Leaf", title: "Leaf", excerpt: "Plant organ", description: "" },
  ],
};

const openAlexWork = {
  results: [
    {
      display_name: "A paper on leaves",
      doi: "https://doi.org/10.1000/leaf",
      id: "https://openalex.org/W1",
      publication_year: 2024,
      primary_location: { landing_page_url: "http://insecure.example/leaf" },
      abstract_inverted_index: { Leaves: [0], matter: [1] },
    },
  ],
};

const arxivFeed = `<feed><entry><id>http://arxiv.org/abs/2401.00001v1</id><title>Preprint  title</title><summary>An abstract.</summary></entry></feed>`;

function route(url: string): MockResponse {
  if (url.startsWith(`${KEYLESS_ORIGINS.wikipediaEn}/`) || url.startsWith(`${KEYLESS_ORIGINS.wikipediaId}/`)) {
    return { status: 200, body: JSON.stringify(wikiPage) };
  }
  if (url.startsWith(`${KEYLESS_ORIGINS.openAlex}/`)) {
    return { status: 200, body: JSON.stringify(openAlexWork) };
  }
  if (url.startsWith(`${KEYLESS_ORIGINS.arxiv}/`)) {
    return { status: 200, body: arxivFeed };
  }
  if (url.startsWith(`${KEYLESS_ORIGINS.crossref}/`)) {
    return {
      status: 200,
      body: JSON.stringify({
        message: {
          items: [
            { title: ["DOI paper"], URL: "https://doi.org/10.1000/cross", abstract: "<jats:p>Cross abstract</jats:p>" },
          ],
        },
      }),
    };
  }
  return { status: 500, body: "" };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function mockFetch(handle: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => handle(requestUrl(input), init));
}

function calledOrigin(fetchMock: { mock: { calls: unknown[][] } }, origin: string): boolean {
  return fetchMock.mock.calls.some((call) => String(call[0]).startsWith(origin));
}

describe("searchKeyless", () => {
  afterEach(() => {
    resetKeylessSearchState();
    vi.unstubAllGlobals();
  });

  it("merges Wikipedia and OpenAlex, drops non-HTTPS landing pages, and strips excerpt HTML", async () => {
    const seen: string[] = [];
    const fetchMock = mockFetch(async (url, init) => {
      seen.push(url);
      const headers = init?.headers as Record<string, string> | undefined;
      expect(init?.redirect).toBe("manual");
      expect(headers?.["User-Agent"]).toBe(KEYLESS_USER_AGENT);
      expect(headers?.Authorization).toBeUndefined();
      return responseFor(route(url));
    });
    const result = await searchKeyless("how plants green leaves make sugar", {
      fetchImpl: fetchMock,
      locale: "en",
      now: () => 1_000,
    });
    expect(result.outage).toBe(false);
    expect(result.hits.map((hit) => hit.url)).toEqual([
      "https://en.wikipedia.org/wiki/Photosynthesis",
      "https://en.wikipedia.org/wiki/Chlorophyll",
      "https://en.wikipedia.org/wiki/Leaf",
      "https://doi.org/10.1000/leaf",
    ]);
    expect(result.hits[0]?.description).toBe("Plants make sugar.");
    expect(result.hits[3]?.description).toBe("Leaves matter");
    expect(result.hits.map((hit) => hit.position)).toEqual([1, 2, 3, 4]);
    expect(seen.some((url) => url.startsWith(KEYLESS_ORIGINS.arxiv))).toBe(false);
    expect(seen.some((url) => url.startsWith(KEYLESS_ORIGINS.crossref))).toBe(false);
  });

  it("uses the Indonesian Wikipedia host for an id desk", async () => {
    const fetchMock = mockFetch(async (url) => responseFor(route(url)));
    await searchKeyless("fotosintesis", { fetchImpl: fetchMock, locale: "id", now: () => 1_000 });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).startsWith(KEYLESS_ORIGINS.wikipediaId))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).startsWith(KEYLESS_ORIGINS.wikipediaEn))).toBe(false);
  });

  it("does not follow a redirect off the pinned origin", async () => {
    const fetchMock = mockFetch(async (url) => {
      if (url.startsWith(KEYLESS_ORIGINS.wikipediaEn)) {
        return responseFor({ status: 302, body: "", location: "https://evil.example/steal" });
      }
      return responseFor(route(url));
    });
    const result = await searchKeyless("leaves", { fetchImpl: fetchMock, locale: "en", now: () => 1_000 });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("evil.example"))).toBe(false);
    expect(result.hits.map((hit) => hit.url)).toEqual(["https://doi.org/10.1000/leaf"]);
  });

  it("follows a same-origin redirect and then reads the body", async () => {
    const fetchMock = mockFetch(async (url) => {
      if (url.includes("/search/page") && !url.includes("redirected=1")) {
        return responseFor({
          status: 302,
          body: "",
          location: `${KEYLESS_ORIGINS.wikipediaEn}/w/rest.php/v1/search/page?q=plants&limit=5&redirected=1`,
        });
      }
      return responseFor(route(url));
    });
    const result = await searchKeyless("plants", { fetchImpl: fetchMock, locale: "en", now: () => 1_000 });
    expect(result.hits[0]?.url).toBe("https://en.wikipedia.org/wiki/Photosynthesis");
  });

  it("does not ask arXiv or Crossref for an ordinary question, even when the encyclopedia pair is empty", async () => {
    const fetchMock = mockFetch(async (url) => {
      if (url.startsWith(KEYLESS_ORIGINS.wikipediaEn) || url.startsWith(KEYLESS_ORIGINS.openAlex)) {
        return responseFor({ status: 200, body: url.includes("openalex") ? '{"results":[]}' : '{"pages":[]}' });
      }
      return responseFor(route(url));
    });
    const result = await searchKeyless("obscure topic", { fetchImpl: fetchMock, locale: "en", now: () => 5_000 });
    expect(result).toMatchObject({ hits: [], outage: false });
    expect(calledOrigin(fetchMock, KEYLESS_ORIGINS.arxiv)).toBe(false);
    expect(calledOrigin(fetchMock, KEYLESS_ORIGINS.crossref)).toBe(false);
  });

  it("asks arXiv and Crossref for a scholarly question and keeps only the hits that share a word with it", async () => {
    const fetchMock = mockFetch(async (url) => {
      if (url.startsWith(KEYLESS_ORIGINS.arxiv)) {
        return responseFor({
          status: 200,
          body: `<feed><entry><id>http://arxiv.org/abs/2401.00001v1</id><title>Lithium battery recycling study</title><summary>Recovery yields.</summary></entry><entry><id>http://arxiv.org/abs/2401.00002v1</id><title>Faà di Bruno formula for higher derivatives</title><summary>A combinatorial identity.</summary></entry></feed>`,
        });
      }
      return responseFor(route(url));
    });
    const result = await searchKeyless("lithium battery study", {
      fetchImpl: fetchMock,
      locale: "en",
      now: () => 5_000,
    });
    expect(result.hits.map((hit) => hit.url)).toEqual(["https://arxiv.org/abs/2401.00001v1"]);
    expect(calledOrigin(fetchMock, KEYLESS_ORIGINS.arxiv)).toBe(true);
    expect(calledOrigin(fetchMock, KEYLESS_ORIGINS.crossref)).toBe(true);
  });

  it("drops an off-topic hit for an Indonesian solar question and never asks the scholarly sources", async () => {
    const question = "Apa manfaat utama energi surya untuk rumah tangga di Indonesia? Jawab ringkas.";
    const fetchMock = mockFetch(async (url) => {
      if (url.startsWith(KEYLESS_ORIGINS.wikipediaId)) {
        return responseFor({
          status: 200,
          body: JSON.stringify({
            pages: [
              {
                key: "Energi_surya",
                title: "Energi surya",
                excerpt: "Energi <span>surya</span> adalah energi dari radiasi matahari.",
                description: "",
              },
            ],
          }),
        });
      }
      if (url.startsWith(KEYLESS_ORIGINS.openAlex)) {
        return responseFor({
          status: 200,
          body: JSON.stringify({
            results: [
              {
                display_name: "The Faà di Bruno formula for higher derivatives",
                doi: "https://doi.org/10.1000/faa",
                id: "https://openalex.org/W9",
                publication_year: 1857,
                primary_location: { landing_page_url: "https://example.org/faa" },
                abstract_inverted_index: { Derivatives: [0], of: [1], composite: [2], functions: [3] },
              },
            ],
          }),
        });
      }
      return responseFor({
        status: 200,
        body: `<feed><entry><id>http://arxiv.org/abs/2401.00004v1</id><title>Faà di Bruno formula for higher derivatives</title><summary>Composite functions.</summary></entry></feed>`,
      });
    });
    const result = await searchKeyless(question, { fetchImpl: fetchMock, locale: "id", now: () => 1_000 });
    expect(result.hits.map((hit) => hit.url)).toEqual(["https://id.wikipedia.org/wiki/Energi_surya"]);
    expect(calledOrigin(fetchMock, KEYLESS_ORIGINS.arxiv)).toBe(false);
    expect(calledOrigin(fetchMock, KEYLESS_ORIGINS.crossref)).toBe(false);
  });

  it("keeps every hit when the query has no word that can be matched", async () => {
    const fetchMock = mockFetch(async (url) => responseFor(route(url)));
    const result = await searchKeyless("apa itu", { fetchImpl: fetchMock, locale: "id", now: () => 1_000 });
    expect(result.hits.map((hit) => hit.title)).toEqual(["Photosynthesis", "Chlorophyll", "Leaf", "A paper on leaves"]);
  });

  it("spaces a second arXiv request by three seconds", async () => {
    const fetchMock = mockFetch(async (url) => {
      if (url.startsWith(KEYLESS_ORIGINS.arxiv)) {
        return responseFor(route(url));
      }
      return responseFor({ status: 503, body: "" });
    });
    const sleeps: number[] = [];
    const options = {
      fetchImpl: fetchMock,
      locale: "en" as const,
      now: () => 20_000,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    };
    await searchKeyless("first paper study", options);
    await searchKeyless("second paper study", options);
    expect(sleeps).toEqual([KEYLESS_ARXIV_GAP_MS]);
  });

  it("asks arXiv and Crossref when the query is scholarly, even when Wikipedia is full", async () => {
    const fetchMock = mockFetch(async (url) => responseFor(route(url)));
    const result = await searchKeyless("battery preprint study", {
      fetchImpl: fetchMock,
      locale: "en",
      now: () => 1_000,
    });
    expect(result.hits.map((hit) => hit.url)).toEqual(["https://arxiv.org/abs/2401.00001v1"]);
    expect(calledOrigin(fetchMock, KEYLESS_ORIGINS.crossref)).toBe(true);
  });

  it("caches a completed search and skips the network", async () => {
    const fetchMock = mockFetch(async (url) => responseFor(route(url)));
    const options = { fetchImpl: fetchMock, locale: "en" as const, now: () => 1_000 };
    await searchKeyless("plants", options);
    const calls = fetchMock.mock.calls.length;
    const again = await searchKeyless("  Plants  ", options);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(again.hits[0]?.title).toBe("Photosynthesis");
  });

  it("reports an outage when every source fails, and does not cache it", async () => {
    const fetchMock = vi.fn(async () => responseFor({ status: 503, body: "" }));
    const options = {
      fetchImpl: fetchMock,
      locale: "en" as const,
      now: () => 1_000,
      sleep: async () => {},
    };
    const failed = await searchKeyless("plants", options);
    expect(failed).toMatchObject({ outage: true, hits: [] });
    const calls = fetchMock.mock.calls.length;
    await searchKeyless("plants", options);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it("masks an email before the query leaves", async () => {
    const fetchMock = mockFetch(async (url) => responseFor(route(url)));
    await searchKeyless("notes for ada@example.com", { fetchImpl: fetchMock, locale: "en", now: () => 1_000 });
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("ada@example.com");
    }
  });
});
