import { useEffect, useMemo, useReducer, useRef } from "react";
import { createFolderController, type FolderController } from "@/lib/folder-actions";
import { folderApi } from "@/lib/folder-api";
import { folderReducer, INITIAL_FOLDER_STATE, type FolderState } from "@/lib/folder-state";
import { useHostCapabilities } from "@/lib/host-capabilities";

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
        pickFolder: async () => null,
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

  return { state, controller, picker: false };
}
