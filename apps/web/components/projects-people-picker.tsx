"use client";

import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { t } from "@/lib/i18n";
import type { InvitablePerson } from "@/lib/projects-client";
import {
  INITIAL_PICKER,
  keyIntent,
  matchPeople,
  pickerStep,
  type PickerEvent,
  type PickerState,
} from "@/lib/projects-picker";

type ViewProps = {
  readonly baseId: string;
  readonly people: readonly InvitablePerson[] | null;
  readonly loadFailed: boolean;
  readonly busy: boolean;
  readonly state: PickerState;
  readonly onEvent: (event: PickerEvent, count: number) => void;
  readonly onSubmit: (userId: string) => void;
};

export function PeoplePickerView({ baseId, people, loadFailed, busy, state, onEvent, onSubmit }: ViewProps) {
  if (loadFailed) {
    return (
      <p className="projects-note" role="status" data-testid="projects-picker-status">
        {t("projects.members.pickerFailed")}
      </p>
    );
  }
  if (!people) {
    return (
      <p className="projects-note" role="status" data-testid="projects-picker-status">
        {t("projects.members.pickerLoading")}
      </p>
    );
  }
  if (people.length === 0) {
    return (
      <p className="projects-note" data-testid="projects-picker-everyone">
        {t("projects.members.pickerEveryone")}
      </p>
    );
  }

  const inputId = `${baseId}-input`;
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const matches = matchPeople(people, state.query);
  const expanded = state.open && matches.length > 0;
  const query = state.query.trim();
  const send = (event: PickerEvent) => onEvent(event, matches.length);

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    const intent = keyIntent(event.key, state);
    if (!intent) {
      return;
    }
    event.preventDefault();
    if (intent.kind === "pick") {
      const person = matches[intent.index];
      if (person) {
        send({ type: "choose", person });
      }
      return;
    }
    send(intent.event);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (state.chosen) {
      onSubmit(state.chosen);
    }
  }

  return (
    <form className="projects-picker" onSubmit={submit} data-testid="projects-picker">
      <label className="projects-picker-label" htmlFor={inputId}>
        {t("projects.members.pickerLabel")}
      </label>
      <div className="projects-inline-form">
        <div className="projects-picker-field">
          <input
            id={inputId}
            className="input"
            role="combobox"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={expanded && state.active >= 0 ? optionId(state.active) : undefined}
            autoComplete="off"
            maxLength={120}
            value={state.query}
            placeholder={t("projects.members.pickerPlaceholder")}
            onChange={(event) => send({ type: "type", query: event.target.value })}
            onFocus={() => send({ type: "open" })}
            onBlur={() => send({ type: "close" })}
            onKeyDown={keyDown}
            data-testid="projects-invite-input"
          />
          {expanded ? (
            <ul
              id={listId}
              role="listbox"
              className="projects-picker-list"
              aria-label={t("projects.members.pickerLabel")}
            >
              {matches.map((person, index) => (
                <li
                  key={person.userId}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === state.active}
                  className="projects-picker-option"
                  data-user={person.userId}
                  data-testid="projects-picker-option"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    send({ type: "choose", person });
                  }}
                >
                  {person.name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={busy || !state.chosen}
          data-testid="projects-invite"
        >
          {t("projects.members.invite")}
        </button>
      </div>
      {state.open && query && matches.length === 0 ? (
        <p className="projects-note" role="status" data-testid="projects-picker-nomatch">
          {t("projects.members.pickerNoMatch", { query })}
        </p>
      ) : null}
    </form>
  );
}

type PickerProps = {
  readonly people: readonly InvitablePerson[] | null;
  readonly loadFailed: boolean;
  readonly busy: boolean;
  readonly onInvite: (userId: string) => void;
};

export function PeoplePicker({ people, loadFailed, busy, onInvite }: PickerProps) {
  const baseId = useId();
  const [state, setState] = useState<PickerState>(INITIAL_PICKER);
  return (
    <PeoplePickerView
      baseId={baseId}
      people={people}
      loadFailed={loadFailed}
      busy={busy}
      state={state}
      onEvent={(event, count) => setState((current) => pickerStep(current, event, count))}
      onSubmit={(userId) => {
        onInvite(userId);
        setState(INITIAL_PICKER);
      }}
    />
  );
}
