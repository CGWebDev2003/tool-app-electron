import type { JobState } from "../hooks/useJob";
import styles from "./JobStatus.module.css";

type Props = {
  job: JobState;
  /** Wording for the success line, e.g. "heruntergeladen" or "konvertiert". */
  successVerb: string;
  onCancel?: () => void;
};

/** Progress bar, error box and "show in folder" line for a running job. */
export default function JobStatus({ job, successVerb, onCancel }: Props) {
  if (job.running) {
    return (
      <div className={styles.block}>
        <div className={styles.row}>
          <span className={styles.message}>{job.message || "Wird vorbereitet..."}</span>
          {onCancel && (
            <button type="button" className={styles.cancel} onClick={onCancel}>
              Abbrechen
            </button>
          )}
        </div>
        <div className={styles.track}>
          <div
            className={job.percent === null ? styles.barIndeterminate : styles.bar}
            style={job.percent === null ? undefined : { width: `${job.percent}%` }}
          />
        </div>
        {job.percent !== null && <span className={styles.percent}>{job.percent}%</span>}
      </div>
    );
  }

  if (job.error) {
    return (
      <div className={`${styles.block} ${styles.error}`} role="alert">
        {job.error}
      </div>
    );
  }

  if (job.outputPath) {
    return (
      <div className={`${styles.block} ${styles.success}`}>
        <span className={styles.successText}>
          Datei wurde {successVerb}: <code>{job.outputPath}</code>
        </span>
        <button
          type="button"
          className={styles.reveal}
          onClick={() => void window.api.shell.revealFile(job.outputPath as string)}
        >
          Im Ordner anzeigen
        </button>
      </div>
    );
  }

  return null;
}
