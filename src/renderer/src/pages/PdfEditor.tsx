import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import SignaturePad from "../components/SignaturePad";
import type { ImageElement, PageSize, PdfElement, TextElement } from "../pdfEditorTypes";
import pageStyles from "../styles/page.module.css";
import styles from "./PdfEditor.module.css";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const DEFAULT_FONT_SIZE = 16;
const DEFAULT_TEXT_COLOR = "#171717";

let nextId = 1;
function createId() {
  return `el-${nextId++}`;
}

function hexToRgb01(hex: string) {
  const clean = hex.replace("#", "");
  const value = parseInt(clean, 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  };
}

function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && font.widthOfTextAtSize(candidate, fontSize) > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

function loadImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

type DragState =
  | {
      mode: "move";
      id: string;
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
    }
  | {
      mode: "resize";
      id: string;
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startWidth: number;
      startHeight: number;
    };

export default function PdfEditor() {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [elements, setElements] = useState<PdfElement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fileName, setFileName] = useState("");
  const [status, setStatus] = useState("");
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isSignatureOpen, setIsSignatureOpen] = useState(false);

  const originalBytesRef = useRef<ArrayBuffer | null>(null);
  const canvasRefsRef = useRef<(HTMLCanvasElement | null)[]>([]);
  const dragStateRef = useRef<DragState | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const addOffsetRef = useRef(0);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;

    async function renderPages() {
      const dpr = window.devicePixelRatio || 1;
      for (let i = 0; i < pageSizes.length; i++) {
        if (cancelled || !pdf) return;
        const canvas = canvasRefsRef.current[i];
        if (!canvas) continue;
        const page = await pdf.getPage(i + 1);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: zoom * dpr });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        await page.render({ canvasContext: ctx, viewport }).promise;
      }
    }

    renderPages();
    return () => {
      cancelled = true;
    };
  }, [pdf, pageSizes, zoom]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const drag = dragStateRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const deltaX = (event.clientX - drag.startClientX) / zoom;
      const deltaY = (event.clientY - drag.startClientY) / zoom;

      setElements((current) =>
        current.map((el) => {
          if (el.id !== drag.id) return el;
          if (drag.mode === "move") {
            return { ...el, x: drag.startX + deltaX, y: drag.startY + deltaY };
          }
          return {
            ...el,
            width: Math.max(24, drag.startWidth + deltaX),
            height: Math.max(16, drag.startHeight + deltaY),
          };
        })
      );
    }

    function handlePointerUp(event: PointerEvent) {
      if (dragStateRef.current?.pointerId === event.pointerId) {
        dragStateRef.current = null;
      }
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [zoom]);

  async function handleOpenFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setStatus("PDF wird geladen...");
    setSavedPath(null);
    try {
      const buffer = await file.arrayBuffer();
      originalBytesRef.current = buffer.slice(0);

      const pdfjsLib = await import("pdfjs-dist");
      const workerUrl = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url);
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl.toString();

      const loadingTask = pdfjsLib.getDocument({ data: buffer.slice(0) });
      const doc = await loadingTask.promise;

      const sizes: PageSize[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        sizes.push({ width: viewport.width, height: viewport.height });
      }

      canvasRefsRef.current = new Array(doc.numPages).fill(null);
      setPdf(doc);
      setPageSizes(sizes);
      setElements([]);
      setSelectedId(null);
      setFileName(file.name);
      setStatus("");
    } catch (err) {
      console.error("PDF load failed", err);
      setStatus("PDF konnte nicht geladen werden.");
    }
  }

  function addTextElement() {
    if (pageSizes.length === 0) return;
    const offset = (addOffsetRef.current % 6) * 16;
    addOffsetRef.current += 1;
    const element: TextElement = {
      id: createId(),
      kind: "text",
      pageIndex: 0,
      x: 48 + offset,
      y: 48 + offset,
      width: 220,
      height: 60,
      text: "Text",
      fontSize: DEFAULT_FONT_SIZE,
      color: DEFAULT_TEXT_COLOR,
    };
    setElements((current) => [...current, element]);
    setSelectedId(element.id);
  }

  async function addImageFromDataUrl(dataUrl: string) {
    if (pageSizes.length === 0) return;
    const { width, height } = await loadImageSize(dataUrl);
    const maxWidth = 200;
    const scale = width > maxWidth ? maxWidth / width : 1;
    const offset = (addOffsetRef.current % 6) * 16;
    addOffsetRef.current += 1;
    const element: ImageElement = {
      id: createId(),
      kind: "image",
      pageIndex: 0,
      x: 48 + offset,
      y: 48 + offset,
      width: width * scale,
      height: height * scale,
      src: dataUrl,
    };
    setElements((current) => [...current, element]);
    setSelectedId(element.id);
  }

  function handleImageInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        addImageFromDataUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  }

  function handleSignatureConfirm(dataUrl: string) {
    setIsSignatureOpen(false);
    addImageFromDataUrl(dataUrl);
  }

  function updateElement(id: string, patch: Partial<PdfElement>) {
    setElements((current) =>
      current.map((el) => (el.id === id ? ({ ...el, ...patch } as PdfElement) : el))
    );
  }

  function deleteElement(id: string) {
    setElements((current) => current.filter((el) => el.id !== id));
    setSelectedId((current) => (current === id ? null : current));
  }

  function startDrag(event: React.PointerEvent, element: PdfElement, mode: "move" | "resize") {
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(element.id);
    dragStateRef.current =
      mode === "move"
        ? {
            mode: "move",
            id: element.id,
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startX: element.x,
            startY: element.y,
          }
        : {
            mode: "resize",
            id: element.id,
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startWidth: element.width,
            startHeight: element.height,
          };
  }

  async function handleExport() {
    if (!originalBytesRef.current) return;
    setIsExporting(true);
    setSavedPath(null);
    setStatus("PDF wird vorbereitet...");
    try {
      const doc = await PDFDocument.load(originalBytesRef.current);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const pages = doc.getPages();
      const imageCache = new Map<string, Awaited<ReturnType<typeof doc.embedPng>>>();

      for (const el of elements) {
        const page = pages[el.pageIndex];
        if (!page) continue;
        const { height: pageHeight } = page.getSize();

        if (el.kind === "text") {
          if (!el.text.trim()) continue;
          const lines = wrapText(el.text, font, el.fontSize, el.width);
          const lineHeight = el.fontSize * 1.2;
          const { r, g, b } = hexToRgb01(el.color);
          lines.forEach((line, index) => {
            const baseline = pageHeight - el.y - el.fontSize - index * lineHeight;
            page.drawText(line, {
              x: el.x,
              y: baseline,
              size: el.fontSize,
              font,
              color: rgb(r, g, b),
            });
          });
        } else {
          let image = imageCache.get(el.src);
          if (!image) {
            image = el.src.startsWith("data:image/png")
              ? await doc.embedPng(el.src)
              : await doc.embedJpg(el.src);
            imageCache.set(el.src, image);
          }
          page.drawImage(image, {
            x: el.x,
            y: pageHeight - el.y - el.height,
            width: el.width,
            height: el.height,
          });
        }
      }

      const bytes = await doc.save();

      const savePath = await window.api.dialog.pickSavePath(
        fileName ? `${baseName(fileName)}-bearbeitet` : "bearbeitet",
        "pdf"
      );
      if (!savePath) {
        setStatus("");
        return;
      }

      const result = await window.api.file.writeBytes(savePath, bytes as unknown as Uint8Array);
      if (result.ok) {
        setStatus("");
        setSavedPath(savePath);
      } else {
        setStatus(`Export fehlgeschlagen: ${result.error}`);
      }
    } catch {
      setStatus("Export fehlgeschlagen.");
    } finally {
      setIsExporting(false);
    }
  }

  const selectedElement = elements.find((el) => el.id === selectedId) ?? null;

  return (
    <div className={styles.page}>
      <h1 className={pageStyles.heading}>PDF Bearbeiten</h1>
      <p className={pageStyles.subheading}>
        PDF öffnen, Textfelder und Bilder platzieren, unterschreiben — alles lokal, ohne Upload.
      </p>

      <div className={styles.toolbar}>
        <button
          type="button"
          className={pageStyles.secondaryButton}
          onClick={() => pdfInputRef.current?.click()}
        >
          PDF öffnen
        </button>
        <input
          ref={pdfInputRef}
          type="file"
          accept="application/pdf"
          className={styles.hiddenInput}
          onChange={handleOpenFile}
        />

        <button
          type="button"
          className={pageStyles.secondaryButton}
          onClick={addTextElement}
          disabled={!pdf}
        >
          Textfeld
        </button>

        <button
          type="button"
          className={pageStyles.secondaryButton}
          onClick={() => imageInputRef.current?.click()}
          disabled={!pdf}
        >
          Bild einfügen
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className={styles.hiddenInput}
          onChange={handleImageInputChange}
        />

        <button
          type="button"
          className={pageStyles.secondaryButton}
          onClick={() => setIsSignatureOpen(true)}
          disabled={!pdf}
        >
          Unterschreiben
        </button>

        <div className={styles.zoomGroup}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, Math.round((z - 0.1) * 10) / 10))}
            disabled={!pdf}
          >
            −
          </button>
          <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + 0.1) * 10) / 10))}
            disabled={!pdf}
          >
            +
          </button>
        </div>

        <div className={styles.spacer} />

        <button
          type="button"
          className={pageStyles.button}
          onClick={handleExport}
          disabled={!pdf || isExporting}
        >
          {isExporting ? "Exportiere..." : "Speichern unter..."}
        </button>
      </div>

      {selectedElement?.kind === "text" && (
        <div className={styles.inspector}>
          <label className={styles.inspectorField}>
            Größe
            <input
              type="number"
              min={8}
              max={96}
              value={selectedElement.fontSize}
              onChange={(event) =>
                updateElement(selectedElement.id, {
                  fontSize: Number(event.target.value) || DEFAULT_FONT_SIZE,
                })
              }
            />
          </label>
          <label className={styles.inspectorField}>
            Farbe
            <input
              type="color"
              value={selectedElement.color}
              onChange={(event) => updateElement(selectedElement.id, { color: event.target.value })}
            />
          </label>
          <button
            type="button"
            className={styles.dangerButton}
            onClick={() => deleteElement(selectedElement.id)}
          >
            Löschen
          </button>
        </div>
      )}
      {selectedElement?.kind === "image" && (
        <div className={styles.inspector}>
          <button
            type="button"
            className={styles.dangerButton}
            onClick={() => deleteElement(selectedElement.id)}
          >
            Löschen
          </button>
        </div>
      )}

      {status && <p className={pageStyles.fileDetails}>{status}</p>}
      {savedPath && (
        <div className={styles.successRow}>
          <span className={pageStyles.fileDetails}>
            Gespeichert unter: <code>{savedPath}</code>
          </span>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => void window.api.shell.revealFile(savedPath)}
          >
            Im Ordner anzeigen
          </button>
        </div>
      )}

      {!pdf && <p className={pageStyles.fileDetails}>Öffnen Sie eine PDF-Datei, um zu beginnen.</p>}

      <div className={styles.pagesScroll} onPointerDown={() => setSelectedId(null)}>
        {pageSizes.map((size, pageIndex) => (
          <div
            key={pageIndex}
            className={styles.pageContainer}
            style={{ width: size.width * zoom, height: size.height * zoom }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <canvas
              ref={(el) => {
                canvasRefsRef.current[pageIndex] = el;
              }}
              className={styles.pageCanvas}
            />
            {elements
              .filter((el) => el.pageIndex === pageIndex)
              .map((el) => (
                <div
                  key={el.id}
                  className={`${styles.elementBox} ${selectedId === el.id ? styles.elementSelected : ""}`}
                  style={{
                    left: el.x * zoom,
                    top: el.y * zoom,
                    width: el.width * zoom,
                    height: el.height * zoom,
                  }}
                  onPointerDown={(event) => {
                    if (el.kind === "image") startDrag(event, el, "move");
                    else setSelectedId(el.id);
                  }}
                >
                  {el.kind === "text" ? (
                    <textarea
                      className={styles.textElement}
                      style={{ fontSize: el.fontSize * zoom, color: el.color }}
                      value={el.text}
                      onFocus={() => setSelectedId(el.id)}
                      onChange={(event) => updateElement(el.id, { text: event.target.value })}
                    />
                  ) : (
                    <img src={el.src} alt="" className={styles.imageElement} draggable={false} />
                  )}

                  {selectedId === el.id && (
                    <>
                      <div
                        className={styles.dragHandle}
                        onPointerDown={(event) => startDrag(event, el, "move")}
                        title="Verschieben"
                      >
                        ⠿
                      </div>
                      <button
                        type="button"
                        className={styles.deleteHandle}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => deleteElement(el.id)}
                        title="Löschen"
                      >
                        ×
                      </button>
                      <div
                        className={styles.resizeHandle}
                        onPointerDown={(event) => startDrag(event, el, "resize")}
                        title="Größe ändern"
                      />
                    </>
                  )}
                </div>
              ))}
          </div>
        ))}
      </div>

      {isSignatureOpen && (
        <SignaturePad onCancel={() => setIsSignatureOpen(false)} onConfirm={handleSignatureConfirm} />
      )}
    </div>
  );
}
