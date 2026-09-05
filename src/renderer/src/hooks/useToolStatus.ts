import { useCallback, useEffect, useState } from "react";
import type { ToolStatus } from "@shared/types";

export type ToolStatusState = {
  status: ToolStatus | null;
  loading: boolean;
  installing: boolean;
  installMessage: string;
  refresh: () => Promise<void>;
  installYtdlp: () => Promise<{ ok: boolean; error?: string }>;
};

export function useToolStatus(): ToolStatusState {
  const [status, setStatus] = useState<ToolStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState("");

  const refresh = useCallback(async () => {
    const next = await window.api.system.status().catch(() => null);
    if (next) setStatus(next);
    setLoading(false);
  }, []);

  // The initial load resolves in a callback rather than in the effect body, so
  // it does not trigger a cascading render on mount.
  useEffect(() => {
    let active = true;
    void window.api.system.status().then(
      (next) => {
        if (!active) return;
        setStatus(next);
        setLoading(false);
      },
      () => {
        if (active) setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return window.api.onJobProgress((progress) => {
      if (progress.jobId !== "ytdlp-install") return;
      const percent = progress.percent === null ? "" : ` (${progress.percent}%)`;
      setInstallMessage(`${progress.message}${percent}`);
    });
  }, []);

  const installYtdlp = useCallback(async () => {
    setInstalling(true);
    setInstallMessage("Installation wird gestartet...");
    try {
      const result = await window.api.system.installYtdlp();
      if (result.ok) {
        setInstallMessage(`yt-dlp ${result.version} wurde installiert.`);
        await refresh();
        return { ok: true };
      }
      setInstallMessage(result.error);
      return { ok: false, error: result.error };
    } finally {
      setInstalling(false);
    }
  }, [refresh]);

  return { status, loading, installing, installMessage, refresh, installYtdlp };
}
