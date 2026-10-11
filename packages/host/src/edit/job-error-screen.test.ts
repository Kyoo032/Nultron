import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@agentforge/core";
import { seedEditProject } from "./harness";
import { subscribeProjectEvents, type EditHostEvent } from "./events";
import { enqueueEditJob, resetEditJobsForTests, setEditJobRunnerForTests } from "./jobs";
import { getEditProjectBundle } from "./projects";

/**
 * A job's error text is what the upstream provider said, and a provider can echo the key it was sent. The text is
 * stored on the job row and read back by three routes: the `job.done` event, the project bundle and the job read. It
 * is redacted once, where it is stored (`failJob`), so every one of them carries the redacted copy.
 */
const SECRET = "sk-test-123456789";

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

type JobDoneEvent = { type: "job.done"; job: { id: string; error?: string | null } };

function jobDoneEvents(events: EditHostEvent[]): JobDoneEvent[] {
  return events.filter((event): event is EditHostEvent & JobDoneEvent => event.type === "job.done") as JobDoneEvent[];
}

describe("a failed job's error text leaves the host redacted", () => {
  afterEach(() => {
    resetEditJobsForTests();
    setEditJobRunnerForTests(null);
  });

  it("redacts a key an upstream error echoed, in the job.done event and in the project bundle", async () => {
    const { tenant, project } = await seedEditProject("job-error-secret");
    const events: EditHostEvent[] = [];
    const stop = subscribeProjectEvents(project.id, (event) => events.push(event));
    setEditJobRunnerForTests(async () => {
      throw new ApiError("tool_failed", `upstream rejected key ${SECRET}`, 502);
    });

    const job = await enqueueEditJob(project.id, {
      kind: "ffmpeg_op",
      request: { recipe: "thumbnail" },
      targetClipIds: [],
    });
    await waitFor(async () => jobDoneEvents(events).some((event) => event.job.id === job.id));
    stop();

    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(jobDoneEvents(events).find((event) => event.job.id === job.id)?.job.error).toBe(
      "upstream rejected key [REDACTED]",
    );

    const bundle = await getEditProjectBundle(tenant, project.id);
    expect(JSON.stringify(bundle)).not.toContain(SECRET);
    expect(bundle.jobs.find((row) => row.id === job.id)?.error).toBe("upstream rejected key [REDACTED]");
  });

  it("keeps ordinary error text as the upstream wrote it", async () => {
    const { tenant, project } = await seedEditProject("job-error-plain");
    const events: EditHostEvent[] = [];
    const stop = subscribeProjectEvents(project.id, (event) => events.push(event));
    setEditJobRunnerForTests(async () => {
      throw new ApiError("tool_failed", "quota exceeded for this model", 429);
    });

    const job = await enqueueEditJob(project.id, {
      kind: "ffmpeg_op",
      request: { recipe: "thumbnail" },
      targetClipIds: [],
    });
    await waitFor(async () => jobDoneEvents(events).some((event) => event.job.id === job.id));
    stop();

    expect(jobDoneEvents(events).find((event) => event.job.id === job.id)?.job.error).toBe(
      "quota exceeded for this model",
    );
    const bundle = await getEditProjectBundle(tenant, project.id);
    expect(bundle.jobs.find((row) => row.id === job.id)?.error).toBe("quota exceeded for this model");
  });
});
