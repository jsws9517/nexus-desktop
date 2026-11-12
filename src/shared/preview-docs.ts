/**
 * PR3 document preview — normalized document models for docx / xlsx / pptx.
 *
 * Parsing happens in the MAIN process (src/main/preview-docs.ts) because the
 * renderer is CSP-restricted; the renderer receives one of these plain,
 * structured-clone-friendly models over the `nexus:previewDocument` IPC and
 * lays it out with the doc-canvas system (static/styles.css).
 *
 * Everything in here is serializable: no functions, no Date, no undefined —
 * so the model can cross the IPC boundary intact.
 */

import type { PreviewKind } from './preview.js';

// ── docx ────────────────────────────────────────────────────────────────────

export interface DocxBlock {
  type: 'heading' | 'paragraph' | 'table';
  /** Heading level 1..6 (type 'heading' only). */
  level?: number;
  /** Heading/paragraph text (type 'table' only carries `rows`). */
  text?: string;
  /** Table cells, row-major. Nested tables are flattened into their cell text. */
  rows?: string[][];
}

export interface DocxDoc {
  kind: 'docx';
  name: string;
  /** First heading, when present (used as the doc-canvas title). */
  title?: string;
  blocks: DocxBlock[];
}

// ── xlsx ────────────────────────────────────────────────────────────────────

export interface XlsxSheet {
  name: string;
  /** Row-major cells, capped at MAX_XLSX_ROWS / MAX_XLSX_COLS. Numbers stay
   *  numbers (right-aligned by the viewer); everything else is display text. */
  rows: (string | number)[][];
  /** True when the sheet was truncated to the caps. */
  truncated?: boolean;
}

export interface XlsxDoc {
  kind: 'xlsx';
  name: string;
  sheets: XlsxSheet[];
}

// ── pptx ────────────────────────────────────────────────────────────────────

/** One placed shape on a slide (lightweight layout engine, PR3+).
 *  Coordinates are slide fractions (0 = left/top edge, 1 = right/bottom of
 *  the slide area), so the renderer can position with % regardless of the
 *  rendered canvas size. */
export interface PptxShape {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'text' | 'image' | 'table';
  /** Text shapes: paragraph strings in document order (runs joined). */
  paragraphs?: string[];
  /** First run/defRPr font size in pt (0 = unknown → viewer default). */
  fontPt?: number;
  /** Image shapes: data URL when under the payload cap. */
  image?: string;
  imageMime?: string;
  /** Table shapes: row-major cell text. */
  rows?: string[][];
}

export interface PptxSlide {
  /** 1-based slide number. */
  index: number;
  /** First non-empty text run on the slide (the title shape when present). */
  title: string;
  /** All text runs (`a:t`) in document order, title first. */
  bullets: string[];
  /** Base64 data URL of the slide's first embedded image (ppt/media), when a
   *  rels-mapped image exists and is under MAX_PPTX_IMAGE_BYTES. */
  image?: string;
  imageMime?: string;
  /** Placed shapes (text boxes / pictures / tables with their a:xfrm
   *  geometry). Absent when the slide has no placeable content — the
   *  viewer then falls back to the legacy title + bullets + image layout. */
  shapes?: PptxShape[];
  /** Slide-level `p:bg` background image (data URL), when present. */
  background?: string;
  backgroundMime?: string;
}

export interface PptxDoc {
  kind: 'pptx';
  name: string;
  slides: PptxSlide[];
  /** True when more slides exist than were embedded (payload cap). */
  truncated?: boolean;
  /** Slide size in EMU from `p:sldSz` (defaults to 16:9 when missing). */
  sizeW?: number;
  sizeH?: number;
}

// ── union + caps ────────────────────────────────────────────────────────────

export type ParsedDocument = DocxDoc | XlsxDoc | PptxDoc;

/** Which document kinds go through the main-process parser at all. */
export const DOC_KINDS: PreviewKind[] = ['docx', 'xlsx', 'pptx'];

export function isDocKind(kind: PreviewKind): kind is 'docx' | 'xlsx' | 'pptx' {
  return DOC_KINDS.includes(kind);
}

/** xlsx rendering caps — keep the IPC payload and DOM size bounded. */
export const MAX_XLSX_ROWS = 500;
export const MAX_XLSX_COLS = 200;
export const MAX_XLSX_SHEETS = 32;

/** pptx payload caps. */
export const MAX_PPTX_SLIDES = 60;
/** A slide thumbnail is only embedded when under this size (base64 in IPC). */
export const MAX_PPTX_IMAGE_BYTES = 300 * 1024;
/** Placed shapes embedded per slide (beyond this the tail is dropped). */
export const MAX_PPTX_SHAPES = 24;
/** Document-wide raw-byte budget for NEW shape/background images — keeps
 *  the IPC payload bounded across all 60 slides (legacy per-slide first
 *  image is exempt, as before). */
export const MAX_PPTX_IMAGE_BUDGET_BYTES = 6 * MAX_PPTX_IMAGE_BYTES;
/** 16:9 EMU slide size (the `p:sldSz` default when the element is absent). */
export const PPTX_DEFAULT_SLIDE_W = 12192000;
export const PPTX_DEFAULT_SLIDE_H = 6858000;
