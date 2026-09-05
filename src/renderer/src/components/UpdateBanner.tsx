import type { UpdateStatusState } from "../hooks/useUpdateStatus";
import styles from "./YtdlpBanner.module.css";

/** Only visible while there is actually something to report or act on. */
export default function UpdateBanner({ update }: { update: UpdateStatusState }) {
  const { status, check, install } = update;

  if (status.state === "idle" || status.state === "checking" || status.state === "not-available") {
    return null;
  }

  return (
    <div className={styles.bannerSubtle}>
      <div className={styles.text}>
        {status.state === "available" && <>Update {status.version} wird heruntergeladen...</>}
        {status.state === "downloading" && (
          <>Update wird heruntergeladen ({status.percent}%)...</>
        )}
        {status.state === "downloaded" && (
          <>Update {status.version} ist bereit. Jetzt neu starten, um es zu installieren.</>
        )}
        {status.state === "error" && <>Update-Prüfung fehlgeschlagen: {status.message}</>}
      </div>
      <div className={styles.actions}>
        {status.state === "downloaded" && (
          <button type="button" className={styles.action} onClick={() => void install()}>
            Neu starten &amp; installieren
          </button>
        )}
        {status.state === "error" && (
          <button type="button" className={styles.actionQuiet} onClick={() => void check()}>
            Erneut versuchen
          </button>
        )}
      </div>
    </div>
  );
}
