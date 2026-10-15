export { createDocVersionStore, docVersionStore, type DocVersionStore, type DocVersionStoreOptions } from "./store";
export { changedSectionIds, newSectionId, sectionIdsOf } from "./section-ids";
export { lastChanges, planPrune, type HistoryRow, type PrunePlan } from "./history";
export { pendingBaseVersions } from "./pending-bases";
export {
  createProposalStore,
  proposalStore,
  type CreateProposalResult,
  type DocProposal,
  type KeepResult,
  type ProposalChange,
  type ProposalInput,
  type ProposalStatus,
  type ProposalStore,
  type ProposalStoreOptions,
} from "./proposals";
export {
  DOC_VERSION_CAP,
  type AppendAuthor,
  type AppendRefusal,
  type AppendResult,
  type AppendVersionInput,
  type DocVersion,
  type DocVersionAuthor,
  type DocVersionCap,
  type DocVersionInfo,
  type ProtectedVersions,
  type SectionAuthor,
  type SectionAuthors,
} from "./types";
