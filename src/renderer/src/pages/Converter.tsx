import { useState } from "react";
import JobStatus from "../components/JobStatus";
import { useJob } from "../hooks/useJob";
import type { ToolStatusState } from "../hooks/useToolStatus";
import type { ConvertTarget, DocumentInfo, DocumentTarget, MediaInfo } from "@shared/types";
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
      { value: "gif", label: "GIF" },
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
  {
    label: "Bild",
    options: [
      { value: "png", label: "PNG" },
      { value: "jpg", label: "JPG" },
      { value: "webp", label: "WebP" },
      { value: "bmp", label: "BMP" },
      { value: "tiff", label: "TIFF" },
    ],
  },
];

const DOCUMENT_TARGET_OPTIONS: Array<{ value: DocumentTarget; label: string }> = [
  { value: "pdf", label: "PDF" },
  { value: "docx", label: "Word (DOCX)" },
  { value: "txt", label: "Text (TXT)" },
];

const DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "txt"]);

function extensionOf(filePath: string): string {
  return (filePath.split(".").pop() ?? "").toLowerCase();
}

function isDocumentFile(filePath: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extensionOf(filePath));
}

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

/** One line saying what the chosen file actually is. */
function describeMedia(info: MediaInfo): string {
  const size = info.width && info.height ? `${info.width} × ${info.height}` : null;

  if (info.isImage) {
    return ["Bild", size].filter(Boolean).join(" · ");
  }

  const tracks = [
    info.hasVideo && "Video",
    info.hasAudio && "Audio",
    info.hasCoverArt && "Cover-Bild",
  ].filter(Boolean);

  const parts = [
    tracks.length ? `Enthält: ${tracks.join(" + ")}` : "Keine Medienspur",
    info.hasVideo && size,
    info.durationSeconds !== null && `Länge ${formatDuration(info.durationSeconds)}`,
  ].filter(Boolean);

  return parts.join(" · ");
}

const DOCUMENT_FORMAT_LABEL: Record<DocumentTarget, string> = {
  pdf: "PDF",
  docx: "Word-Dokument (DOCX)",
  txt: "Textdatei",
};

/** One line saying what the chosen document actually is. */
function describeDocument(info: DocumentInfo): string {
  const parts = [
    DOCUMENT_FORMAT_LABEL[info.format],
    info.pageCount !== null && `${info.pageCount} Seite${info.pageCount === 1 ? "" : "n"}`,
    `${info.characterCount.toLocaleString("de-DE")} Zeichen`,
  ].filter(Boolean);
  return parts.join(" · ");
}

export default function Converter({ status }: { status: ToolStatusState }) {
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [isDocument, setIsDocument] = useState(false);
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [docInfo, setDocInfo] = useState<DocumentInfo | null>(null);
  const [target, setTarget] = useState<ConvertTarget>("mp4");
  const [docTarget, setDocTarget] = useState<DocumentTarget>("pdf");
  const job = useJob();

  async function handlePick() {
    const picked = await window.api.dialog.pickMediaFile();
    if (!picked) return;

    const document = isDocumentFile(picked);
    setInputPath(picked);
    setIsDocument(document);
    setInfo(null);
    setDocInfo(null);
    job.reset();

    // Probing right away surfaces problems (e.g. an unreadable file) before
    // the user waits on a conversion that cannot work.
    if (document) {
      const probed = await window.api.document.probe(picked);
      if (probed.ok) {
        setDocInfo(probed.info);
        setDocTarget(probed.info.format === "pdf" ? "docx" : "pdf");
      } else {
        job.setError(probed.error);
      }
      return;
    }

    const probed = await window.api.convert.probe(picked);
    if (probed.ok) setInfo(probed.info);
    else job.setError(probed.error);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!inputPath || job.running) return;

    job.reset();

    if (isDocument) {
      const savePath = await window.api.dialog.pickSavePath(baseName(inputPath), docTarget);
      if (!savePath) return;
      await job.run((jobId) =>
        window.api.document.run({ jobId, inputPath, target: docTarget, savePath }),
      );
      return;
    }

    const savePath = await window.api.dialog.pickSavePath(baseName(inputPath), target);
    if (!savePath) return;

    await job.run((jobId) => window.api.convert.run({ jobId, inputPath, target, savePath }));
  }

  const ffmpegReady = status.status?.ffmpeg.available ?? false;
  const canSubmit = job.running || !inputPath || (!isDocument && !ffmpegReady);

  return (
    <div>
      <h1 className={styles.heading}>Converter</h1>
      <p className={styles.subheading}>
        Wandelt Video-, Audio-, Bild- und Dokumentdateien (PDF, DOCX, TXT) um. Alles Nötige ist in
        der App enthalten — es muss nichts installiert werden.
      </p>

      {!ffmpegReady && !status.loading && (
        <p className={styles.subheading}>
          ffmpeg steht auf dieser Plattform nicht zur Verfügung. Setze die Umgebungsvariablen
          FFMPEG_PATH und FFPROBE_PATH, um eine eigene Installation zu verwenden. Die
          Dokumentenkonvertierung ist davon nicht betroffen.
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
        {isDocument ? (
          <select
            className={styles.select}
            value={docTarget}
            onChange={(event) => setDocTarget(event.target.value as DocumentTarget)}
            disabled={job.running}
          >
            {DOCUMENT_TARGET_OPTIONS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        ) : (
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
        )}
        <button className={styles.button} type="submit" disabled={canSubmit}>
          {job.running ? "Konvertiert..." : "Konvertieren"}
        </button>
      </form>

      {info && <p className={styles.fileDetails}>{describeMedia(info)}</p>}
      {docInfo && <p className={styles.fileDetails}>{describeDocument(docInfo)}</p>}

      <JobStatus job={job} successVerb="konvertiert" onCancel={job.cancel} />
    </div>
  );
}
