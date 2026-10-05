/**
 * The prompt row of a job desk: Enhance, the prompt, and Generate.
 *
 * The row answers to its own width, not the window's. The desk pane is the window minus the rail, so a
 * phone, a narrow desktop window and an open rail all leave a pane too tight for three controls on one
 * line, and a viewport breakpoint cannot tell those apart. `PROMPT_ROW` makes the row a size container;
 * once its content is 40rem or less the submit controls (`PROMPT_SUBMIT`, `PROMPT_ACTIONS`) take a line of
 * their own, so the prompt keeps the first line instead of shrinking to a sliver; at 26rem or less Enhance
 * also gives up its word (the button keeps its icon, its title and its accessible name, as in the Chat
 * composer). Wider than that the row is the one line it always was.
 *
 * The classes are written out whole, not built from a shared fragment: Tailwind reads class names as
 * text and does not see a template string's parts.
 */

/** The row itself: wraps, and is the container the narrow rules below are measured against. */
export const PROMPT_ROW =
  "flex flex-wrap gap-2 [container-type:inline-size] [@container(max-width:26rem)]:[&_.enhance-btn-label]:sr-only";

/** The prompt field: takes whatever the row leaves, and may shrink below its placeholder. */
export const PROMPT_INPUT = "text-field min-w-0 flex-1 outline-none placeholder:text-[var(--text-3)]";

/** A lone submit button: shares the row when it is wide, takes the next line when it is narrow. */
export const PROMPT_SUBMIT = "[@container(max-width:40rem)]:basis-full";

/** Cancel and submit together: one group that takes the next line, each button half of it. */
export const PROMPT_ACTIONS =
  "flex shrink-0 gap-2 [@container(max-width:40rem)]:basis-full [@container(max-width:40rem)]:[&>*]:flex-1";
