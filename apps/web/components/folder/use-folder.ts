import { useEffect, useMemo, useReducer, useRef } from "react";
import { hasDesktopFolderPicker, pickDesktopFolder } from "@/lib/desktop-bridge";
import { createFolderController, type FolderController } from "@/lib/folder-actions";
import { folderApi } from "@/lib/folder-api";
import { folderReducer, INITIAL_FOLDER_STATE, type FolderState } from "@/lib/folder-state";
import { useHostCapabilities } from "@/lib/host-capabilities";

/**
 * The folder surface's state, kept in step with the host.
 *
 * It asks the host once on mount and again each time a run ends (`running` going from true to
 * false: that is when the agent has finished proposing) and after every decision. Nothing polls.
 * It asks at all only where the host says a path on this machine means something
 * (`localPaths`): on the hosted app no request is made and the surface stays hidden.
 */
export function useFolder(running: boolean): { state: FolderState; controller: FolderController; picker: boolean } {
  const { localPaths } = useHostCapabilities();
  const [state, dispatch] = useReducer(folderReducer, INITIAL_FOLDER_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  const controller = useMemo(
    () =>
      createFolderController({
        api: folderApi,
        dispatch,
        getState: () => stateRef.current,
        pickFolder: pickDesktopFolder,
      }),
    [],
  );

  useEffect(() => {
    if (localPaths) {
      void controller.refresh();
    }
  }, [localPaths, controller]);

  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && localPaths) {
      void controller.refresh();
    }
    wasRunning.current = running;
  }, [running, localPaths, controller]);

  return { state, controller, picker: hasDesktopFolderPicker() };
}
