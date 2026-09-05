# Tool App

Desktop-Version (Electron) von [`tool-app`](https://github.com/CGWebDev2003/tool-app) mit denselben
zwei Werkzeugen — **YouTube Download** und **Converter** — nur ohne Webserver, ohne Upload und ohne
manuell zu installierende Abhängigkeiten.

## Warum die Portierung

In der Next.js-Version scheiterten beide Werkzeuge daran, dass sie Programme aufriefen, die auf dem
Rechner gar nicht vorhanden waren: Python samt `yt-dlp` für den Download und `ffmpeg`/`ffprobe` für
den Converter. Ohne diese Installation ergab jeder Klick nur eine Fehlermeldung.

Die Electron-App löst das:

- **`ffmpeg` und `ffprobe` sind fest eingebaut** (`ffmpeg-static`, `ffprobe-static`). Es muss nichts
  installiert werden.
- **`yt-dlp` lädt die App auf Knopfdruck selbst herunter** — als eigenständige Programmdatei, für die
  **kein Python** nötig ist. Derselbe Knopf aktualisiert yt-dlp später wieder, was bei YouTube
  regelmäßig nötig ist.

## Schnellstart

```bash
npm install
npm run dev
```

Beim ersten Start auf „yt-dlp installieren" klicken (Dashboard oder Seite „YouTube Download"). Der
Converter ist sofort einsatzbereit.

### Wenn „yt-dlp installieren" fehlschlägt

Die App nennt in dem Fall den konkreten Grund. Der mit Abstand häufigste ist ein **Virenscanner**:
Windows Defender meldet `yt-dlp.exe` regelmäßig fälschlich als Bedrohung und löscht die Datei direkt
nach dem Herunterladen wieder. Zwei Wege führen zum Ziel:

1. yt-dlp in den Ausnahmen des Virenscanners eintragen und erneut auf „yt-dlp installieren" klicken.
2. yt-dlp selbst installieren und über **„Manuell auswählen"** im Programm angeben:

   ```powershell
   winget install yt-dlp.yt-dlp   # Windows — die vollständige ID ist nötig, sonst
                                  # meldet winget mehrere Treffer
   brew install yt-dlp            # macOS
   sudo apt install yt-dlp        # Debian/Ubuntu
   ```

   Der gewählte Pfad wird gespeichert und ab dann verwendet.

Weitere Gründe, die die App unterscheidet: kein Zugang zu github.com (Firewall/Proxy), ein
abgebrochener Download und eine Netzwerksperre, die statt der Datei eine HTML-Seite ausliefert.

Meldet Windows beim Start `spawn UNKNOWN`, ist das derselbe Fall: Windows verweigert das Ausführen
der Datei, weil der Virenscanner sie für Schadsoftware hält. Nachsehen lässt sich das in der
Windows-Sicherheit unter „Viren- und Bedrohungsschutz" → „Schutzverlauf"; dort kann die Datei auch
zugelassen werden.

## Skripte

| Befehl             | Zweck                                                              |
| ------------------ | ------------------------------------------------------------------ |
| `npm run dev`      | Entwicklung mit Hot Reload                                          |
| `npm run build`    | Typprüfung und Produktions-Build nach `out/`                        |
| `npm start`        | Den Produktions-Build starten                                       |
| `npm test`         | Selbsttest der gesamten Verarbeitungskette                          |
| `npm run lint`     | ESLint                                                              |
| `npm run dist`     | Installierbares Paket bauen (NSIS / DMG / AppImage) nach `release/` |

### Hot Reload

`npm run dev` lädt Änderungen sofort nach:

- **Renderer** (React, CSS): Vite HMR aktualisiert die Oberfläche, ohne den Zustand zu verlieren.
- **Main- und Preload-Prozess**: werden neu gebaut, danach startet Electron automatisch neu.

Weil die Navigation über den URL-Hash läuft, bleibt beim Nachladen die geöffnete Seite erhalten.

## Aufbau

```
src/
  main/       Node-Seite: Prozesse starten, Dateien schreiben, Binaries verwalten
    binaries.ts   ffmpeg/ffprobe auflösen, yt-dlp herunterladen und finden
    youtube.ts    yt-dlp steuern, Fortschritt und Fehler übersetzen
    converter.ts  ffprobe-Analyse und ffmpeg-Konvertierung
    ipc.ts        IPC-Handler inklusive Prüfung aller Eingaben
    selftest.ts   Selbsttest (npm test)
  preload/    contextBridge — die einzige Verbindung zum Renderer
  renderer/   React-Oberfläche (Dashboard, YouTube Download, Converter)
  shared/     Typen, die sich beide Seiten teilen
```

