import { describe, expect, it } from "vitest";
import { db, editJobs } from "@agentforge/db";
import { seedEditProject } from "./harness";
import { getEditJob } from "./jobs";
import { getEditProjectBundle, mapJob } from "./projects";

const SECRET = "sk-test-123456789";
const OPAQUE_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

async function storeJobRow(projectId: string, error: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(editJobs).values({
    id,
    projectId,
    kind: "ffmpeg_op",
    status: "failed",
    targetClipIdsJson: [],
    requestJson: {},
    progress: 0,
    error,
  });
  return id;
}

describe("a job row stored before the error text was redacted on write", () => {
  it("comes back from the project bundle with the key masked", async () => {
    const { tenant, project } = await seedEditProject("legacy-bundle");
    const jobId = await storeJobRow(project.id, `upstream rejected key ${SECRET}`);

    const bundle = await getEditProjectBundle(tenant, project.id);

    expect(JSON.stringify(bundle)).not.toContain(SECRET);
    expect(bundle.jobs.find((row) => row.id === jobId)?.error).toBe("upstream rejected key [REDACTED]");
  });

  it("comes back from a job read with the key masked", async () => {
    const { project } = await seedEditProject("legacy-read");
    const jobId = await storeJobRow(project.id, `Authorization: Bearer ${SECRET}-and-more`);

    const job = mapJob(await getEditJob(jobId, project.id));

    expect(job.error).toBe("Authorization: Bearer [REDACTED]");
  });

  it("masks what the write-time rule masks, an opaque key included", async () => {
    const { project } = await seedEditProject("legacy-opaque");
    const jobId = await storeJobRow(project.id, `bad credentials ${OPAQUE_KEY} for the account`);

    const job = mapJob(await getEditJob(jobId, project.id));

    expect(job.error).toBe("bad credentials [REDACTED] for the account");
  });

  it("leaves a null error, ordinary text and an error already masked on write as they are", async () => {
    const { project } = await seedEditProject("legacy-plain");
    const noneId = await storeJobRow(project.id, null);
    const plainId = await storeJobRow(project.id, "quota exceeded for this model");
    const maskedId = await storeJobRow(project.id, "upstream rejected key [REDACTED]");

    expect(mapJob(await getEditJob(noneId, project.id)).error).toBeNull();
    expect(mapJob(await getEditJob(plainId, project.id)).error).toBe("quota exceeded for this model");
    expect(mapJob(await getEditJob(maskedId, project.id)).error).toBe("upstream rejected key [REDACTED]");
  });
});
