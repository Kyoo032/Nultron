import { describe, expect, it } from "vitest";
import { postgresSslOptions } from "./index";

describe("postgresSslOptions", () => {
  it("enforces TLSv1.2 and rejectUnauthorized: true for require, verify-ca, and verify-full", () => {
    for (const mode of ["require", "verify-ca", "verify-full"]) {
      expect(postgresSslOptions(`postgres://u:p@db.example.com:5432/portal?sslmode=${mode}`)).toEqual({
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
      });
    }
  });

  it("leaves ssl undefined when sslmode is absent or not requesting TLS", () => {
    expect(postgresSslOptions("postgres://u:p@127.0.0.1:5432/portal")).toBeUndefined();
    expect(postgresSslOptions("postgres://u:p@127.0.0.1:5432/portal?sslmode=disable")).toBeUndefined();
  });
});
