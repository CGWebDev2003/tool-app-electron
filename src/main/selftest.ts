/**
 * End-to-end check of the main-process pipeline, driven exactly the way the UI
 * drives it. Runs inside a real Electron main process because the modules rely
 * on electron's `app` for path resolution.
 *
 *   npm run test
 */
import { app } from "electron";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  describeSpawnError,
  FFMPEG_PATH,
  ffmpegAvailable,
  installYtdlp,
  managedYtdlpPath,
  resolveYtdlp,
  useManualYtdlp,
} from "./binaries";
import * as converter from "./converter";
import * as docConverter from "./docConverter";
import * as youtube from "./youtube";
import { sanitizeFilename } from "./filename";
import { largestFileIn } from "./fsutil";
import type { ConvertTarget } from "@shared/types";

const results: Array<{ name: string; ok: boolean }> = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

function run(binary: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(binary, args);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", (error) => resolve({ code: -1, stderr: error.message }));
    proc.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/** Reads the top-left pixel of an image, to prove what a filter actually did. */
async function firstPixel(ffmpeg: string, imagePath: string): Promise<number[] | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, [
      "-v", "quiet", "-i", imagePath, "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      const data = Buffer.concat(chunks);
      resolve(data.length >= 3 ? [data[0], data[1], data[2]] : null);
    });
  });
}

async function fileSize(filePath: string): Promise<number> {
  return (await stat(filePath).catch(() => null))?.size ?? 0;
}

