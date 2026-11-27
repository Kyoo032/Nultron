import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi";
import { publicRouteRegistrations } from "./routes";

describe("OpenAPI document (F5a)", () => {
  it("is a parseable OpenAPI 3.1 document covering every public route", () => {
    const doc = openApiDocument();
    expect(doc.openapi).toBe("3.1.0");
    const json = JSON.parse(JSON.stringify(doc));
    expect(json.openapi).toBe("3.1.0");
    for (const route of publicRouteRegistrations()) {
      const templated = route.path.replace(/:([A-Za-z]+)/g, "{$1}");
      const entry = json.paths[templated];
      expect(entry, `${route.method} ${templated} missing from OpenAPI`).toBeTruthy();
      expect(entry[route.method.toLowerCase()], `${route.method} ${templated} missing the method entry`).toBeTruthy();
    }
  });

  it("emits JSON Schema request bodies from zod", () => {
    const doc = openApiDocument() as {
      paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: unknown }> } }>>;
    };
    const messages = doc.paths["/api/public/v1/agents/{agentId}/messages"].post;
    expect(messages.requestBody?.content["application/json"].schema).toBeTruthy();
    const chat = doc.paths["/v1/chat/completions"].post;
    expect(chat.requestBody?.content["application/json"].schema).toBeTruthy();
  });
});
