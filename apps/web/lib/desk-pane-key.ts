/**
 * The key `WorkModeKeepAlive` mounts the work-mode panes under.
 *
 * A pane belongs to a desk: what it lists is that desk's, so moving from one desk to another starts
 * every pane over (and ends, for instance, a live Meeting recording, which `stashRescuedClip` rescues).
 * But the shell has no desk id for the first round trip of a cold load, and the id arriving is not a
 * move: the host already served the panes' first reads for the desk it was on, and it is that same
 * desk that gets named. Keying on `id ?? "boot"` remounted every pane that had just mounted, which
 * re-ran each first read and made Chat's key status flip invisible, connected, invisible, connected.
 *
 * Pure on purpose: the component keeps the state, this file owns the rule, and
 * `lib/desk-pane-key.test.ts` pins it.
 */
export type DeskKey = {
  /** The React key for the panes. `boot` until the desk changes to another one. */
  readonly key: string;
  /** The last real desk id seen, or null on a cold load that has not been answered yet. */
  readonly id: string | null;
};

export const BOOT_DESK_KEY: DeskKey = Object.freeze({ key: "boot", id: null });

/**
 * The key after the shell reports `id`.
 *
 * - No id (the read has not answered, or a refusal): nothing moves.
 * - The first id: adopted, and the key stays, so the panes that mounted for it are kept.
 * - The same id: the very same object back, so the component sets no state.
 * - A different real id: a new key, which remounts the panes for the new desk.
 */
export function nextDeskKey(current: DeskKey, id: string | null): DeskKey {
  if (id === null || id === current.id) {
    return current;
  }
  if (current.id === null) {
    return { key: current.key, id };
  }
  return { key: id, id };
}
