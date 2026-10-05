import { gatewayBlockedMessage } from "./gateway-blocked";

/**
 * Edit, on the hosted app, with no usable gateway key: the controls that would reach the model.
 *
 * The Agent pane quiets Send and shows the shared needs-key note. "Go" on a plan card, the recipe
 * buttons and the Generate tab's submit lead to the same refused call, so they get the same treatment:
 * disabled, a `title` that says why (the catalog sentence, in the desk's language: no new copy), and
 * `aria-describedby` at the note that is on screen, so a screen reader reads the reason with the button.
 *
 * `needsKey` is `useHostedNeedsKey()`, which is false everywhere but the hosted build. When it is false
 * every helper here returns `{}`, and spreading `{}` into a JSX element adds no attribute: the Personal
 * app's markup is exactly what it was before these controls knew about keys.
 */

/** The id of the Agent pane's needs-key note. Every quiet Edit control but the Generate tab's points at it. */
export const EDIT_NEEDS_KEY_NOTE_ID = "edit-agent-needs-key-note";

/** The id of the Generate tab's own note, which sits right above its submit. Hosted only. */
export const EDIT_GENERATE_NEEDS_KEY_NOTE_ID = "edit-generate-needs-key-note";

export type EditKeyGuardProps = {
  disabled?: true;
  title?: string;
  "aria-describedby"?: string;
};

export type EditKeyHintProps = Pick<EditKeyGuardProps, "aria-describedby">;

/** Props for a button that would call a model: off, explained, and tied to the note. `{}` when a key is not missing. */
export function editKeyGuard(needsKey: boolean, describedBy: string = EDIT_NEEDS_KEY_NOTE_ID): EditKeyGuardProps {
  return needsKey ? { disabled: true, title: gatewayBlockedMessage(), "aria-describedby": describedBy } : {};
}

/** Props for a field the person may still type in: described by the note, never disabled. `{}` when a key is not missing. */
export function editKeyHint(needsKey: boolean, describedBy: string = EDIT_NEEDS_KEY_NOTE_ID): EditKeyHintProps {
  return needsKey ? { "aria-describedby": describedBy } : {};
}
