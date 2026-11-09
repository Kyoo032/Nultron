export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly suggestModel?: string;

  constructor(code: string, message: string, status: number, suggestModel?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    if (suggestModel) {
      this.suggestModel = suggestModel;
    }
  }
}

const ISSUES_SHOWN_MAX = 20;
const ISSUE_LINE_CHARS_MAX = 300;

type IssueLike = { readonly message: string; readonly path?: ReadonlyArray<PropertyKey> };

export function summarizeIssues(issues: ReadonlyArray<IssueLike>, shown: number = ISSUES_SHOWN_MAX): string {
  const lines = issues.slice(0, shown).map((issue) => {
    const where = issue.path?.map(String).join(".");
    return (where ? `${where}: ${issue.message}` : issue.message).slice(0, ISSUE_LINE_CHARS_MAX);
  });
  const hidden = issues.length - lines.length;
  return hidden > 0 ? `${lines.join("; ")} (and ${hidden} more)` : lines.join("; ");
}

export class ContentParseError extends ApiError {
  constructor(code: string, message: string) {
    super(code, message, 400);
    this.name = "ContentParseError";
  }
}
