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
}

export interface PptxDoc {
  kind: 'pptx';
  name: string;
  slides: PptxSlide[];
  /** True when more slides exist than were embedded (payload cap). */
  truncated?: boolean;
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