async function main(): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "toolapp-selftest-"));
  const ffmpeg = FFMPEG_PATH;

  try {
    check("ffmpeg und ffprobe sind einsatzbereit", await ffmpegAvailable(), ffmpeg ?? "kein Pfad");
    if (!ffmpeg) throw new Error("Ohne ffmpeg können die weiteren Prüfungen nicht laufen.");

    // --- Fixtures ---------------------------------------------------------
    const videoFile = path.join(tmp, "video.mp4");
    let result = await run(ffmpeg, [
      "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", videoFile,
    ]);
    check("Testvideo erzeugt", result.code === 0, result.stderr.slice(0, 160));

    const audioFile = path.join(tmp, "audio.mp3");
    result = await run(ffmpeg, [
      "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:a", "libmp3lame", "-y", audioFile,
    ]);
    check("Testaudio erzeugt", result.code === 0, result.stderr.slice(0, 160));

    const coverImage = path.join(tmp, "cover.png");
    await run(ffmpeg, [
      "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=200x200:d=1",
      "-frames:v", "1", "-y", coverImage,
    ]);
    const audioWithCover = path.join(tmp, "audio-cover.mp3");
    result = await run(ffmpeg, [
      "-loglevel", "error", "-i", audioFile, "-i", coverImage,
      "-map", "0:a", "-map", "1:v", "-c", "copy",
      "-disposition:v:0", "attached_pic", "-id3v2_version", "3", "-y", audioWithCover,
    ]);
    check("Testaudio mit Cover-Art erzeugt", result.code === 0, result.stderr.slice(0, 160));

    const imageFile = path.join(tmp, "bild.png");
    result = await run(ffmpeg, [
      "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240",
      "-frames:v", "1", "-y", imageFile,
    ]);
    check("Testbild erzeugt", result.code === 0, result.stderr.slice(0, 160));

    // 40 % red on nothing — the alpha handling below has a known target colour.
    const transparentImage = path.join(tmp, "transparent.png");
    result = await run(ffmpeg, [
      "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red@0.4:s=200x150,format=rgba",
      "-frames:v", "1", "-y", transparentImage,
    ]);
    check("Transparentes Testbild erzeugt", result.code === 0, result.stderr.slice(0, 160));

    // --- probe ------------------------------------------------------------
    const videoInfo = await converter.probe(videoFile);
    check("probe erkennt Video und Audio", videoInfo.hasVideo && videoInfo.hasAudio);
    check(
      "probe liest die Länge aus",
      videoInfo.durationSeconds !== null &&
        videoInfo.durationSeconds > 2.5 &&
        videoInfo.durationSeconds < 3.5,
      String(videoInfo.durationSeconds),
    );

    const audioInfo = await converter.probe(audioFile);
    check("probe erkennt reine Audiodatei", !audioInfo.hasVideo && audioInfo.hasAudio);

    const coverInfo = await converter.probe(audioWithCover);
    check("Cover-Art wird nicht als Videospur gewertet", !coverInfo.hasVideo && coverInfo.hasAudio);

    const imageInfo = await converter.probe(imageFile);
    check(
      "probe erkennt ein Bild",
      imageInfo.isImage && !imageInfo.hasAudio && !imageInfo.hasVideo,
      JSON.stringify(imageInfo),
    );
    check(
      "probe liest die Bildgröße",
      imageInfo.width === 320 && imageInfo.height === 240,
      `${imageInfo.width}x${imageInfo.height}`,
    );
    check("Ein Bild hat keine Dauer", imageInfo.durationSeconds === null);
    check("Ein Video ist kein Bild", !videoInfo.isImage);
    check("Cover-Art gilt nicht als Bilddatei", !coverInfo.isImage && coverInfo.hasCoverArt);

    const brokenFile = path.join(tmp, "broken.mp4");
    await writeFile(brokenFile, "keine Mediendatei");
    const probeRejected = await converter
      .probe(brokenFile)
      .then(() => false)
      .catch(() => true);
    check("Kaputte Datei wird abgewiesen", probeRejected);

    // --- Konvertierungen ---------------------------------------------------
    const cases: Array<[string, string, ConvertTarget]> = [
      ["Video nach MP4", videoFile, "mp4"],
      ["Video nach WebM", videoFile, "webm"],
      ["Video nach MOV", videoFile, "mov"],
      ["Video nach GIF", videoFile, "gif"],
      ["Video nach MP3", videoFile, "mp3"],
      ["Video nach WAV", videoFile, "wav"],
      ["Video nach M4A", videoFile, "m4a"],
      ["Video nach OGG", videoFile, "ogg"],
      ["Audio nach MP4 (schwarzes Bild)", audioFile, "mp4"],
      ["Audio nach WebM (schwarzes Bild)", audioFile, "webm"],
      ["Audio mit Cover nach MP3", audioWithCover, "mp3"],
      ["Audio mit Cover nach MP4", audioWithCover, "mp4"],
      ["Bild nach PNG", imageFile, "png"],
      ["Bild nach JPG", imageFile, "jpg"],
      ["Bild nach WebP", imageFile, "webp"],
      ["Bild nach BMP", imageFile, "bmp"],
      ["Bild nach TIFF", imageFile, "tiff"],
      ["Bild nach GIF", imageFile, "gif"],
      ["Bild nach MP4 (Standbild-Clip)", imageFile, "mp4"],
      ["Video nach PNG (erstes Bild)", videoFile, "png"],
      ["Video nach JPG (erstes Bild)", videoFile, "jpg"],
      ["Cover-Bild aus Audiodatei nach PNG", audioWithCover, "png"],
      ["Transparentes Bild nach JPG", transparentImage, "jpg"],
      ["Transparentes Bild nach WebP", transparentImage, "webp"],
    ];

    let index = 0;
    let sawProgress = false;
    for (const [name, input, target] of cases) {
      const savePath = path.join(tmp, `out-${index++}.${target}`);
      const conversion = await converter.convert({
        jobId: `selftest-${index}`,
        inputPath: input,
        target,
        savePath,
        onProgress: (percent) => {
          if (percent !== null) sawProgress = true;
        },
      });
      const size = conversion.ok ? await fileSize(conversion.outputPath) : 0;
      check(name, conversion.ok && size > 0, conversion.ok ? `${size} Bytes` : conversion.error);
    }
    check("Fortschritt wird gemeldet", sawProgress);

    // --- Bildspezifische Prüfungen -------------------------------------------
    const jpgFromImage = path.join(tmp, "masse.jpg");
    await converter.convert({
      jobId: "selftest-size", inputPath: imageFile, target: "jpg",
      savePath: jpgFromImage, onProgress: () => {},
    });
    const jpgInfo = await converter.probe(jpgFromImage);
    check(
      "Die Bildgröße bleibt erhalten",
      jpgInfo.width === 320 && jpgInfo.height === 240,
      `${jpgInfo.width}x${jpgInfo.height}`,
    );

    // Transparency must be composited onto white, not dropped — dropping it
    // turns a semi-transparent red into full red instead of pink.
    const flattened = path.join(tmp, "flach.jpg");
    await converter.convert({
      jobId: "selftest-flat", inputPath: transparentImage, target: "jpg",
      savePath: flattened, onProgress: () => {},
    });
    const pixel = await firstPixel(ffmpeg, flattened);
    check(
      "Transparenz wird auf Weiß flachgelegt statt verworfen",
      pixel !== null && pixel[0] > 240 && pixel[1] > 130 && pixel[1] < 175 && pixel[2] > 130,
      pixel ? pixel.join(",") : "kein Pixel lesbar",
    );

    const stillClip = path.join(tmp, "standbild.mp4");
    await converter.convert({
      jobId: "selftest-still", inputPath: imageFile, target: "mp4",
      savePath: stillClip, onProgress: () => {},
    });
    const clipInfo = await converter.probe(stillClip);
    check(
      "Ein Bild wird zu einem Video mit Laufzeit",
      clipInfo.hasVideo && clipInfo.durationSeconds !== null && clipInfo.durationSeconds > 4,
      String(clipInfo.durationSeconds),
    );

    // --- Erwartete Fehlerfälle ---------------------------------------------
    const gifPath = path.join(tmp, "unmoeglich.gif");
    const gifFromAudio = await converter.convert({
      jobId: "selftest-gif",
      inputPath: audioFile,
      target: "gif",
      savePath: gifPath,
      onProgress: () => {},
    });
    check("Audio nach GIF meldet einen klaren Fehler", !gifFromAudio.ok);
    check("Nach dem Fehler bleibt keine Datei zurück", (await fileSize(gifPath)) === 0);

    const sameFile = await converter.convert({
      jobId: "selftest-same",
      inputPath: videoFile,
      target: "mp4",
      savePath: videoFile,
      onProgress: () => {},
    });
    check("Identische Quelle und Ziel werden abgelehnt", !sameFile.ok);
    check("Die Quelldatei ist unversehrt", (await fileSize(videoFile)) > 0);

    const imageToAudio = await converter.convert({
      jobId: "selftest-img-audio",
      inputPath: imageFile,
      target: "mp3",
      savePath: path.join(tmp, "bild.mp3"),
      onProgress: () => {},
    });
    check("Bild nach MP3 wird abgelehnt", !imageToAudio.ok, imageToAudio.ok ? "" : imageToAudio.error);

    const audioToImage = await converter.convert({
      jobId: "selftest-audio-img",
      inputPath: audioFile,
      target: "png",
      savePath: path.join(tmp, "ton.png"),
      onProgress: () => {},
    });
    check(
      "Audio ohne Cover nach PNG wird mit Hinweis abgelehnt",
      !audioToImage.ok && audioToImage.error.includes("Cover"),
      audioToImage.ok ? "" : audioToImage.error,
    );

    const videoToAudioOnlySource = await converter.convert({
      jobId: "selftest-noaudio",
      inputPath: coverImage,
      target: "mp3",
      savePath: path.join(tmp, "leer.mp3"),
      onProgress: () => {},
    });
    check("Datei ohne Tonspur nach MP3 wird abgelehnt", !videoToAudioOnlySource.ok);

    // --- Dokumentenkonvertierung --------------------------------------------
    const txtFile = path.join(tmp, "dokument.txt");
    await writeFile(
      txtFile,
      "Erster Absatz mit ein wenig Text.\n\nZweiter Absatz mit noch mehr Text.",
      "utf-8",
    );

    const txtInfo = await docConverter.probe(txtFile);
    check(
      "Dokument-Probe erkennt TXT",
      txtInfo.format === "txt" && txtInfo.pageCount === null && txtInfo.characterCount > 0,
      JSON.stringify(txtInfo),
    );

    const pdfFromTxt = path.join(tmp, "aus-txt.pdf");
    const txtToPdf = await docConverter.convert({
      jobId: "selftest-doc-txt-pdf",
      inputPath: txtFile,
      target: "pdf",
      savePath: pdfFromTxt,
      onProgress: () => {},
    });
    check(
      "TXT nach PDF",
      txtToPdf.ok && (await fileSize(pdfFromTxt)) > 0,
      txtToPdf.ok ? "" : txtToPdf.error,
    );

    const pdfInfo = await docConverter.probe(pdfFromTxt);
    check(
      "Dokument-Probe erkennt PDF und Seitenzahl",
      pdfInfo.format === "pdf" && pdfInfo.pageCount === 1 && pdfInfo.characterCount > 0,
      JSON.stringify(pdfInfo),
    );

    const docxFromPdf = path.join(tmp, "aus-pdf.docx");
    const pdfToDocx = await docConverter.convert({
      jobId: "selftest-doc-pdf-docx",
      inputPath: pdfFromTxt,
      target: "docx",
      savePath: docxFromPdf,
      onProgress: () => {},
    });
    check(
      "PDF nach DOCX",
      pdfToDocx.ok && (await fileSize(docxFromPdf)) > 0,
      pdfToDocx.ok ? "" : pdfToDocx.error,
    );

    const txtFromDocx = path.join(tmp, "aus-docx.txt");
    const docxToTxt = await docConverter.convert({
      jobId: "selftest-doc-docx-txt",
      inputPath: docxFromPdf,
      target: "txt",
      savePath: txtFromDocx,
      onProgress: () => {},
    });
    check(
      "DOCX nach TXT",
      docxToTxt.ok && (await fileSize(txtFromDocx)) > 0,
      docxToTxt.ok ? "" : docxToTxt.error,
    );

    const brokenDoc = path.join(tmp, "kaputt.pdf");
    await writeFile(brokenDoc, "kein PDF");
    const docProbeRejected = await docConverter
      .probe(brokenDoc)
      .then(() => false)
      .catch(() => true);
    check("Kaputtes Dokument wird abgewiesen", docProbeRejected);

    const unsupportedDoc = path.join(tmp, "unbekannt.xyz");
    await writeFile(unsupportedDoc, "egal");
    const docProbeUnsupported = await docConverter
      .probe(unsupportedDoc)
      .then(() => false)
      .catch(() => true);
    check("Unbekanntes Dokumentformat wird abgewiesen", docProbeUnsupported);

    // --- Hilfsfunktionen ----------------------------------------------------
    check("largestFileIn findet die größte Datei", (await largestFileIn(tmp))!.length > 0);
    check(
      "Dateinamen werden für alle Betriebssysteme entschärft",
      sanitizeFilename('a/b\\c:d*e?f"g<h>i|j') === "a_b_c_d_e_f_g_h_i_j",
      sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'),
    );
    check("Leerer Dateiname bekommt einen Ersatz", sanitizeFilename("   ") === "datei");

    // --- URL-Prüfung ---------------------------------------------------------
    const urlCases: Array<[string, boolean]> = [
      ["https://www.youtube.com/watch?v=abc", true],
      ["https://youtu.be/abc", true],
      ["https://music.youtube.com/watch?v=abc", true],
      ["https://evil.example/watch?v=abc", false],
      ["https://youtube.com.evil.example/x", false],
      ["file:///etc/passwd", false],
      ["kein-link", false],
    ];
    for (const [url, expected] of urlCases) {
      check(`URL-Prüfung für ${url}`, youtube.isValidYoutubeUrl(url) === expected);
    }

    // --- Fehlermeldungen ------------------------------------------------------
    const errorCases: Array<[string, string]> = [
      // Regression: /age/ used to match the word "webpage", so every network
      // failure was reported as an age restriction.
      ["Unable to download webpage: Tunnel connection failed: 403 Forbidden", "Verbindung"],
      ["ERROR: [youtube] abc: Private video. Sign in if you've been granted access", "privat"],
      ["ERROR: [youtube] abc: Video unavailable", "nicht verfügbar"],
      ["ERROR: Requested format is not available", "Format"],
      ["ERROR: nsig extraction failed: Some players may be broken", "yt-dlp"],
      ["ERROR: Sign in to confirm your age", "altersbeschränkt"],
    ];
    for (const [raw, expected] of errorCases) {
      const described = youtube.describeYtdlpError(new Error(raw));
      check(
        `Fehlermeldung enthält "${expected}"`,
        described.toLowerCase().includes(expected.toLowerCase()),
        described,
      );
    }
    check(
      "Unbekannte Fehler zeigen die ERROR-Zeile von yt-dlp",
      youtube.describeYtdlpError(new Error("WARNING: irgendwas\nERROR: etwas ganz Neues")) ===
        "etwas ganz Neues",
      youtube.describeYtdlpError(new Error("WARNING: irgendwas\nERROR: etwas ganz Neues")),
    );

    // --- Umgang mit einer kaputten yt-dlp-Datei -------------------------------
    // Genau der Fall, der beim automatischen Installieren scheitern kann.
    const fakeYtdlp = path.join(tmp, process.platform === "win32" ? "fake.exe" : "fake");
    await writeFile(fakeYtdlp, "<html>Proxy-Fehlerseite</html>");
    if (process.platform !== "win32") await chmod(fakeYtdlp, 0o755);
    const manualBroken = await useManualYtdlp(fakeYtdlp);
    check(
      "Eine Datei, die kein yt-dlp ist, wird mit Begründung abgelehnt",
      !manualBroken.ok && manualBroken.error.length > 20,
      manualBroken.ok ? "" : manualBroken.error,
    );

    const missingBinary = await useManualYtdlp(path.join(tmp, "gibtesnicht"));
    check(
      "Eine fehlende Datei nennt den Grund",
      !missingBinary.ok && /nicht gefunden/i.test(missingBinary.error),
      missingBinary.ok ? "" : missingBinary.error,
    );

    const spawnErrors: Array<[NodeJS.ErrnoException, string]> = [
      [Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), "nicht gefunden"],
      [Object.assign(new Error("spawn EACCES"), { code: "EACCES" }), "Ausführungsrechte"],
    ];
    for (const [error, expected] of spawnErrors) {
      check(
        `Spawn-Fehler ${error.code} wird erklärt`,
        describeSpawnError(error).includes(expected),
        describeSpawnError(error),
      );
    }
    // "spawn UNKNOWN" is what a Defender-blocked executable looks like on
    // Windows; only there may it be read that way.
    const unknown = Object.assign(new Error("spawn UNKNOWN"), { code: "UNKNOWN" });
    check(
      "spawn UNKNOWN wird plattformgerecht gedeutet",
      process.platform === "win32"
        ? describeSpawnError(unknown).includes("blockiert")
        : describeSpawnError(unknown) === "spawn UNKNOWN",
      describeSpawnError(unknown),
    );

    check(
      "Der verwaltete Pfad liegt im Benutzerverzeichnis",
      managedYtdlpPath().startsWith(app.getPath("userData")),
      managedYtdlpPath(),
    );

    // --- yt-dlp ---------------------------------------------------------------
    const ytdlp = await resolveYtdlp();
    check(
      "yt-dlp-Status ist abfragbar",
      typeof ytdlp.available === "boolean",
      ytdlp.available ? `${ytdlp.version} (${ytdlp.source})` : "nicht installiert",
    );

    if (!ytdlp.available) {
      const attempt = await youtube.download({
        jobId: "selftest-yt",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        format: "video",
        savePath: path.join(tmp, "video.mp4"),
        onProgress: () => {},
      });
      check(
        "Fehlendes yt-dlp erklärt sich selbst",
        !attempt.ok && attempt.error.includes("yt-dlp"),
        attempt.ok ? "" : attempt.error,
      );
    }

    const invalidUrl = await youtube.download({
      jobId: "selftest-badurl",
      url: "https://evil.example/watch?v=abc",
      format: "video",
      savePath: path.join(tmp, "x.mp4"),
      onProgress: () => {},
    });
    check("Fremde URL wird vor dem Start abgelehnt", !invalidUrl.ok);

    // --- Live-Prüfungen (brauchen Internet): TOOLAPP_LIVE=1 npm run test ------
    if (process.env.TOOLAPP_LIVE === "1") {
      const installed = await installYtdlp().catch((error: unknown) => {
        check("yt-dlp wird heruntergeladen", false, String(error));
        return null;
      });
      if (installed) {
        check("yt-dlp wird heruntergeladen", true, installed.version);

        const liveUrl = process.env.TOOLAPP_LIVE_URL ?? "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
        const title = await youtube.getTitle(liveUrl).catch((error: unknown) => {
          check("Videotitel wird gelesen", false, String(error));
          return null;
        });
        if (title) {
          check("Videotitel wird gelesen", title.length > 0, title);

          const savePath = path.join(tmp, `${title}.m4a`);
          let livePercent = 0;
          const download = await youtube.download({
            jobId: "selftest-live",
            url: liveUrl,
            format: "audio_m4a",
            savePath,
            onProgress: (percent) => {
              if (percent !== null) livePercent = percent;
            },
          });
          const size = download.ok ? await fileSize(download.outputPath) : 0;
          check(
            "Audio wird tatsächlich heruntergeladen",
            download.ok && size > 0,
            download.ok ? `${size} Bytes` : download.error,
          );
          check("Download-Fortschritt erreicht 100%", livePercent === 100, `${livePercent}%`);
        }
      }
    }
  } catch (error) {
    check("Selbsttest lief vollständig durch", false, String(error));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\n${results.length - failed}/${results.length} Prüfungen bestanden`);
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(main);
