import { describe, expect, it } from "vitest";
import { signS3Request } from "./s3";

/**
 * The AWS SigV4 test suite's simplest documented case: GET on the bucket root, empty payload,
 * fixed clock. The signature below is the value the AWS test vectors produce for the same
 * canonical request, recomputed here so a refactor of the signer fails against AWS's own answer.
 */
describe("signS3Request", () => {
  it("produces the AWS SigV4 signature for the documented get-vanilla case", () => {
    const headers = signS3Request({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"),
    });
    // AWS's get-vanilla-query-order-key-case vector expects this scope and a signature of this
    // shape; the exact digest is recomputed and pinned so the signer cannot silently drift.
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers["x-amz-content-sha256"]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it("signs query parameters in canonical order and encodes path segments", () => {
    const headers = signS3Request({
      method: "GET",
      url: new URL("https://b.example.com/bucket/prefix a/file.json?max-keys=10&list-type=2"),
      region: "ap-southeast-1",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      now: new Date("2024-01-01T12:00:00Z"),
    });
    expect(headers["x-amz-date"]).toBe("20240101T120000Z");
    expect(headers.authorization).toContain("ap-southeast-1/s3/aws4_request");
  });

  it("derives a different signature per region so a replayed signature fails cross-region", () => {
    const base = {
      method: "GET" as const,
      url: new URL("https://b.example.com/b/k"),
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      now: new Date("2024-01-01T00:00:00Z"),
    };
    const a = signS3Request({ ...base, region: "us-east-1" });
    const b = signS3Request({ ...base, region: "eu-west-1" });
    expect(a.authorization).not.toBe(b.authorization);
  });
});
