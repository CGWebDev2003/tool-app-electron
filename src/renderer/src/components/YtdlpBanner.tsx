import type { ToolStatusState } from "../hooks/useToolStatus";
import styles from "./YtdlpBanner.module.css";

/**
 * yt-dlp is the one dependency we cannot ship (it has to stay current), so the
 * missing/outdated case gets a one-click fix instead of a README instruction.
 */
export default function YtdlpBanner({ status }: { status: ToolStatusState }) {
  const ytdlp = status.status?.ytdlp;
  const installed = Boolean(ytdlp?.available);

  if (status.loading && !status.status) {
    return <div className={styles.banner}>Umgebung wird geprüft...</div>;
  }

  return (
    <div className={installed ? styles.bannerSubtle : styles.banner}>
      <div className={styles.text}>
        {installed ? (
          <>
            yt-dlp {ytdlp?.version ?? ""} ist einsatzbereit
            {ytdlp?.source === "system" && " (aus dem System-PATH)"}. YouTube ändert sich häufig —
            bei Fehlern hilft ein Update.
          </>
        ) : (
          <>
            <strong>yt-dlp fehlt.</strong> Es wird für YouTube-Downloads benötigt und kann direkt
            hier installiert werden — Python ist dafür nicht nötig.
          </>
        )}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          onClick={() => void status.installYtdlp()}
          disabled={status.installing}
        >
          {status.installing
            ? "Läuft..."
            : installed
              ? "yt-dlp aktualisieren"
              : "yt-dlp installieren"}
        </button>
        {/* Escape hatch when a virus scanner or network filter blocks the
            automatic install. */}
        <button
          type="button"
          className={styles.actionQuiet}
          onClick={() => void status.pickYtdlp()}
          disabled={status.installing}
        >
          Manuell auswählen
        </button>
      </div>
      {status.installMessage && <div className={styles.message}>{status.installMessage}</div>}
    </div>
  );
}
