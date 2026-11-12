/**
 * PR3 document preview — main-process parsing for docx / xlsx / pptx.
 *
 * The renderer is CSP-restricted, so the binary OOXML work happens here:
 *   - docx: jszip → word/document.xml, hand-rolled OOXML walk
 *     (w:pStyle / w:outlineLvl headings, w:p paragraphs, w:tbl tables)
 *   - xlsx: exceljs (sheet list + cells, 500-row cap)
 *   - pptx: jszip → ppt/slides/slideN.xml a:t text + ppt/media thumbnails
 *
 * The parser functions here are PURE (no Electron import at module top) so
 * they are directly testable under node --test; only
 * `installPreviewDocumentHandlers()` touches Electron/IPC, and it does so via
 * dynamic imports so the pure surface stays import-safe.
 *
 * Cache: an LRU keyed on `path+mtime+size` (see DocCache) — a file touch
 * changes the key, so stale models never surface.
 */

import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { readFile, stat, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { classify, exceedsPreviewCap, formatBytes, MAX_PREVIEW_BYTES, type PreviewKind } from '../shared/preview.js';
import {
  type DocxBlock,
  type DocxDoc,
  type ParsedDocument,
  type PptxDoc,
  type PptxSlide,
  type XlsxDoc,
  type XlsxSheet,
  isDocKind,
  MAX_PPTX_IMAGE_BYTES,
  MAX_PPTX_SLIDES,
  MAX_XLSX_COLS,
  MAX_XLSX_ROWS,
  MAX_XLSX_SHEETS,
} from '../shared/preview-docs.js';
import { logger } from '../shared/logger.js';

// ── XML helpers ─────────────────────────────────────────────────────────────

/** Unescape the entities that appear in OOXML text nodes. */
function unescapeXml(s: string): string {
  return s.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n >= 0 ? String.fromCodePoint(n) : m;
    }
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    return named[code] ?? m;
  });
}

/** Concatenate the visible text of one `<w:p>` paragraph: `w:t` runs plus
 *  `w:tab` (→ '\t') and `w:br`/`w:cr` (→ '\n'). Tag-name checks run before
 *  the `w:t` branch — `<w:tab/>` starts with the same `<w:t` prefix. */
function paragraphText(p: string): string {
  let out = '';
  for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g)) {
    if (m[0].includes(':tab')) out += '\t';
    else if (m[0].includes(':br') || m[0].includes(':cr')) out += '\n';
    else out += unescapeXml(m[1] ?? '');
  }
  return out;
}

/**
 * Heading level for a paragraph, or null.
 * 1) explicit `w:outlineLvl` (locale-proof, 0-based → level = val+1)
 * 2) `w:pStyle` val — the en-US built-in ids "Heading1".."Heading6" (what
 *    python-docx / pandoc / Word itself emit), bare single digits "1".."6",
 *    or localized style ids with a trailing digit ("Überschrift2", "标题2"…).
 */
function headingLevel(p: string): number | null {
  const ol = /<w:outlineLvl\s+w:val="(\d+)"/.exec(p);
  if (ol) {
    const lvl = Number(ol[1]) + 1;
    if (lvl >= 1 && lvl <= 6) return lvl;
  }
  const ps = /<w:pStyle\s+w:val="([^"]+)"/.exec(p);
  if (ps) {
    const v = ps[1];
    const bare = /^([1-6])$/.exec(v);
    if (bare) return Number(bare[1]);
    const m = /([1-6])$/.exec(v);
    if (m && /heading|title|titre|titolo|berschrift|标题|見出し|заголов/i.test(v)) return Number(m[1]);
  }
  return null;
}

/**
 * Nesting-aware scan: find the top-level `<w:tbl>` blocks of the document
 * body (i.e. not inside another table) as full subtrees, in document order.
 * A single pass over open/close tags with a depth counter — unlike a lazy
 * regex, which would pair the outer open with the inner close.
 */
function topLevelTables(xml: string): Array<{ start: number; end: number; xml: string }> {
  const out: Array<{ start: number; end: number; xml: string }> = [];
  let depth = 0;
  let openStart = -1;
  for (const m of xml.matchAll(/<w:tbl(?:\s[^>]*)?>|<\/w:tbl>/g)) {
    const idx = m.index ?? 0;
    if (m[0].startsWith('</')) {
      if (depth > 0) {
        depth--;
        if (depth === 0) out.push({ start: openStart, end: idx + m[0].length, xml: xml.slice(openStart, idx + m[0].length) });
      }
    } else {
      if (depth === 0) openStart = idx;
      depth++;
    }
  }
  return out;
}

