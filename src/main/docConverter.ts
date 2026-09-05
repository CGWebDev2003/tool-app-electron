import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, Packer, Paragraph } from "docx";
import mammoth from "mammoth";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import type { DocumentInfo, DocumentTarget, JobResult } from "@shared/types";
import { UserError } from "./converter";

const DOCUMENT_EXTENSIONS: Record<string, DocumentTarget> = {
  pdf: "pdf",
  docx: "docx",
  txt: "txt",
};

export function detectDocumentFormat(inputPath: string): DocumentTarget | null {
  const extension = path.extname(inputPath).slice(1).toLowerCase();
  return DOCUMENT_EXTENSIONS[extension] ?? null;
}

/** Directory pdfjs reads its built-in font metrics from — bundled alongside the library. */
function standardFontDataUrl(): string {
  const packageDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
  return path.join(packageDir, "standard_fonts") + path.sep;
}

async function loadPdfjs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

async function extractPdfText(inputPath: string): Promise<{ text: string; pageCount: number }> {
  const pdfjsLib = await loadPdfjs();
  const data = new Uint8Array(await readFile(inputPath));
  const doc = await pdfjsLib.getDocument({ data, standardFontDataUrl: standardFontDataUrl() })
    .promise;

  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return { text: pages.join("\n\n"), pageCount: doc.numPages };
}

async function extractDocxText(inputPath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: inputPath });
  return result.value;
}

/** Plain text extracted from whatever the source document turns out to be. */
async function extractText(
  inputPath: string,
  format: DocumentTarget,
): Promise<{ text: string; pageCount: number | null }> {
  if (format === "txt") {
    return { text: await readFile(inputPath, "utf-8"), pageCount: null };
  }
  if (format === "docx") {
    return { text: await extractDocxText(inputPath), pageCount: null };
  }
  const { text, pageCount } = await extractPdfText(inputPath);
  return { text, pageCount };
}

export async function probe(inputPath: string): Promise<DocumentInfo> {
  const format = detectDocumentFormat(inputPath);
  if (!format) {
    throw new UserError("Nicht unterstütztes Dokumentformat (nur PDF, DOCX und TXT).");
  }

  const { text, pageCount } = await extractText(inputPath, format);
  return { format, pageCount, characterCount: text.length };
}

/** Splits extracted text back into paragraphs for formats that have them. */
function toParagraphs(text: string): string[] {
  const paragraphs = text.split(/\r?\n/).map((line) => line.trimEnd());
  // A trailing blank line from the source shouldn't become an empty page.
  while (paragraphs.length > 1 && paragraphs[paragraphs.length - 1] === "") paragraphs.pop();
  return paragraphs.length ? paragraphs : [""];
}

const PDF_PAGE_MARGIN = 56;
const PDF_FONT_SIZE = 11;
const PDF_LINE_HEIGHT = 16;

/** Greedy word-wrap so lines fit inside the page's printable width. */
function wrapLine(line: string, font: PDFFont, maxWidth: number): string[] {
  if (line === "") return [""];
  const words = line.split(" ");
  const wrapped: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, PDF_FONT_SIZE) > maxWidth && current) {
      wrapped.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) wrapped.push(current);
  return wrapped;
}

async function writeAsPdf(text: string, savePath: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pageWidth = 595.28; // A4
  const pageHeight = 841.89;
  const maxWidth = pageWidth - PDF_PAGE_MARGIN * 2;

  const lines = toParagraphs(text).flatMap((paragraph) => wrapLine(paragraph, font, maxWidth));

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - PDF_PAGE_MARGIN;

  for (const line of lines) {
    if (y < PDF_PAGE_MARGIN) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - PDF_PAGE_MARGIN;
    }
    page.drawText(line, { x: PDF_PAGE_MARGIN, y, size: PDF_FONT_SIZE, font });
    y -= PDF_LINE_HEIGHT;
  }

  await writeFile(savePath, await doc.save());
}

async function writeAsDocx(text: string, savePath: string): Promise<void> {
  const paragraphs = toParagraphs(text).map((line) => new Paragraph(line));
  const doc = new Document({ sections: [{ children: paragraphs }] });
  await writeFile(savePath, await Packer.toBuffer(doc));
}

async function writeAsTxt(text: string, savePath: string): Promise<void> {
  await writeFile(savePath, text, "utf-8");
}

export async function convert(options: {
  jobId: string;
  inputPath: string;
  target: DocumentTarget;
  savePath: string;
  onProgress: (percent: number | null, message: string) => void;
}): Promise<JobResult> {
  const { inputPath, target, savePath, onProgress } = options;

  if (path.resolve(inputPath) === path.resolve(savePath)) {
    return { ok: false, error: "Quell- und Zieldatei dürfen nicht identisch sein." };
  }

  try {
    onProgress(null, "Dokument wird gelesen...");
    const format = detectDocumentFormat(inputPath);
    if (!format) {
      return { ok: false, error: "Nicht unterstütztes Dokumentformat (nur PDF, DOCX und TXT)." };
    }

    const { text } = await extractText(inputPath, format);

    onProgress(null, "Dokument wird erstellt...");
    if (target === "pdf") await writeAsPdf(text, savePath);
    else if (target === "docx") await writeAsDocx(text, savePath);
    else await writeAsTxt(text, savePath);

    onProgress(100, "Fertig.");
    return { ok: true, outputPath: savePath };
  } catch (error) {
    if (error instanceof UserError) {
      return { ok: false, error: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("document conversion failed", message);
    return { ok: false, error: message || "Konvertierung fehlgeschlagen." };
  }
}
