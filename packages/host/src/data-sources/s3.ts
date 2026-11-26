/**
 * F1: the S3-compatible connector, own SigV4 signing (no AWS SDK dependency — DFIND-173, S5).
 *
 * Follows `tenant-storage-cos.ts`: `node:crypto` for the signature and `fetchPublicHttps` for the
 * egress, so every request rides the pinned-lookup SSRF wall — and on top of it the F1
 * destination allowlist: `endpoint:443` must be an operator entry, with `allow_private` honoured
 * for an internal MinIO. Only the three read verbs exist here — ListObjectsV2, GetObject and
 * HeadObject — because read-only is a property of the surface, not of a flag.
 */
import { createHash, createHmac } from "node:crypto";
import { assertAllowedDestination, fetchPublicHttps, type DestinationRule } from "@agentforge/core";
import { ApiError } from "@agentforge/core";
import type { DataSourceRow } from "./store";
import { openSourceConfig, openSourceSecret } from "./store";
import { dataSourceLimits } from "./sql-guard";

export type S3Config = { kind: "s3"; endpoint: string; region: string; bucket: string; prefix?: string };
export type S3Secret = { s3AccessKeyId: string; s3SecretAccessKey: string };

export function s3Config(row: DataSourceRow): S3Config {
  return openSourceConfig<S3Config>(row);
}
function s3Secret(row: DataSourceRow): S3Secret {
  return openSourceSecret<S3Secret>(row);
}

/** The endpoint's host:port, after the allowlist says it may be reached at all. */
export function s3Destination(config: S3Config): { url: URL; host: string; port: number; rule: DestinationRule } {
  const url = new URL(config.endpoint);
  if (url.protocol !== "https:") {
    throw new ApiError("invalid_endpoint", "S3 endpoint must use HTTPS", 400);
  }
  const port = url.port ? Number(url.port) : 443;
  const rule = assertAllowedDestination(url.hostname, port);
  return { url, host: url.hostname, port, rule };
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}
function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
function encodePath(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * SigV4 for a path-style request (`endpoint/bucket/key`) with payload hash
 * `UNSIGNED-PAYLOAD` for GETs — the documented mode for HTTPS transport.
 * Exported so `s3.test.ts` checks the signature against the AWS test vectors.
 */
export function signS3Request(input: {
  method: "GET" | "HEAD";
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date;
}): Record<string, string> {
  const now = input.now ?? new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  // Canonical request: path already encoded segment-by-segment; query params sorted by encoded name.
  const canonicalUri = input.url.pathname === "" ? "/" : input.url.pathname;
  const pairs = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encodePath(k), encodePath(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  const headers: Record<string, string> = {
    host: input.url.host,
    "x-amz-content-sha256": EMPTY_SHA256,
    "x-amz-date": amzDate,
  };
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((k) => `${k}:${headers[k]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedNames.join(";"),
    EMPTY_SHA256,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`,
  };
}

async function s3Fetch(
  row: DataSourceRow,
  input: { method: "GET" | "HEAD"; path: string; query?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  const config = s3Config(row);
  const secret = s3Secret(row);
  const { url: base, rule } = s3Destination(config);
  const url = new URL(`${base.origin}${input.path}`);
  for (const [k, v] of Object.entries(input.query ?? {})) {
    url.searchParams.set(k, v);
  }
  const headers = signS3Request({
    method: input.method,
    url,
    region: config.region,
    accessKeyId: secret.s3AccessKeyId,
    secretAccessKey: secret.s3SecretAccessKey,
  });
  const result = await fetchPublicHttps(url.toString(), {
    headers,
    maxBytes: dataSourceLimits().syncMaxBytes,
    allowPrivate: rule.allowPrivate,
    // The URL is operator config, not model text.
    urlSource: "host",
    // S3's own XML is the response body; cap it the same way the file cap does.
    maxHops: 0,
  });
  return { status: result.status, body: result.body.toString("utf8") };
}

function bucketPath(config: S3Config, key = ""): string {
  return `/${encodePath(config.bucket)}${key ? `/${key.split("/").map(encodePath).join("/")}` : ""}`;
}

export type S3Object = { key: string; size: number };

const TAG = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g");

/** ListObjectsV2, paginating with ContinuationToken until `maxKeys` or the listing ends. */
export async function listS3Objects(row: DataSourceRow, maxKeys = 1000): Promise<S3Object[]> {
  const config = s3Config(row);
  const out: S3Object[] = [];
  let token: string | undefined;
  for (;;) {
    const query: Record<string, string> = { "list-type": "2", "max-keys": "1000" };
    if (config.prefix) {
      query.prefix = config.prefix;
    }
    if (token) {
      query["continuation-token"] = token;
    }
    const { status, body } = await s3Fetch(row, { method: "GET", path: bucketPath(config) + "/", query });
    if (status !== 200) {
      throw new ApiError("source_test_failed", `S3 list failed with status ${status}`, 502);
    }
    const keys = [...body.matchAll(TAG("Key"))].map((m) => m[1]!);
    const sizes = [...body.matchAll(TAG("Size"))].map((m) => Number(m[1]));
    for (const [i, key] of keys.entries()) {
      out.push({ key, size: sizes[i] ?? 0 });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(body);
    token = body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
    if (!truncated || !token || out.length >= maxKeys) {
      break;
    }
  }
  return out.slice(0, maxKeys);
}

export async function getS3Object(row: DataSourceRow, key: string): Promise<Buffer> {
  const config = s3Config(row);
  const { status, body } = await s3Fetch(row, { method: "GET", path: bucketPath(config, key) });
  if (status !== 200) {
    throw new ApiError("source_sync_failed", `S3 get failed with status ${status}`, 502);
  }
  return Buffer.from(body, "utf8");
}

/**
 * Test-connection: `fetchPublicHttps` is GET-only, so the cheapest creds+reachability proof is a
 * ListObjectsV2 call with `max-keys=0` — no object bytes cross the wire.
 */
export async function headS3Bucket(row: DataSourceRow): Promise<void> {
  const config = s3Config(row);
  const { status } = await s3Fetch(row, {
    method: "GET",
    path: bucketPath(config) + "/",
    query: { "list-type": "2", "max-keys": "0" },
  });
  if (status === 401 || status === 403) {
    // The refusal names a code class, never the credential.
    throw new ApiError("source_auth_failed", "S3 credentials were refused", 400);
  }
  if (status !== 200) {
    throw new ApiError("source_test_failed", `S3 list failed with status ${status}`, 502);
  }
}
