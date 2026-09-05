import { useState } from "react";
import JobStatus from "../components/JobStatus";
import { useJob } from "../hooks/useJob";
import type { ToolStatusState } from "../hooks/useToolStatus";
import type { ConvertTarget, MediaInfo } from "@shared/types";
import styles from "../styles/page.module.css";

const TARGET_GROUPS: Array<{
  label: string;
  options: Array<{ value: ConvertTarget; label: string }>;
}> = [
  {
    label: "Video",
    options: [
      { value: "mp4", label: "MP4" },
      { value: "webm", label: "WebM" },
      { value: "mov", label: "MOV" },
      { value: "gif", label: "GIF (aus Video)" },
    ],
  },
  {
    label: "Audio",
    options: [
      { value: "mp3", label: "MP3" },
      { value: "wav", label: "WAV" },
      { value: "m4a", label: "M4A" },
      { value: "ogg", label: "OGG" },
    ],
  },
];

function baseName(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")} min`;
}

export default function Converter({ status }: { status: ToolStatusState }) {
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [target, setTarget] = useState<ConvertTarget>("mp4");
  const job = useJob();

  async function handlePick() {
    const picked = await window.api.dialog.pickMediaFile();
    if (!picked) return;

    setInputPath(picked);
    setInfo(null);
    job.reset();

    // Probing right away surfaces "no audio track" before the user waits on a
    // conversion that cannot work.
    const probed = await window.api.convert.probe(picked);
    if (probed.ok) setInfo(probed.info);
    else job.setError(probed.error);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!inputPath || job.running) return;

    job.reset();
    const savePath = await window.api.dialog.pickSavePath(baseName(inputPath), target);
    if (!savePath) return;

    await job.run((jobId) => window.api.convert.run({ jobId, inputPath, target, savePath }));
  }

  const ffmpegReady = status.status?.ffmpeg.available ?? false;

  return (
    <div>
      <h1 className={styles.heading}>Converter</h1>
      <p className={styles.subheading}>
        Wandelt Video- und Audiodateien um. ffmpeg ist in der App enthalten — es muss nichts
        installiert werden.
      </p>

      {!ffmpegReady && !status.loading && (
        <p className={styles.subheading}>
          ffmpeg steht auf dieser Plattform nicht zur Verfügung. Setze die Umgebungsvariablen
          FFMPEG_PATH und FFPROBE_PATH, um eine eigene Installation zu verwenden.
        </p>
      )}

      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.filePicker}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={handlePick}
            disabled={job.running}
          >
            Datei wählen
          </button>
          <span className={styles.fileName} title={inputPath ?? ""}>
            {inputPath ? (inputPath.split(/[\\/]/).pop() ?? inputPath) : "Keine Datei ausgewählt"}
          </span>
        </div>
        <select
          className={styles.select}
          value={target}
          onChange={(event) => setTarget(event.target.value as ConvertTarget)}
          disabled={job.running}
        >
          {TARGET_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          className={styles.button}
          type="submit"
          disabled={job.running || !inputPath || !ffmpegReady}
        >
          {job.running ? "Konvertiert..." : "Konvertieren"}
        </button>
      </form>

      {info && (
        <p className={styles.fileDetails}>
          Enthält: {[info.hasVideo && "Video", info.hasAudio && "Audio"].filter(Boolean).join(" + ") || "keine Medienspur"}
          {info.durationSeconds !== null && ` · Länge ${formatDuration(info.durationSeconds)}`}
        </p>
      )}

      <JobStatus job={job} successVerb="konvertiert" onCancel={job.cancel} />
    </div>
  );
}
