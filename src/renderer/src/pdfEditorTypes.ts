export type TextElement = {
  id: string;
  kind: "text";
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  color: string;
};

export type ImageElement = {
  id: string;
  kind: "image";
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
};

export type PdfElement = TextElement | ImageElement;

export type PageSize = {
  width: number;
  height: number;
};
