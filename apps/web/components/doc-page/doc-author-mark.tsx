import type { DocAuthor } from "@/lib/docs-client";
import { authorLine, initialsOf, type DocPeople } from "./doc-format";

type Props = {
  readonly author: DocAuthor;
  readonly people: DocPeople;
};

export function AuthorMark({ author, people }: Props) {
  const line = authorLine(people, author);
  return (
    <span className="doc-mark" data-testid="docpage-mark" data-author={author.kind}>
      <span className="doc-mark-dot" role="img" aria-label={line.title} title={line.title}>
        {initialsOf(line.who)}
      </span>
      {line.caption ? <span className="doc-mark-caption">{line.caption}</span> : null}
    </span>
  );
}
