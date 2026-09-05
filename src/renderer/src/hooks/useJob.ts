import { useCallback, useEffect, useRef, useState } from "react";
import type { JobResult } from "@shared/types";

export type JobState = {
  running: boolean;
  percent: number | null;
  message: string;
  /** Error text, or "" when there is none. */
  error: string;
  /** Path of the finished file, or null. */
  outputPath: string | null;
  run: (start: (jobId: string) => Promise<JobResult>) => Promise<void>;
  cancel: () => void;
  reset: () => void;
  setError: (message: string) => void;
  setMessage: (message: string) => void;
};

let jobCounter = 0;

/** Drives one long-running main-process job and mirrors its progress. */
export function useJob(): JobState {
  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const activeJobId = useRef<string | null>(null);

  useEffect(() => {
    return window.api.onJobProgress((progress) => {
      if (progress.jobId !== activeJobId.current) return;
      setPercent(progress.percent);
      setMessage(progress.message);
    });
  }, []);

  const reset = useCallback(() => {
    setPercent(null);
    setMessage("");
    setError("");
    setOutputPath(null);
  }, []);

  const run = useCallback(
    async (start: (jobId: string) => Promise<JobResult>) => {
      const jobId = `job-${++jobCounter}-${Date.now()}`;
      activeJobId.current = jobId;
      reset();
      setRunning(true);

      try {
        const result = await start(jobId);
        if (activeJobId.current !== jobId) return;

        if (result.ok) {
          setOutputPath(result.outputPath);
          setPercent(100);
          setMessage("");
        } else {
          setError(result.error);
          setPercent(null);
          setMessage("");
        }
      } catch (caught) {
        if (activeJobId.current !== jobId) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (activeJobId.current === jobId) {
          activeJobId.current = null;
          setRunning(false);
        }
      }
    },
    [reset],
  );

  const cancel = useCallback(() => {
    if (activeJobId.current) {
      setMessage("Wird abgebrochen...");
      void window.api.job.cancel(activeJobId.current);
    }
  }, []);

  return {
    running,
    percent,
    message,
    error,
    outputPath,
    run,
    cancel,
    reset,
    setError,
    setMessage,
  };
}
