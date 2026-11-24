import { useCallback } from "react";
import { type UpdateState, updateStatusLine, updateVersionLine } from "@/lib/app-updates-copy";

export const PUBLIC_PRODUCT_NAME = "Nultron";

export type AppUpdatesController = {
  visible: boolean;
  supported: boolean;
  state: UpdateState;
  busy: boolean;
  statusText: string;
  check: () => Promise<void>;
  updateAndRestart: () => Promise<void>;
};

const UNAVAILABLE_STATE: UpdateState = {
  supported: false,
  status: "unavailable",
};

export function useAppUpdates(_productName: string): AppUpdatesController {
  const check = useCallback(async () => {}, []);
  const updateAndRestart = useCallback(async () => {}, []);
  const statusText = [updateVersionLine(UNAVAILABLE_STATE.currentVersion), updateStatusLine(UNAVAILABLE_STATE, false)]
    .filter((part) => part.length > 0)
    .join(" ");

  return {
    visible: false,
    supported: false,
    state: UNAVAILABLE_STATE,
    busy: false,
    statusText,
    check,
    updateAndRestart,
  };
}
