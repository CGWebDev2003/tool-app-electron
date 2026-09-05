import { useCallback, useEffect, useState } from "react";
import type { UpdateStatus } from "@shared/types";

export type UpdateStatusState = {
  status: UpdateStatus;
  check: () => Promise<void>;
  install: () => Promise<void>;
};

export function useUpdateStatus(): UpdateStatusState {
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });

  useEffect(() => {
    let active = true;
    void window.api.update.status().then((next) => {
      if (active) setStatus(next);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => window.api.onUpdateStatus(setStatus), []);

  const check = useCallback(async () => {
    await window.api.update.check();
  }, []);

  const install = useCallback(async () => {
    await window.api.update.install();
  }, []);

  return { status, check, install };
}
