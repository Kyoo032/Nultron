import { useMemo, useSyncExternalStore } from "react";
import {
  DocsError,
  deleteDocSection,
  fetchDocPage,
  postDocSection,
  putDocSection,
  type DocChange,
  type DocPage,
  type DocSection,
  type DocSectionInput,
} from "./docs-client";

export type SectionNotice = { readonly sectionId: string | null; readonly code: string };

export type EditState = {
  readonly openId: string | null;
  readonly confirmingId: string | null;
  readonly busy: boolean;
  readonly notice: SectionNotice | null;
};

export type SectionTransport = {
  readonly put: (sectionId: string, baseVersion: number, section: DocSectionInput) => Promise<DocChange>;
  readonly post: (baseVersion: number, afterSectionId: string | undefined) => Promise<DocChange>;
  readonly remove: (sectionId: string, baseVersion: number) => Promise<DocChange>;
  readonly fetchPage: () => Promise<DocPage>;
  readonly applyWrite: (write: DocChange) => void;
};

export type WriteOutcome =
  | { readonly ok: true; readonly write: DocChange }
  | { readonly ok: false; readonly code: string };

export type SectionActions = {
  readonly open: (sectionId: string) => void;
  readonly close: () => void;
  readonly askRemove: (sectionId: string | null) => void;
  readonly save: (sectionId: string, section: DocSectionInput, headVersion: number) => Promise<void>;
  readonly keep: (sectionId: string, rebuild: (fresh: DocSection) => DocSectionInput) => Promise<void>;
  readonly reload: () => Promise<void>;
  readonly remove: (sectionId: string, headVersion: number) => Promise<void>;
  readonly add: (
    afterSectionId: string | undefined,
    headVersion: number,
    sectionIds: readonly string[],
  ) => Promise<void>;
};

export type SectionEditing = EditState & SectionActions;

export type SectionStore = {
  readonly getState: () => EditState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly actions: SectionActions;
};

export const IDLE_EDIT: EditState = { openId: null, confirmingId: null, busy: false, notice: null };

const GENERIC_CODE = "docs_error";
const SECTION_GONE = "section_not_found";
const REFRESH_FAILED = "refresh_failed";

const NOTICE_KEYS: Readonly<Record<string, string>> = {
  section_changed: "docpage.edit.conflict",
  storage_quota_exceeded: "docpage.edit.quota",
  last_section: "docpage.edit.lastSection",
  section_not_found: "docpage.edit.sectionGone",
  refresh_failed: "docpage.edit.refreshFailed",
};

export function codeOf(error: unknown): string {
  return error instanceof DocsError ? error.code : GENERIC_CODE;
}

export function noticeKeyFor(code: string): string {
  return NOTICE_KEYS[code] ?? "docpage.edit.failed";
}

export function newSectionIds(before: readonly string[], after: readonly string[]): string[] {
  return after.filter((id) => !before.includes(id));
}

