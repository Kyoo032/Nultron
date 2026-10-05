import { ApiError } from "@agentforge/core";
import {
  FOLDER_MOUNT_IPC_ONLY_CODE,
  FOLDER_NOT_MOUNTED_CODE,
  FOLDER_UNAVAILABLE_CODE,
  PROPOSAL_NOT_FOUND_CODE,
  PROPOSAL_NOT_PENDING_CODE,
} from "./constants";

/** Route-side errors, one fixed sentence each. They name no path and no OS error. */

export function folderUnavailableError(): ApiError {
  return new ApiError(
    FOLDER_UNAVAILABLE_CODE,
    "Opening a folder is only available in the desktop app, on your own machine.",
    403,
  );
}

export function mountIpcOnlyError(): ApiError {
  return new ApiError(FOLDER_MOUNT_IPC_ONLY_CODE, "A folder can only be picked from the desktop app.", 403);
}

export function notMountedError(): ApiError {
  return new ApiError(FOLDER_NOT_MOUNTED_CODE, "No folder is open for this desk.", 409);
}

export function proposalNotFoundError(): ApiError {
  return new ApiError(PROPOSAL_NOT_FOUND_CODE, "Proposal not found", 404);
}

export function proposalNotPendingError(): ApiError {
  return new ApiError(PROPOSAL_NOT_PENDING_CODE, "That change has already been decided.", 409);
}
