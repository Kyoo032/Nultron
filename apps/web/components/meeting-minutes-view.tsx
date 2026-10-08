"use client";

import { useState } from "react";
import type { MeetingMinutes, MinutesItemEdit } from "@agentforge/core/meeting";
import { NEEDS_OWNER } from "@agentforge/core/meeting";
import { ActionEditor, DecisionEditor } from "@/components/meeting-item-editor";
import { MeetingEditButton, MeetingItemMarks } from "@/components/meeting-item-parts";
import { t } from "@/lib/i18n";

/**
 * What lets the owner change an item of these minutes. Absent on a view that is read-only, such as the
 * translation, which is rebuilt from the minutes and not edited in place.
 */
export type MinutesEditing = {
  /** A job is running: nothing is edited under it. */
  readonly disabled: boolean;
  /** An earlier translation exists; saving an edit clears it, and the form says so. */
  readonly clearsTranslation: boolean;
  /** Save one edit. Answers the host's refusal sentence, or null when it took it. */
  readonly onSave: (edit: MinutesItemEdit) => Promise<string | null>;
};

type Props = {
  minutes: MeetingMinutes;
  testId: string;
  editing?: MinutesEditing;
};

type Target = { readonly kind: "decision" | "action"; readonly index: number } | null;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="text-sm font-medium tracking-[var(--track)] text-[var(--text)]">{title}</h3>
      <div className="mt-2 text-sm text-[var(--text-2)]">{children}</div>
    </section>
  );
}

export function MeetingMinutesView({ minutes, testId, editing }: Props) {
  const [target, setTarget] = useState<Target>(null);
  const locked = editing ? editing.disabled || target !== null : true;
  const close = () => setTarget(null);
  const is = (kind: "decision" | "action", index: number) => target?.kind === kind && target.index === index;

  return (
    <article className="rounded-lg border border-[var(--line)] px-5 py-4" data-testid={testId}>
      <h2 className="text-lg font-medium text-[var(--text)]">{minutes.title}</h2>
      {minutes.heldOn ? <p className="mt-1 text-xs text-[var(--text-2)]">{minutes.heldOn}</p> : null}
      <p className="mt-3 text-sm text-[var(--text-2)]">{minutes.summary}</p>

      {minutes.attendees.length > 0 ? (
        <Section title={t("meeting.minutes.attendees")}>
          <ul className="space-y-1" data-testid={`${testId}-attendees`}>
            {minutes.attendees.map((attendee) => (
              <li key={attendee.name}>
                {attendee.name}
                {attendee.role ? <span className="text-[var(--text-3)]"> — {attendee.role}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {minutes.decisions.length > 0 ? (
        <Section title={t("meeting.minutes.decisions")}>
          <ul className="space-y-3" data-testid={`${testId}-decisions`}>
            {minutes.decisions.map((decision, index) => (
              <li
                // Two decisions may read the same, so the position is the key, which is also what an edit names.
                // biome-ignore lint/suspicious/noArrayIndexKey: an edit addresses an item by its position.
                key={index}
                data-testid="meeting-decision-item"
                data-edited={decision.edited ? "true" : undefined}
              >
                {editing && is("decision", index) ? (
                  <DecisionEditor
                    index={index}
                    item={decision}
                    onSave={editing.onSave}
                    onClose={close}
                    clearsTranslation={editing.clearsTranslation}
                  />
                ) : (
                  <>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        {decision.statement}
                        {decision.provisional ? (
                          <span className="ml-2 text-xs text-[var(--text-3)]">{t("meeting.minutes.provisional")}</span>
                        ) : null}
                        {decision.context ? <div className="text-[var(--text-3)]">{decision.context}</div> : null}
                      </div>
                      {editing ? (
                        <MeetingEditButton disabled={locked} onClick={() => setTarget({ kind: "decision", index })} />
                      ) : null}
                    </div>
                    <MeetingItemMarks quote={decision.quote} evidence={decision.evidence} edited={decision.edited} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {minutes.actionItems.length > 0 ? (
        <Section title={t("meeting.minutes.actions")}>
          <table className="w-full text-left" data-testid={`${testId}-actions`}>
            <thead className="text-xs text-[var(--text-3)]">
              <tr>
                <th className="py-1 pr-3 font-normal">{t("meeting.minutes.action")}</th>
                <th className="py-1 pr-3 font-normal">{t("meeting.minutes.owner")}</th>
                <th className="py-1 font-normal">{t("meeting.minutes.due")}</th>
                {editing ? (
                  <th className="w-8 py-1">
                    <span className="sr-only">{t("meeting.edit.edit")}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {minutes.actionItems.map((item, index) =>
                editing && is("action", index) ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: an edit addresses an item by its position.
                  <tr key={index} data-testid="meeting-action-item">
                    <td colSpan={4} className="py-2">
                      <ActionEditor
                        index={index}
                        item={item}
                        onSave={editing.onSave}
                        onClose={close}
                        clearsTranslation={editing.clearsTranslation}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr
                    // biome-ignore lint/suspicious/noArrayIndexKey: an edit addresses an item by its position.
                    key={index}
                    className="align-top"
                    data-testid="meeting-action-item"
                    data-edited={item.edited ? "true" : undefined}
                  >
                    <td className="py-1.5 pr-3">
                      {item.task}
                      {item.firstStep ? <div className="text-[var(--text-3)]">{item.firstStep}</div> : null}
                      <MeetingItemMarks quote={item.quote} evidence={item.evidence} edited={item.edited} />
                    </td>
                    <td className={`py-1.5 pr-3 ${item.owner === NEEDS_OWNER ? "text-[var(--danger)]" : ""}`}>
                      {item.owner}
                    </td>
                    <td className="py-1.5">{item.due || "—"}</td>
                    {editing ? (
                      <td className="py-1 pl-1 text-right">
                        <MeetingEditButton disabled={locked} onClick={() => setTarget({ kind: "action", index })} />
                      </td>
                    ) : null}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </Section>
      ) : null}

      {minutes.risks.length > 0 ? (
        <Section title={t("meeting.minutes.risks")}>
          <ul className="list-disc space-y-1 pl-5">
            {minutes.risks.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {minutes.openQuestions.length > 0 ? (
        <Section title={t("meeting.minutes.questions")}>
          <ul className="list-disc space-y-1 pl-5">
            {minutes.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </Section>
      ) : null}
    </article>
  );
}
