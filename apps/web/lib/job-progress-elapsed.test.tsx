import { EMPTY_JOB_PROGRESS, type JobProgress } from "@agentforge/core/jobs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { JobProgressList, formatJobElapsed } from "@/components/job-progress";
import { applyLocale, resetLocaleForTests } from "./i18n";

const searching: JobProgress = {
  ...EMPTY_JOB_PROGRESS,
  phases: [{ phase: "searching", label: "Searching the web", status: "active", steps: [] }],
};

function render(busy: boolean, elapsed: boolean | undefined): string {
  return renderToStaticMarkup(
    <JobProgressList progress={searching} busy={busy} mode="research" testId="research-progress" elapsed={elapsed} />,
  );
}

afterEach(() => resetLocaleForTests());

describe("formatJobElapsed", () => {
  it("prints minutes and seconds, and adds hours once an hour has passed", () => {
    expect(formatJobElapsed(0)).toBe("0:00");
    expect(formatJobElapsed(9_000)).toBe("0:09");
    expect(formatJobElapsed(59_999)).toBe("0:59");
    expect(formatJobElapsed(102_000)).toBe("1:42");
    expect(formatJobElapsed(754_000)).toBe("12:34");
    expect(formatJobElapsed(3_723_000)).toBe("1:02:03");
  });

  it("never prints a negative or non-finite time", () => {
    expect(formatJobElapsed(-5_000)).toBe("0:00");
    expect(formatJobElapsed(Number.NaN)).toBe("0:00");
  });
});

describe("JobProgressList elapsed line", () => {
  it("shows the elapsed line while the job runs, when the caller opts in", () => {
    const markup = render(true, true);
    expect(markup).toContain('data-testid="research-progress-elapsed"');
    expect(markup).toContain("0:00 elapsed");
  });

  it("stays hidden when the job is not running, or the caller did not opt in", () => {
    expect(render(false, true)).not.toContain("research-progress-elapsed");
    expect(render(true, undefined)).not.toContain("research-progress-elapsed");
    expect(render(true, false)).not.toContain("research-progress-elapsed");
  });

  it("uses the Indonesian catalog on an id desk", () => {
    applyLocale("id");
    expect(render(true, true)).toContain("0:00 berjalan");
  });
});
