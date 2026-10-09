"use client";

import { t } from "@/lib/i18n";
import { codeLanguageName, toolRowLabel } from "@/lib/tool-labels";
import { BudgetNote, FileChip, FileDownloadButton, RefusalNote, ROW_HEAD, RowLabel, type RowTool } from "./parts";
import { asRecord, classifyOutcome, readCodeResult, readString } from "./results";

/** A block longer than this is cut for the screen. The runner already caps what it sends. */
export const CODE_SHOWN_MAX_CHARS = 20_000;
/** Files a run saved are chips; a run that saved more than this shows the first ones. */
const FILE_CHIPS_MAX = 20;

const KNOWN_REASONS = new Set(["timeout", "memory", "syntax", "runtime", "too_large", "busy", "unavailable"]);

/** Why a run did not finish, in words. A reason this build does not know is a plain "did not finish". */
export function codeFailureText(reason: string | undefined): string {
  return t(`chat.tools.code.reason.${reason && KNOWN_REASONS.has(reason) ? reason : "other"}`);
}

type BlockProps = {
  readonly text: string;
  readonly testId: string;
  readonly heading: string;
  readonly tone: "plain" | "muted";
  readonly wrap: boolean;
};

/**
 * Text, never markup: the string is a React text child, so a `<script>` in a program's output is
 * shown as the characters it is. Long blocks scroll inside their own box.
 */
function TextBlock({ text, testId, heading, tone, wrap }: BlockProps) {
  const cut = text.length > CODE_SHOWN_MAX_CHARS;
  return (
    <div className="mt-1.5 min-w-0">
      <p className="text-[11px] text-[var(--text-3)]">{heading}</p>
      <pre
        className={`mt-0.5 max-h-48 overflow-auto rounded-lg bg-[var(--surface-2)] p-2 font-mono text-[11px] leading-relaxed ${
          tone === "muted" ? "text-[var(--text-3)]" : "text-[var(--text-2)]"
        } ${wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}
        data-testid={testId}
      >
        {cut ? text.slice(0, CODE_SHOWN_MAX_CHARS) : text}
      </pre>
      {cut ? <p className="mt-0.5 text-[11px] text-[var(--text-3)]">{t("chat.tools.code.cut")}</p> : null}
    </div>
  );
}

/**
 * run_code: what ran ("Ran Python" and a language badge), the program folded away by default, what
 * it printed, what went to stderr (muted), why it stopped if it did not finish, and the files it
 * saved to the desk as chips.
 */
export function CodeToolRow({ tool }: { tool: RowTool }) {
  const args = asRecord(tool.input);
  const outcome = classifyOutcome(tool.key, tool.status, tool.output);
  const run = tool.status === "completed" ? readCodeResult(tool.output) : null;
  const language = codeLanguageName(args?.language);
  const code = readString(args, "code");
  const label = toolRowLabel(tool.key, tool.input, tool.output, tool.status);
  const state = run && !run.ok ? "failed" : outcome.state;
  const printedNothing = run?.ok === true && run.stdout === "" && run.stderr === "" && run.filesWritten.length === 0;
  return (
    <div className="min-w-0" data-testid="tool-row-code" data-tool={tool.key} data-state={state}>
      <div className={ROW_HEAD}>
        <RowLabel text={label} />
        {language ? (
          <span
            className="inline-flex shrink-0 items-center rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-1.5 text-[11px] leading-4 text-[var(--text-2)]"
            data-testid="tool-row-code-language"
          >
            {language}
          </span>
        ) : null}
      </div>
      {run && !run.ok ? (
        <p className="mt-1 text-[var(--danger)] [overflow-wrap:anywhere]" data-testid="tool-row-code-reason">
          {codeFailureText(run.reason)}
        </p>
      ) : null}
      {outcome.state === "refused" ? <RefusalNote message={outcome.message} /> : null}
      {outcome.state === "budget" ? <BudgetNote message={outcome.message} /> : null}
      {code ? (
        <details className="mt-1.5" data-testid="tool-row-code-source">
          <summary className="w-fit cursor-pointer text-[var(--text-3)]">{t("chat.tools.code.show")}</summary>
          <TextBlock
            text={code}
            testId="tool-row-code-text"
            heading={t("chat.tools.code.heading")}
            tone="plain"
            wrap={false}
          />
        </details>
      ) : null}
      {run?.stdout ? (
        <TextBlock
          text={run.stdout}
          testId="tool-row-code-stdout"
          heading={t("chat.tools.code.stdout")}
          tone="plain"
          wrap
        />
      ) : null}
      {run?.stderr ? (
        <TextBlock
          text={run.stderr}
          testId="tool-row-code-stderr"
          heading={t("chat.tools.code.stderr")}
          tone="muted"
          wrap
        />
      ) : null}
      {printedNothing ? <p className="mt-1 text-[var(--text-3)]">{t("chat.tools.code.noOutput")}</p> : null}
      {run && run.filesWritten.length > 0 ? (
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5" data-testid="tool-row-code-files">
          <span className="text-[var(--text-3)]">{t("chat.tools.code.filesWritten")}</span>
          {run.filesWritten.slice(0, FILE_CHIPS_MAX).map((file) => (
            <span key={file.path} className="inline-flex min-w-0 max-w-full items-center gap-1">
              <FileChip path={file.path} text={file.path} />
              <FileDownloadButton path={file.path} />
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
