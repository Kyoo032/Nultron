import { presentationCheckLine, type PresentationCheckNote } from "@/lib/presentation-checks";
import { t } from "@/lib/i18n";

/**
 * What the host's checks still found in a fresh outline after its repair round: a short note above
 * the slides, never an error. Shown until the person edits, rewrites or opens another deck.
 */
export function PresentationChecksNote({ notes }: { notes: PresentationCheckNote[] }) {
  if (notes.length === 0) {
    return null;
  }
  return (
    <div
      className="mb-3 rounded-lg border border-[var(--line)] px-4 py-3 text-sm text-[var(--text-2)]"
      role="status"
      data-testid="presentations-checks"
    >
      <p className="font-medium text-[var(--text)]">{t("presentation.checks.intro")}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {notes.map((note) => (
          <li key={`${note.check}:${note.slides.join(",")}`} data-testid={`presentations-checks-${note.check}`}>
            {presentationCheckLine(note)}
          </li>
        ))}
      </ul>
    </div>
  );
}