async function attempt(work: () => Promise<DocChange>): Promise<WriteOutcome> {
  try {
    return { ok: true, write: await work() };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
}

async function keepOutcome(
  transport: SectionTransport,
  sectionId: string,
  rebuild: (fresh: DocSection) => DocSectionInput,
): Promise<WriteOutcome> {
  let page: DocPage;
  try {
    page = await transport.fetchPage();
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
  const fresh =
    page.spec.kind === "document" ? page.spec.sections.find((section) => section.id === sectionId) : undefined;
  if (fresh === undefined) {
    return { ok: false, code: SECTION_GONE };
  }
  const input = rebuild(fresh);
  return attempt(() => transport.put(sectionId, page.headVersion, input));
}

export function createSectionStore(transport: SectionTransport): SectionStore {
  let state: EditState = IDLE_EDIT;
  const listeners = new Set<() => void>();

  const update = (patch: Partial<EditState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener();
    }
  };

  async function refreshOrNotice(): Promise<void> {
    try {
      await transport.fetchPage();
    } catch {
      update({ notice: { sectionId: null, code: REFRESH_FAILED } });
    }
  }

  async function conclude(outcome: WriteOutcome, sectionId: string, onAccepted: Partial<EditState>): Promise<void> {
    if (!outcome.ok) {
      if (outcome.code === SECTION_GONE) {
        update({ busy: false, confirmingId: null, openId: null, notice: { sectionId: null, code: outcome.code } });
      } else {
        update({ busy: false, confirmingId: null, notice: { sectionId, code: outcome.code } });
      }
      return;
    }
    transport.applyWrite(outcome.write);
    update({ busy: false, notice: null, ...onAccepted });
    await refreshOrNotice();
  }

  const actions: SectionActions = {
    open(sectionId) {
      update({ openId: sectionId, confirmingId: null, notice: null });
    },
    close() {
      update({ openId: null, notice: null });
    },
    askRemove(sectionId) {
      update({ confirmingId: sectionId, notice: null });
    },
    async save(sectionId, section, headVersion) {
      if (state.busy) {
        return;
      }
      update({ busy: true, notice: null });
      const outcome = await attempt(() => transport.put(sectionId, headVersion, section));
      await conclude(outcome, sectionId, { openId: null });
    },
    async keep(sectionId, rebuild) {
      if (state.busy) {
        return;
      }
      update({ busy: true, notice: null });
      const outcome = await keepOutcome(transport, sectionId, rebuild);
      await conclude(outcome, sectionId, { openId: null });
    },
    async reload() {
      if (state.busy) {
        return;
      }
      const openId = state.openId;
      update({ busy: true, notice: null });
      try {
        await transport.fetchPage();
        update({ busy: false, openId: null, confirmingId: null });
      } catch (error) {
        update({ busy: false, notice: { sectionId: openId, code: codeOf(error) } });
      }
    },
    async remove(sectionId, headVersion) {
      if (state.busy) {
        return;
      }
      update({ busy: true, notice: null });
      const outcome = await attempt(() => transport.remove(sectionId, headVersion));
      await conclude(outcome, sectionId, {
        confirmingId: null,
        openId: state.openId === sectionId ? null : state.openId,
      });
    },
    async add(afterSectionId, headVersion, sectionIds) {
      if (state.busy) {
        return;
      }
      update({ busy: true, notice: null });
      const outcome = await attempt(() => transport.post(headVersion, afterSectionId));
      if (!outcome.ok) {
        update({ busy: false, notice: { sectionId: null, code: outcome.code } });
        return;
      }
      transport.applyWrite(outcome.write);
      let page: DocPage;
      try {
        page = await transport.fetchPage();
      } catch {
        update({ busy: false, notice: { sectionId: null, code: REFRESH_FAILED } });
        return;
      }
      const created =
        page.spec.kind === "document"
          ? newSectionIds(
              sectionIds,
              page.spec.sections.map((section) => section.id),
            )
          : [];
      update({ busy: false, notice: null, openId: created[0] ?? null });
    },
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    actions,
  };
}

function transportFor(
  artifactId: string,
  applyDoc: (doc: DocPage) => void,
  applyWrite: (write: DocChange) => void,
): SectionTransport {
  return {
    put: (sectionId, baseVersion, section) => putDocSection(artifactId, sectionId, { baseVersion, section }),
    post: (baseVersion, afterSectionId) =>
      postDocSection(artifactId, { baseVersion, afterSectionId, section: { blocks: [] } }),
    remove: (sectionId, baseVersion) => deleteDocSection(artifactId, sectionId, { baseVersion }),
    fetchPage: async () => {
      const doc = await fetchDocPage(artifactId);
      applyDoc(doc);
      return doc;
    },
    applyWrite,
  };
}

export function useSectionEditing(
  artifactId: string,
  applyDoc: (doc: DocPage) => void,
  applyWrite: (write: DocChange) => void,
): SectionEditing {
  const store = useMemo(
    () => createSectionStore(transportFor(artifactId, applyDoc, applyWrite)),
    [artifactId, applyDoc, applyWrite],
  );
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return { ...state, ...store.actions };
}
