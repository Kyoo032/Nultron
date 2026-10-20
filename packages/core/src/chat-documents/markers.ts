/**
 * The bracketed notes the host writes above an attached document, and how to recognise them.
 *
 * They are the host's own words about the file (what it is, where its text is saved, how much was
 * cut, that its content is data), written outside the `--- name ---` block so a document cannot
 * forge one from inside. The prefixes live here so the host that writes them, the egress guard that
 * must not read them as the person's words, and the renderer that tucks them into the file card all
 * agree on what a note looks like.
 */
export const HOST_NOTE_PREFIXES = [
  "[Attached file",
  "[Document:",
  "[Saved on this desk",
  "[Not saved on this desk",
  "[Cut:",
  "[Original file",
  "[Figures kept",
] as const;

/** True for a line the host wrote, as opposed to one a person or a document wrote. */
export function isHostNoteLine(line: string): boolean {
  return HOST_NOTE_PREFIXES.some((prefix) => line.startsWith(prefix)) && line.trimEnd().endsWith("]");
}
