/**
 * End-to-end check of the main-process pipeline, driven exactly the way the UI
 * drives it. Runs inside a real Electron main process because the modules rely
 * on electron's `app` for path resolution.
 *
 *   npm run test
 */
import { app } from "electron";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FFMPEG_PATH, ffmpegAvailable, installYtdlp, resolveYtdlp } from "./binaries";
import * as converter from "./converter";
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

    const videoToAudioOnlySource = await converter.convert({
      jobId: "selftest-noaudio",
      inputPath: coverImage,
      target: "mp3",
      savePath: path.join(tmp, "leer.mp3"),
      onProgress: () => {},
    });
    check("Datei ohne Tonspur nach MP3 wird abgelehnt", !videoToAudioOnlySource.ok);

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
