import { useState } from "react";
import JobStatus from "../components/JobStatus";
import YtdlpBanner from "../components/YtdlpBanner";
import { useJob } from "../hooks/useJob";
import type { ToolStatusState } from "../hooks/useToolStatus";
import type { YoutubeFormat } from "@shared/types";
import styles from "../styles/page.module.css";

const FORMAT_OPTIONS: Array<{ value: YoutubeFormat; label: string; extension: string }> = [
  { value: "video", label: "Video (MP4)", extension: "mp4" },
  { value: "audio_m4a", label: "Nur Audio (M4A)", extension: "m4a" },
  { value: "audio_mp3", label: "Nur Audio (MP3)", extension: "mp3" },
];

export default function YoutubeDownload({ status }: { status: ToolStatusState }) {
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<YoutubeFormat>("video");
  const job = useJob();

  const option = FORMAT_OPTIONS.find((entry) => entry.value === format) ?? FORMAT_OPTIONS[0];

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!url.trim() || job.running) return;

    job.reset();

    // Resolve the title first so the save dialog can suggest a real filename,
    // and so an unreachable video fails before the user picks a location.
    const titleResult = await window.api.youtube.getTitle(url);
    if (!titleResult.ok) {
      job.setError(titleResult.error);
      return;
    }

    const savePath = await window.api.dialog.pickSavePath(titleResult.title, option.extension);
    if (!savePath) return;

    await job.run((jobId) =>
      window.api.youtube.download({ jobId, url: url.trim(), format, savePath }),
    );
  }

  const ytdlpReady = status.status?.ytdlp.available ?? false;

  return (
    <div>
      <h1 className={styles.heading}>YouTube Download</h1>
      <p className={styles.subheading}>
        Lädt ein einzelnes Video herunter und speichert es dort, wo du es haben möchtest.
      </p>

      <YtdlpBanner status={status} />

      <form className={styles.form} onSubmit={handleSubmit}>
        <input
          className={styles.input}
          type="url"
          placeholder="https://www.youtube.com/watch?v=..."
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={job.running}
          required
        />
        <select
          className={styles.select}
          value={format}
          onChange={(event) => setFormat(event.target.value as YoutubeFormat)}
          disabled={job.running}
        >
          {FORMAT_OPTIONS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
        <button
          className={styles.button}
          type="submit"
          disabled={job.running || !ytdlpReady || !url.trim()}
        >
          {job.running ? "Lädt..." : "Download"}
        </button>
      </form>

      <JobStatus job={job} successVerb="heruntergeladen" onCancel={job.cancel} />
    </div>
  );
}
