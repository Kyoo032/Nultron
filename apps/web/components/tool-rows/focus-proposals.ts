/**
 * The "Review" button on a folder change that is waiting for the owner. Another part of the page
 * (the folder changes panel) draws the proposals under this testid; when it is on the page the
 * button brings it into view and focuses it, and when it is not the caller tells the person where
 * to look.
 */
export const FOLDER_PROPOSALS_TESTID = "folder-proposals";

type Revealable = {
  scrollIntoView(options?: ScrollIntoViewOptions): void;
  focus(options?: FocusOptions): void;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
};

type RevealRoot = { querySelector(selector: string): Revealable | null };

/** True when the panel is on the page. The scroll is instant for a person who asked for less motion. */
export function revealFolderProposals(root: RevealRoot, reducedMotion: boolean): boolean {
  const panel = root.querySelector(`[data-testid="${FOLDER_PROPOSALS_TESTID}"]`);
  if (!panel) {
    return false;
  }
  panel.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
  // A region is not focusable until it has a tabindex; -1 lets a script focus it without adding a tab stop.
  if (!panel.hasAttribute("tabindex")) {
    panel.setAttribute("tabindex", "-1");
  }
  panel.focus({ preventScroll: true });
  return true;
}
