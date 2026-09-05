import type { RouteId } from "../components/Sidebar";
import type { ToolStatusState } from "../hooks/useToolStatus";
import pageStyles from "../styles/page.module.css";
import styles from "./Dashboard.module.css";

type Props = {
  status: ToolStatusState;
  onNavigate: (route: RouteId) => void;
};

export default function Dashboard({ status, onNavigate }: Props) {
  const ffmpegOk = status.status?.ffmpeg.available ?? false;
  const ytdlp = status.status?.ytdlp;

  return (
    <div>
      <h1 className={pageStyles.heading}>Dashboard</h1>
      <p className={pageStyles.subheading}>
        Zwei Werkzeuge, komplett offline lauffähig: ffmpeg ist fest eingebaut, yt-dlp wird bei
        Bedarf automatisch nachgeladen.
      </p>

      <div className={styles.cards}>
        <button
          type="button"
          className={styles.card}
          onClick={() => onNavigate("youtube-download")}
        >
          <span className={styles.cardTitle}>YouTube Download</span>
          <span className={styles.cardText}>
            Video als MP4 oder Ton als M4A/MP3 speichern — dank mitgeliefertem ffmpeg auch in voller
            Auflösung.
          </span>
        </button>
        <button type="button" className={styles.card} onClick={() => onNavigate("converter")}>
          <span className={styles.cardTitle}>Converter</span>
          <span className={styles.cardText}>
            Video und Audio zwischen MP4, WebM, MOV, GIF, MP3, WAV, M4A und OGG umwandeln.
          </span>
        </button>
        <button type="button" className={styles.card} onClick={() => onNavigate("pdf-editor")}>
          <span className={styles.cardTitle}>PDF Bearbeiten</span>
          <span className={styles.cardText}>
            PDF öffnen, Textfelder und Bilder platzieren und unterschreiben.
          </span>
        </button>
      </div>

      <h2 className={styles.sectionTitle}>Status</h2>
      <ul className={styles.statusList}>
        <li className={styles.statusItem}>
          <span className={ffmpegOk ? styles.dotOk : styles.dotBad} />
          <span>
            <strong>ffmpeg / ffprobe</strong>{" "}
            {ffmpegOk ? "mitgeliefert und einsatzbereit" : "nicht verfügbar"}
          </span>
        </li>
        <li className={styles.statusItem}>
          <span className={ytdlp?.available ? styles.dotOk : styles.dotBad} />
          <span>
            <strong>yt-dlp</strong>{" "}
            {ytdlp?.available
              ? `${ytdlp.version} (${ytdlp.source === "managed" ? "von der App verwaltet" : ytdlp.source})`
              : "nicht installiert"}
          </span>
        </li>
      </ul>

      {!ytdlp?.available && (
        <button
          type="button"
          className={pageStyles.button}
          onClick={() => void status.installYtdlp()}
          disabled={status.installing}
        >
          {status.installing ? "Läuft..." : "yt-dlp jetzt installieren"}
        </button>
      )}
      {status.installMessage && <p className={pageStyles.fileDetails}>{status.installMessage}</p>}
    </div>
  );
}