/**
 * Extract one table's rows (row-major strings) from its complete subtree.
 * When the subtree contains a nested `<w:tbl`, the plan's fallback applies:
 * the whole table is emitted as a single raw-text cell. Row/cell regexes
 * only run on flat tables, so they can never mis-match across nesting.
 */
function extractTable(subtree: string): string[][] {
  const nestedOpens = (subtree.match(/<w:tbl[\s>]/g) ?? []).length;
  if (nestedOpens >= 2) {
    // 1 = this table's own open tag; ≥2 means a nested table is present.
    // Plan fallback: the whole nested structure becomes a single raw-text
    // cell — one entry per inner paragraph, newline-joined.
    const paras = [...subtree.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
      .map((pm) => paragraphText(pm[1] ?? '').trim())
      .filter((t) => t.length > 0);
    return [[paras.join('\n')]];
  }
  const rows: string[][] = [];
  for (const rowM of subtree.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)) {
    const cells: string[] = [];
    for (const cellM of rowM[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)) {
      const paras = [...cellM[1].matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
        .map((pm) => paragraphText(pm[1]).trim())
        .filter((t) => t.length > 0);
      cells.push(paras.join('\n'));
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Emit heading/paragraph blocks for the plain-paragraph segments of the body. */
function emitParagraphs(seg: string, blocks: DocxBlock[]): void {
  for (const m of seg.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const inner = m[1] ?? '';
    const lvl = headingLevel(inner);
    const text = paragraphText(inner).trim();
    if (lvl && text) blocks.push({ type: 'heading', level: lvl, text });
    else if (text) blocks.push({ type: 'paragraph', text });
  }
}

/** Walk the document body in order, interleaving paragraphs and tables. */
function parseDocxBody(xml: string): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  const spans = topLevelTables(xml);
  let cursor = 0;
  for (const span of spans) {
    emitParagraphs(xml.slice(cursor, span.start), blocks);
    const rows = extractTable(span.xml);
    if (rows.length) blocks.push({ type: 'table', rows });
    cursor = span.end;
  }
  emitParagraphs(xml.slice(cursor), blocks);
  return blocks;
}

/** Parse a .docx (OOXML zip) into the normalized block model. */
export async function parseDocx(buf: Buffer, name: string): Promise<DocxDoc> {
  const zip = await JSZip.loadAsync(buf);
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('not a docx: missing word/document.xml');
  const xml = await doc.async('string');
  const blocks = parseDocxBody(xml);
  const title = blocks.find((b) => b.type === 'heading')?.text;
  return { kind: 'docx', name, title: title || undefined, blocks };
}

// ── xlsx ────────────────────────────────────────────────────────────────────

/** Normalize one exceljs cell to `string | number` (numbers stay numbers so
 *  the viewer can right-align them; everything else normalizes to display
 *  text: rich/text cells → their text, formulas → results, errors → the
 *  error code, dates → ISO strings). */
function normalizeXlsxCell(cell: unknown): string | number {
  const v: unknown = (cell as { value?: unknown } | null)?.value ?? null;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  if (typeof v === 'boolean' || typeof v === 'string') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as { text?: unknown; richText?: Array<{ text?: string }>; result?: unknown; error?: unknown };
    if (typeof o.text === 'string') return o.text;
    if (Array.isArray(o.richText)) return o.richText.map((t) => (t && typeof t.text === 'string' ? t.text : '')).join('');
    if (typeof o.result === 'number') return o.result;
    if (typeof o.error === 'string') return o.error;
    const text = (cell as { text?: unknown }).text;
    return typeof text === 'string' ? text : String(v);
  }
  return String(v);
}

/** Parse a .xlsx via exceljs: sheets + capped cells. */
export async function parseXlsx(buf: Buffer, name: string): Promise<XlsxDoc> {
  const wb = new ExcelJS.Workbook();
  await (wb.xlsx as unknown as { load(data: Buffer): Promise<void> }).load(buf);
  const sheets: XlsxSheet[] = [];
  const sheetCount = Math.min(wb.worksheets.length, MAX_XLSX_SHEETS);
  // Global cell budget keeps a pathological 32×500×200 workbook from
  // materialising a million cells over IPC.
  let cellBudget = 150_000;
  for (let i = 0; i < sheetCount; i++) {
    const ws = wb.worksheets[i];
    const rows: (string | number)[][] = [];
    let truncated = false;
    const rowCount = Math.min(ws.rowCount || 0, MAX_XLSX_ROWS);
    const colCount = Math.min(ws.columnCount || 0, MAX_XLSX_COLS);
    if ((ws.rowCount || 0) > MAX_XLSX_ROWS || (ws.columnCount || 0) > MAX_XLSX_COLS) truncated = true;
    outer: for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      const cells: (string | number)[] = [];
      for (let c = 1; c <= colCount; c++) {
        if (cellBudget-- <= 0) { truncated = true; break outer; }
        cells.push(normalizeXlsxCell(row.getCell(c)));
      }
      rows.push(cells);
    }
    // Drop trailing fully-empty rows (keeps the viewer's DOM lean).
    while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
    if (rows.length) sheets.push({ name: ws.name, rows, truncated });
  }
  return { kind: 'xlsx', name, sheets };
}

// ── pptx ────────────────────────────────────────────────────────────────────

function slideNumber(name: string): number {
  const m = /slide(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}

/** All `a:t` text runs of a slide, document order (title shape first when
 *  present — it is emitted first in the XML by convention). */
function slideTexts(slideXml: string): string[] {
  const out: string[] = [];
  for (const m of slideXml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)) {
    const t = unescapeXml(m[1]).trim();
    if (t) out.push(t);
  }
  return out;
}

const PPTX_IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.emf': 'image/x-emf', '.wmf': 'image/x-wmf', '.svg': 'image/svg+xml',
};

