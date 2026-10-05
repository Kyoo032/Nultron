/** Limits and fixed codes for the Personal "folder" root. Every number here is a ceiling, never a default to raise. */

/** Largest file the agent may read or a proposal may carry, in bytes. */
export const FOLDER_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** A NUL byte in this many leading bytes marks a file as binary. */
export const FOLDER_BINARY_SNIFF_BYTES = 8 * 1024;

export const FOLDER_LIST_MAX = 5000;
export const FOLDER_SEARCH_MAX_BYTES = 50 * 1024 * 1024;
export const FOLDER_SEARCH_PATTERN_MAX = 200;

/** A runaway agent loop must not be able to fill the owner's database with proposals. */
export const FOLDER_PENDING_MAX = 50;

export const FOLDER_PATH_MAX_CHARS = 1024;
export const FOLDER_SEGMENT_MAX_CHARS = 255;
export const FOLDER_PROPOSALS_LIST_MAX = 200;

/** File the mount record lives in, under the local data dir. Machine-local on purpose. */
export const FOLDER_MOUNT_FILE = "folder-mounts.json";

export const FOLDER_UNAVAILABLE_CODE = "folder_unavailable";
export const FOLDER_MOUNT_IPC_ONLY_CODE = "folder_mount_ipc_only";
export const FOLDER_MOUNT_REFUSED_CODE = "folder_mount_refused";
export const FOLDER_NOT_MOUNTED_CODE = "folder_not_mounted";
export const PROPOSAL_NOT_FOUND_CODE = "not_found";
export const PROPOSAL_NOT_PENDING_CODE = "proposal_not_pending";