Der Renderer hat keinen Zugriff auf Node: `contextIsolation` ist an, `nodeIntegration` aus, und eine
Content-Security-Policy verbietet Code aus fremden Quellen. Alles, was Dateien anfasst, läuft im
Main-Prozess hinter geprüften IPC-Kanälen.

## Unterschiede zur Web-Version

| Web-Version                                   | Desktop-Version                                          |
| --------------------------------------------- | -------------------------------------------------------- |
| Datei per HTTP hochladen, max. 1 GB            | Datei wird direkt vom Pfad gelesen, keine Größengrenze    |
| Ergebnis über den Browser-Download             | Nativer „Speichern unter"-Dialog, frei wählbarer Ort      |
| Kein Fortschritt sichtbar                      | Fortschrittsbalken für Download und Konvertierung         |
| Kein Abbruch möglich                           | Laufende Vorgänge lassen sich abbrechen                   |
| Python + `yt-dlp` selbst installieren          | yt-dlp per Knopfdruck, ohne Python                        |
| `ffmpeg` selbst installieren                   | mitgeliefert                                              |
| Video-Downloads faktisch auf 720p begrenzt     | volle Auflösung (Video und Ton werden zusammengeführt)    |

## Behobene Fehler aus der Web-Version

- **Ohne `ffmpeg` und `yt-dlp` funktionierte gar nichts.** Beides wird jetzt mitgeliefert
  beziehungsweise auf Knopfdruck eingerichtet.
- **MP3s mit Cover-Bild wurden als Video behandelt.** `ffprobe` meldet eingebettete Cover als
  Videospur; die Web-Version hätte daraus ein Video mit Standbild gemacht. Angehängte Bilder werden
  jetzt ignoriert.
- **Die falsche Datei konnte ausgeliefert werden.** Die Web-Version nahm einfach den ersten Eintrag
  des temporären Verzeichnisses. Jetzt wird gezielt die fertige Datei gewählt, Fragmente
  ausgenommen.
- **Verschieben über Laufwerksgrenzen schlug fehl.** `rename()` scheitert zwischen zwei Dateisystemen
  mit `EXDEV`; es gibt jetzt einen Kopier-Fallback.
- **Fehlermeldungen waren irreführend.** Ein Verbindungsproblem wurde als Altersbeschränkung
  gemeldet, weil das Muster `age` auch in „web**page**" passte. Die Zuordnung ist jetzt geordnet und
  trennscharf.
- **Video-Downloads waren auf 720p begrenzt**, weil ohne `ffmpeg` nur fertig gemischte Formate in
  Frage kamen.
- **GIFs waren grob gerastert**, weil ffmpeg ohne eigene Farbpalette auf eine Standardpalette
  zurückfällt. Die Palette wird jetzt aus dem Video selbst erzeugt.
- **Große Dateien belasteten den Speicher.** Der Upload lief komplett durch den Arbeitsspeicher des
  Servers; jetzt liest ffmpeg direkt vom Pfad.

## Selbsttest

```bash
npm test
```

Der Test erzeugt echte Testmedien mit dem mitgelieferten ffmpeg und prüft damit die komplette Kette:
Analyse, alle acht Zielformate, Cover-Art-Erkennung, Fehlerfälle, Fortschrittsmeldungen,
URL-Prüfung und die Übersetzung der yt-dlp-Fehler.

Mit Internetverbindung lässt sich zusätzlich der echte Download prüfen:

```bash
TOOLAPP_LIVE=1 npm test
```

## Konfiguration

Nur nötig, wenn eigene Programmdateien verwendet werden sollen:

| Variable       | Wirkung                                    |
| -------------- | ------------------------------------------ |
| `FFMPEG_PATH`  | Eigenes `ffmpeg` statt des mitgelieferten  |
| `FFPROBE_PATH` | Eigenes `ffprobe` statt des mitgelieferten |
| `YTDLP_PATH`   | Eigenes `yt-dlp`                           |

Ohne `YTDLP_PATH` sucht die App der Reihe nach: die über „Manuell auswählen" gemerkte Datei, die
eigene Kopie unter `userData/bin`, und zuletzt ein `yt-dlp` im System-`PATH`.

## Formate

**YouTube Download:** Video (MP4), Audio (M4A), Audio (MP3)

**Converter:** MP4, WebM, MOV, GIF, MP3, WAV, M4A, OGG. Eine reine Audiodatei in ein Videoformat zu
wandeln erzeugt ein schwarzes Bild als Träger; für ein GIF wird eine Videospur benötigt.
