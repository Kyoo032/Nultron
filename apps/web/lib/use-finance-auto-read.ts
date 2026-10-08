"use client";

import { useEffect, useRef, useState } from "react";
import { financeAutoRequestBody, type FinanceAutoAnswer, type FinanceAutoInput } from "./finance-auto-client";
import { requestFinanceAuto } from "./finance-auto-io";
import { t } from "./i18n";

/** How long the prompt has to sit still before it is read again. A file or pasted rows are read at once. */
export const FINANCE_AUTO_DEBOUNCE_MS = 450;

export type FinanceAutoRead = {
  /**
   * The latest answer for the figures that are on screen now. Null until something is worth reading,
   * after a refusal, and while a new file or new rows are being read: an answer for the previous
   * figures is never shown, and never written up.
   */
  readonly answer: FinanceAutoAnswer | null;
  /** A read is in flight. */
  readonly checking: boolean;
  readonly error: string | null;
};

type Held = { readonly answer: FinanceAutoAnswer | null; readonly checking: boolean; readonly error: string | null; readonly key: string | null };

const IDLE: Held = { answer: null, checking: false, error: null, key: null };

/** What changes the figures, as one string, so an unrelated render never re-asks. */
function figuresKey(input: FinanceAutoInput): string {
  return [input.figures ?? "", input.proseText ?? "", (input.sheetNames ?? []).join("|"), input.locale].join("\u0000");
}

/**
 * The free read, kept up to date: ask the host what the figures (and the question) look like whenever
 * either changes, and never act on an answer that has been overtaken.
 *
 * It is free and code-only on the host, so it needs no key and spends nothing, which is why it may run
 * on its own. The paid write-up is a separate call that only a press makes. A change to the figures is
 * read at once; a change to the prompt waits for the person to stop typing. A request that has been
 * overtaken is aborted, and its answer is dropped even if it arrives.
 */
export function useFinanceAutoRead(input: FinanceAutoInput): FinanceAutoRead {
  const [held, setHeld] = useState<Held>(IDLE);
  const latest = useRef(input);
  latest.current = input;
  const lastFigures = useRef<string | null>(null);
  const turn = useRef(0);

  const figures = figuresKey(input);
  const question = (input.prompt ?? "").trim();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `figures` and `question` are the triggers; the body reads the latest input through the ref.
  useEffect(() => {
    const body = financeAutoRequestBody(latest.current);
    turn.current += 1;
    const mine = turn.current;
    if (!body) {
      lastFigures.current = figures;
      setHeld(IDLE);
      return undefined;
    }
    const figuresChanged = lastFigures.current !== figures;
    lastFigures.current = figures;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        setHeld((before) => ({ ...before, checking: true, error: null }));
        requestFinanceAuto(body, controller.signal).then(
          (answer) => {
            if (mine === turn.current) {
              setHeld({ answer, checking: false, error: null, key: figures });
            }
          },
          (failure: unknown) => {
            if (mine === turn.current && !controller.signal.aborted) {
              const message = failure instanceof Error ? failure.message : t("finance.auto.errors.read");
              setHeld({ answer: null, checking: false, error: message, key: figures });
            }
          },
        );
      },
      figuresChanged ? 0 : FINANCE_AUTO_DEBOUNCE_MS,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [figures, question]);

  return { answer: held.key === figures ? held.answer : null, checking: held.checking, error: held.error };
}
