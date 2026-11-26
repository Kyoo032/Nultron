/**
 * F1: POST …/test — prove creds+reachability before a source may be saved (`source_test_failed`,
 * `source_auth_failed`; never an echo of the credential).
 *
 * The row must already exist sealed: "test connection" runs against the stored row, so the
 * handler creates-or-uses the saved source and this runs the cheapest live call each kind owns.
 */
import { ApiError } from "@agentforge/core";
import type { DataSourceRow } from "./store";
import { headS3Bucket } from "./s3";
import { testPostgres } from "./postgres";
import { testMysql } from "./mysql";

export async function testDataSourceConnection(row: DataSourceRow): Promise<void> {
  switch (row.kind) {
    case "s3":
      return headS3Bucket(row);
    case "postgres":
      return testPostgres(row);
    case "mysql":
      return testMysql(row);
    case "azure_blob":
      throw new ApiError("driver_missing", "Azure Blob is the W3 part of this work", 501);
  }
}