/** First embedded image of a slide (via its rels), base64-embedded when it
 *  fits the payload cap; EMF/WMF vector formats are not inlined. */
async function slideImage(zip: JSZip, slideName: string): Promise<{ image?: string; imageMime?: string }> {
  const relsName = `ppt/slides/_rels/${basename(slideName)}.rels`;
  const rels = zip.file(relsName);
  if (!rels) return {};
  const relsXml = await rels.async('string');
  const m = /Target="(\.\.\/media\/[^"]+)"/.exec(relsXml);
  if (!m) return {};
  let target = m[1];
  try { target = decodeURIComponent(target); } catch { /* keep raw */ }
  const mediaName = `ppt/${target.replace(/^\.\.\//, '')}`;
  const ext = mediaName.slice(mediaName.lastIndexOf('.')).toLowerCase();
  const mime = PPTX_IMAGE_EXT[ext];
  if (!mime || mime.startsWith('image/x-')) return {}; // skip non-inlineable vectors
  const media = zip.file(mediaName);
  if (!media) return {};
  const b64 = await media.async('base64');
  if (b64.length * 0.75 > MAX_PPTX_IMAGE_BYTES) return {};
  return { image: `data:${mime};base64,${b64}`, imageMime: mime };
}

/** Parse a .pptx (OOXML zip) into the normalized slide model. */
export async function parsePptx(buf: Buffer, name: string): Promise<PptxDoc> {
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (!slideNames.length) throw new Error('not a pptx: no slides found');
  const slides: PptxSlide[] = [];
  const total = slideNames.length;
  const limit = Math.min(total, MAX_PPTX_SLIDES);
  for (let i = 0; i < limit; i++) {
    const xml = await zip.file(slideNames[i])!.async('string');
    const texts = slideTexts(xml);
    const img = await slideImage(zip, slideNames[i]);
    slides.push({
      index: slideNumber(slideNames[i]),
      title: texts[0] ?? '',
      bullets: texts,
      image: img.image,
      imageMime: img.imageMime,
    });
  }
  return { kind: 'pptx', name, slides, truncated: total > MAX_PPTX_SLIDES || undefined };
}

// ── dispatch ────────────────────────────────────────────────────────────────

/** Parse any supported document kind from raw bytes (null = unsupported). */
export async function parseDocumentModel(buf: Buffer, kind: PreviewKind, name: string): Promise<ParsedDocument | null> {
  if (!isDocKind(kind)) return null;
  if (kind === 'docx') return parseDocx(buf, name);
  if (kind === 'xlsx') return parseXlsx(buf, name);
  return parsePptx(buf, name);
}

/**
 * Artifact-body-first path (plan 3.3): when the office-write tool returns
 * `{path, content}`, the renderer can pass that body along and we build the
 * model straight from it — no OOXML re-parse.
 *
 *  - docx: markdown-lite (leading `#`+ = heading, blank line = new paragraph)
 *  - pptx: `---` (or blank line) separates slides; first line = title
 *  - xlsx: a text body cannot represent a workbook → null (parse the file)
 */
export function docFromArtifactBody(kind: string, name: string, body: string): ParsedDocument | null {
  const text = body.replace(/\r\n/g, '\n');
  if (kind === 'docx') {
    const blocks: DocxBlock[] = [];
    let para: string[] = [];
    const flush = (): void => {
      const t = para.join('\n').trim();
      if (t) blocks.push({ type: 'paragraph', text: t });
      para = [];
    };
    for (const line of text.split('\n')) {
      const h = /^(#{1,6})\s+(.+)$/.exec(line);
      if (h) { flush(); blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() }); continue; }
      if (!line.trim()) { flush(); continue; }
      para.push(line.replace(/^\s+/, ''));
    }
    flush();
    if (!blocks.length) return null;
    const title = blocks.find((b) => b.type === 'heading')?.text;
    return { kind: 'docx', name, title: title || undefined, blocks };
  }
  if (kind === 'pptx') {
    const slides: PptxSlide[] = [];
    let cur: string[] = [];
    const flush = (): void => {
      if (cur.some((l) => l.trim())) {
        const lines = cur.map((l) => l.trim()).filter(Boolean);
        slides.push({ index: slides.length + 1, title: lines[0], bullets: lines });
      }
      cur = [];
    };
    for (const line of text.split('\n')) {
      if (line.trim() === '---' || !line.trim()) flush();
      else cur.push(line);
    }
    flush();
    if (!slides.length) return null;
    return { kind: 'pptx', name, slides };
  }
  return null; // xlsx — the real workbook must be parsed
}

// ── LRU cache (key = path+mtime+size) ──────────────────────────────────────

export class DocCache {
  private readonly entries = new Map<string, { doc: ParsedDocument }>();
  /** Cache key: the file's identity triple. A touch changes mtime/size →
   *  new key → re-parse; stale entries are simply evicted. */
  static key(path: string, mtimeMs: number, size: number): string {
    return `${path}|${mtimeMs}|${size}`;
  }
  constructor(private readonly max: number = 16) {}
  get(key: string): ParsedDocument | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key);
    this.entries.set(key, e); // refresh LRU position
    return e.doc;
  }
  set(key: string, doc: ParsedDocument): void {
    this.entries.set(key, { doc });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
  clear(): void {
    this.entries.clear();
  }
  get size(): number {
    return this.entries.size;
  }
}

/** Process-wide document cache (bounded; cleared on window close). */
export const docCache = new DocCache(16);

// ── IPC handler (dynamic Electron — keeps the pure surface import-safe) ────

export interface PreviewDocumentResult {
  ok: boolean;
  /** 'parse' (fresh), 'cache' (LRU hit) or 'artifact' (body-first, no parse). */
  source?: 'parse' | 'cache' | 'artifact';
  doc?: ParsedDocument;
  error?: string;
}

/**
 * Register `nexus:previewDocument`. Reuses the preview subsystem's allowed-root
 * + size-cap policy so documents can never be read outside the FileBrowser's
 * reach. The optional `body` implements the artifact-body-first shortcut.
 */
export async function installPreviewDocumentHandlers(): Promise<void> {
  const { ipcMain } = await import('electron');
  const { CHANNELS } = await import('../ipc/channels.js');
  const { isInsideAllowed } = await import('./preview-protocol.js');

  ipcMain.handle(CHANNELS.previewDocument, async (_event, params: unknown): Promise<PreviewDocumentResult> => {
    const p = params as { path?: unknown; body?: unknown } | undefined;
    if (!p || typeof p.path !== 'string' || p.path.length > 4096) {
      return { ok: false, error: 'missing path' };
    }
    let real: string;
    try { real = await realpath(p.path); } catch { return { ok: false, error: 'invalid path' }; }
    const kind = classify(real);
    if (!isDocKind(kind)) return { ok: false, error: `not a document kind: ${kind}` };
    if (!(await isInsideAllowed(real))) return { ok: false, error: 'path outside allowed roots' };

    // Artifact-body-first: skip the OOXML parse entirely when the caller
    // already has the document text (office-write returned {path, content}).
    if (typeof p.body === 'string' && p.body.length > 0) {
      const fromBody = docFromArtifactBody(kind, basename(real), p.body);
      if (fromBody) return { ok: true, doc: fromBody, source: 'artifact' };
    }

    let st: Awaited<ReturnType<typeof stat>>;
    try { st = await stat(real); } catch { return { ok: false, error: 'stat failed' }; }
    if (exceedsPreviewCap(st.size)) {
      return { ok: false, error: `document too large: ${formatBytes(st.size)} exceeds the ${formatBytes(MAX_PREVIEW_BYTES)} cap` };
    }

    const key = DocCache.key(real, st.mtimeMs, st.size);
    const cached = docCache.get(key);
    if (cached) return { ok: true, doc: cached, source: 'cache' };

    let buf: Buffer;
    try { buf = await readFile(real); } catch { return { ok: false, error: 'read failed' }; }
    let doc: ParsedDocument | null;
    try {
      doc = await parseDocumentModel(buf, kind, basename(real));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`preview-docs: parse failed for ${real}: ${msg}`);
      return { ok: false, error: `parse failed: ${msg}` };
    }
    if (!doc) return { ok: false, error: 'parse failed' };
    docCache.set(key, doc);
    return { ok: true, doc, source: 'parse' };
  });
}
