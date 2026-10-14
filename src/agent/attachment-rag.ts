/**
 * Per-session "one-time RAG" store for desktop attachments.
 *
 * A user explicitly RAG-adds files (a flow SEPARATE from the common `+`
 * attach / `@path` inline path). Each eligible file is extracted to text
 * (core extractor registry), chunked, and written into a session-scoped
 * SQLite store under `~/.nexus/attach-rag/<sessionId>.db` — reusing the core
 * VaultStore schema (vault_notes + vault_fts + vault_meta) so retrieval is the
 * same BM25 pipeline the vault uses.
 *
 * The store is transient: cleared on `/clear`, disposed on session delete.
 * On each chat send the worker searches THIS session's store and (Hybrid)
 * auto-injects the top chunks for small sets, or leaves it to the model via
 * the `attachments_search` tool for large sets.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { VaultStore } from 'nexus-coder/dist/src/vault/store.js';
import type { VaultMetaRow } from 'nexus-coder/dist/src/vault/store.js';
import { extractForRag, chunkText, hasExtractor } from 'nexus-coder/dist/src/vault/extract/registry.js';
import { searchVault } from 'nexus-coder/dist/src/vault/retrieval.js';
import type { ParsedNote } from 'nexus-coder/dist/src/vault/parser.js';

export interface AttachmentIngestResult {
  path: string;
  name: string;
  ok: boolean;
  reason?: 'unsupported' | 'binary' | 'empty' | 'error' | 'not-allowed';
  format?: string;
  chunkCount?: number;
  message?: string;
}

export interface AttachmentHit {
  ref: string;
  /** Source file name (chunk titles are `<name> #<n>`). */
  file: string;
  /** 1-based chunk number within the file. */
  chunk: number;
  /** Total chunks in the source file. */
  chunks: number;
  /** Phrase-evidence score (0 = only single-char/noise-level lexical match). */
  boost: number;
  title: string;
  snippet: string;
  score: number;
}

/** Metadata row for one ingested file (alias of the core VaultMetaRow). */
export type AttachmentMeta = VaultMetaRow;

/** One entry of a file's chunk outline. */
export interface OutlineEntry {
  /** 1-based chunk number. */
  n: number;
  /** Nearest heading at or above this chunk (inherited when the chunk has none). */
  heading: string;
}

/** A whole chunk read back verbatim (used for precise follow-up reads). */
export interface ChunkRead {
  file: string;
  n: number;
  chunks: number;
  text: string;
}

/**
 * Auto-inject the retrieved context on send only while the session holds at
 * most this many chunks; beyond it the model uses `attachments_search`
 * explicitly (Hybrid). Keeps a huge attachment set from flooding every turn.
 */
export const ATTACH_AUTO_INJECT_MAX_CHUNKS = 40;
/** Retrieval fan-out and injected-context ceiling for auto-injection. */
export const ATTACH_AUTO_INJECT_TOP_K = 6;
const ATTACH_CONTEXT_MAX_CHARS = 4000;

const stores = new Map<string, VaultStore>();

function dataDir(): string {
  return process.env.NEXUS_CONFIG_DIR || join(homedir(), '.nexus');
}

function safeId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
}

function storePath(sessionId: string): string {
  return join(dataDir(), 'attach-rag', `${safeId(sessionId)}.db`);
}

/** Root ref for a source file (its chunk notes are `<rootRef>:<index>`). */
function rootRef(filePath: string): string {
  return 'attach:' + createHash('sha1').update(filePath).digest('hex').slice(0, 16);
}

/** Open (creating on demand) the session store; cached per worker. */
export function storeFor(sessionId: string): VaultStore {
  const cached = stores.get(sessionId);
  if (cached) return cached;
  mkdirSync(join(dataDir(), 'attach-rag'), { recursive: true });
  const store = new VaultStore(storePath(sessionId));
  stores.set(sessionId, store);
  return store;
}

/** Return the session store only when its db file already exists. */
function readStore(sessionId: string): VaultStore | null {
  const cached = stores.get(sessionId);
  if (cached) return cached;
  if (!existsSync(storePath(sessionId))) return null;
  return storeFor(sessionId);
}

/** Does this session currently hold any ingested attachment? */
export function hasAttachments(sessionId: string): boolean {
  const store = readStore(sessionId);
  return !!store && store.listMeta().length > 0;
}

export function listAttachments(sessionId: string): VaultMetaRow[] {
  return readStore(sessionId)?.listMeta() ?? [];
}

/** Total chunk count across the session's attachments. */
export function totalChunks(sessionId: string): number {
  return listAttachments(sessionId).reduce((n, m) => n + (m.chunkCount || 0), 0);
}

/** Auto-inject only while the session stays under the chunk budget (Hybrid). */
export function withinAutoInjectBudget(sessionId: string): boolean {
  return totalChunks(sessionId) <= ATTACH_AUTO_INJECT_MAX_CHUNKS;
}

/** Query terms for excerpt centring: CJK per char + Latin words (>=2 chars). */
function excerptTokens(query: string): string[] {
  const cjk = Array.from(query).filter((c) => /[\u4e00-\u9fff\u3040-\u30ff]/.test(c));
  const latin = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  return [...latin, ...cjk];
}

/**
 * Phrase-evidence boost for a passage.
 *
 * The store indexes CJK per character (unicode61), so a query like `多模态`
 * matches any chunk containing 多 or 模 — pure noise. Re-scoring on *adjacent*
 * CJK bigrams and whole Latin words restores precision: a passage that actually
 * says 多模态 outranks one that merely mentions 模型.
 */
function phraseBoost(body: string, query: string): number {
  const lower = body.toLowerCase();
  let boost = 0;
  for (const w of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 3 && lower.includes(w)) boost += 3;
  }
  for (const run of query.match(/[\u3400-\u9fff\u3040-\u30ff]{2,}/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) {
      if (lower.includes(run.slice(i, i + 2))) boost += 2;
    }
  }
  return boost;
}

/** Latin words + CJK bigrams, longest evidence first (for excerpt centring). */
function phraseTerms(query: string): string[] {
  const terms: string[] = [];
  for (const w of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 3) terms.push(w);
  }
  for (const run of query.match(/[\u3400-\u9fff\u3040-\u30ff]{2,}/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) terms.push(run.slice(i, i + 2));
  }
  return terms;
}

/**
 * Query-centred excerpt of a chunk body.
 *
 * FTS5's own `snippet()` is only ~26 tokens around the FIRST token hit, which
 * for a multi-word OR query lands on the least informative word and yields a
 * passage the model cannot answer from. This window is larger and centred on
 * the earliest *phrase* hit, falling back to the chunk opening.
 */
function excerpt(body: string, query: string, maxLen = 420): string {
  const flat = body.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!flat) return '';
  if (flat.length <= maxLen) return flat;
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of phraseTerms(query)) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) {
    // No phrase evidence — centre on the first single token so the excerpt at
    // least starts near the (weak) lexical match.
    for (const tok of excerptTokens(query)) {
      const i = lower.indexOf(tok.toLowerCase());
      if (i >= 0) {
        at = i;
        break;
      }
    }
  }
  if (at === -1) return `${flat.slice(0, maxLen)}…`;
  const start = Math.max(0, at - Math.floor(maxLen / 4));
  const end = Math.min(flat.length, start + maxLen);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** Chunk titles are `<file> #<n>`; recover the file name + 1-based chunk no. */
function splitChunkTitle(title: string): { file: string; chunk: number } {
  const m = /^(.*)\s+#(\d+)$/.exec(title);
  return m ? { file: m[1], chunk: Number(m[2]) } : { file: title, chunk: 1 };
}

/**
 * Retrieve the most relevant chunks from the session store.
 *
 * Built on the core `searchVault` pipeline (BM25 + structural fallback + graph)
 * rather than raw `bm25Search`, then diversified per source file: BM25 on
 * chunk-level rows happily returns ten consecutive chunks of one big document
 * and starves every other attachment, which reads to the model as "the results
 * are useless". Round-robin over files with a per-file cap fixes that.
 */
export function search(sessionId: string, query: string, k = ATTACH_AUTO_INJECT_TOP_K): AttachmentHit[] {
  const store = readStore(sessionId);
  if (!store) return [];
  const want = Math.max(1, Math.min(k, 30));
  let rows;
  try {
    // Over-fetch: per-file caps discard some of these.
    rows = searchVault(store, { query, count: Math.min(want * 6, 60) });
  } catch {
    return [];
  }
  if (!rows.length) return [];

  // Ranked per file, then round-robin so the first `want` hits span files.
  const chunkTotals = new Map(listAttachments(sessionId).map((m) => [m.name, m.chunkCount || 0]));
  const byFile = new Map<string, AttachmentHit[]>();
  for (const r of rows) {
    const body = store.getNote(r.ref)?.body ?? r.snippet;
    const { file, chunk } = splitChunkTitle(r.title);
    const hit: AttachmentHit = {
      ref: r.ref,
      file,
      chunk,
      chunks: chunkTotals.get(file) ?? 0,
      title: r.title,
      snippet: excerpt(body, query),
      boost: phraseBoost(body, query),
      score: r.rank,
    };
    const list = byFile.get(file) ?? [];
    list.push(hit);
    byFile.set(file, list);
  }
  // Phrase evidence first, BM25 as tie-break.
  const cmp = (a: AttachmentHit, b: AttachmentHit) => b.boost - a.boost || a.score - b.score;
  for (const list of byFile.values()) list.sort(cmp);
  // Files ordered by their single best hit.
  const files = [...byFile.keys()].sort((a, b) => cmp(byFile.get(a)![0], byFile.get(b)![0]));
  // Cap per file, but always leave room for the other files' best hits.
  const PER_FILE_CAP = Math.max(2, Math.ceil(want / Math.max(1, files.length)) + 1);
  const out: AttachmentHit[] = [];
  for (let round = 0; out.length < want; round++) {
    let progressed = false;
    for (const f of files) {
      const hit = byFile.get(f)![round];
      if (!hit || round >= PER_FILE_CAP) continue;
      out.push(hit);
      progressed = true;
      if (out.length >= want) break;
    }
    if (!progressed) break;
  }
  return out;
}

/**
 * Compact catalogue of what is indexed — used as the tool's fallback so a
 * no-match search still tells the model which files exist and what they cover
 * (instead of returning nothing and pushing it back to shell grep).
 */
export function attachmentIndex(sessionId: string): Array<{ name: string; chunks: number; preview: string }> {
  const store = readStore(sessionId);
  if (!store) return [];
  const rows = store.listMeta();
  const out: Array<{ name: string; chunks: number; preview: string }> = [];
  for (const m of rows) {
    let preview = '';
    try {
      preview = excerpt(store.getNote(`${m.ref}:0`)?.body ?? '', '', 160);
    } catch {
      preview = '';
    }
    out.push({ name: m.name, chunks: m.chunkCount || 0, preview });
  }
  return out;
}

/** First ATX/setext-ish markdown heading inside a chunk body, trimmed. */
function firstHeading(body: string): string {
  const m = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(body);
  return m ? m[1].trim().slice(0, 80) : '';
}

/**
 * Per-chunk outline of every indexed file.
 *
 * The single-file case needs this: top-k retrieval can miss the one chunk that
 * answers the question, and without a way to ask for anything else the model
 * falls back to grepping the file from the shell. Derived from the stored chunk
 * bodies (a chunk with no heading of its own inherits the previous one), so no
 * extra schema and no ingest-time state is required.
 */
export function attachmentOutline(sessionId: string): Array<{ file: string; entries: OutlineEntry[] }> {
  const store = readStore(sessionId);
  if (!store) return [];
  return listAttachments(sessionId).map((m) => {
    const entries: OutlineEntry[] = [];
    let heading = '';
    for (let i = 0; i < (m.chunkCount || 0); i++) {
      let body = '';
      try {
        body = store.getNote(`${m.ref}:${i}`)?.body ?? '';
      } catch {
        body = '';
      }
      const h = firstHeading(body);
      if (h) heading = h;
      entries.push({ n: i + 1, heading });
    }
    return { file: m.name, entries };
  });
}

/**
 * One-line outline rendering, capped so it cannot crowd out the passages.
 *
 * Sections are aggregated (`heading@firstChunk ×N`), not merely de-duplicated:
 * a 24-chunk chapter may have only 7 headings, and listing each heading once
 * would hide the fact that one section spans chunks 3-18 — exactly the range
 * the model needs to know it can ask for.
 */
export function formatOutline(
  outlines: Array<{ file: string; entries: OutlineEntry[] }>,
  maxChars = 700,
): string {
  const parts: string[] = [];
  for (const o of outlines) {
    const groups = new Map<string, { start: number; count: number }>();
    for (const e of o.entries) {
      const label = e.heading || '·';
      const g = groups.get(label);
      if (g) g.count += 1;
      else groups.set(label, { start: e.n, count: 1 });
    }
    const cells = [...groups.entries()].map(
      ([label, g]) => `${label}@${g.start}${g.count > 1 ? `(x${g.count})` : ''}`
    );
    const line = `${o.file}: ${cells.join(' / ')}`;
    if (line.length <= maxChars) parts.push(line);
    else {
      // Keep as many sections as fit rather than truncating mid-word.
      const kept: string[] = [];
      let used = o.file.length + 2;
      for (const c of cells) {
        if (used + c.length + 3 > maxChars) break;
        kept.push(c);
        used += c.length + 3;
      }
      parts.push(
        `${o.file}: ${kept.join(' / ')} …(${groups.size} sections, ${o.entries.length} chunks; call mode="outline" for the full map)`
      );
    }
  }
  const block = parts.join('\n');
  return block.length > maxChars ? `${block.slice(0, maxChars)}…` : block;
}

/**
 * Read whole chunks back verbatim, 1-based, clamped to the file's range.
 * `file` picks which indexed attachment; omitted means the only/first one.
 */
export function chunksByNumber(sessionId: string, file: string | undefined, from: number, count: number): ChunkRead[] {
  const store = readStore(sessionId);
  if (!store) return [];
  const metas = listAttachments(sessionId);
  const meta = file ? metas.find((m) => m.name === file || m.path === file) : metas[0];
  if (!meta) return [];
  const total = meta.chunkCount || 0;
  if (total === 0) return [];
  const start = Math.max(1, Math.min(Math.floor(from) || 1, total));
  const want = Math.max(1, Math.min(Math.floor(count) || 1, 5));
  const out: ChunkRead[] = [];
  for (let n = start; n < start + want && n <= total; n++) {
    let text = '';
    try {
      text = store.getNote(`${meta.ref}:${n - 1}`)?.body ?? '';
    } catch {
      text = '';
    }
    out.push({ file: meta.name, n, chunks: total, text: text.trim() });
  }
  return out;
}

/** Outline allowance inside the injected-context budget. */
const ATTACH_OUTLINE_MAX_CHARS = 700;

/**
 * Format hits into a context block appended to the user turn. The block is
 * stripped by the core before persistence (agent.ts stripExpansionSuffix).
 *
 * A compact outline rides along first: with a single file split into dozens of
 * chunks, top-k alone tells the model nothing about the parts it did NOT get,
 * so it cannot ask for them by name. The outline costs a bounded slice of the
 * budget and is subtracted from the passage allowance.
 */
export function buildContextBlock(
  hits: AttachmentHit[],
  outlines: Array<{ file: string; entries: OutlineEntry[] }> = [],
): string {
  if (!hits.length) return '';
  const outline = outlines.length ? formatOutline(outlines, ATTACH_OUTLINE_MAX_CHARS) : '';
  // Header must start with "Attachment context" — the core strips everything
  // from that marker onward before persisting the turn (agent.ts
  // stripExpansionSuffix). A bare "[Attachment outline]" would NOT match and
  // would leak into the transcript.
  const outlinePart = outline ? `[Attachment context outline]\n${outline}\n\n` : '';
  const passageBudget = Math.max(500, ATTACH_CONTEXT_MAX_CHARS - outlinePart.length);
  const parts = hits.map(
    (h, i) => `[Attachment context ${i + 1} — ${h.file} · chunk ${h.chunk}/${h.chunks || '?'}]\n${h.snippet}`,
  );
  let body = parts.join('\n\n');
  if (body.length > passageBudget) {
    // Drop whole trailing passages first — a half-cut passage is worse than a
    // shorter set of complete ones.
    const kept: string[] = [];
    let used = 0;
    for (const p of parts) {
      if (kept.length && used + p.length > passageBudget) break;
      kept.push(p);
      used += p.length + 2;
    }
    body = kept.join('\n\n');
    if (body.length > passageBudget) body = `${body.slice(0, passageBudget)}…`;
  }
  return '\n\n' + outlinePart + body;
}

/**
 * Extract → chunk → index each path into the session store. `allowlist` is
 * the configured eligible-extension set (lowercased, no dot); a path outside
 * it is reported as `not-allowed` (never silently treated as `@path`).
 */
export function ingestAttachments(
  sessionId: string,
  paths: string[],
  allowlist: string[],
): AttachmentIngestResult[] {
  const allowed = new Set(allowlist.map((e) => e.replace(/^\./, '').toLowerCase()));
  const results: AttachmentIngestResult[] = [];
  for (const raw of paths) {
    const path = String(raw);
    const name = basename(path);
    const ext = extname(path).replace(/^\./, '').toLowerCase();
    if (allowed.size > 0 && !allowed.has(ext)) {
      results.push({ path, name, ok: false, reason: 'not-allowed' });
      continue;
    }
    const extracted = extractForRag(path);
    if (!extracted.ok) {
      results.push({ path, name, ok: false, reason: extracted.reason, message: extracted.message });
      continue;
    }
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(path);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      /* size/mtime are metadata-only */
    }
    try {
      const store = storeFor(sessionId);
      const root = rootRef(path);
      const chunks = chunkText(extracted.text);
      // Re-ingest is idempotent: drop the file's previous chunks first.
      for (const ref of store.allRefs()) {
        if (ref === root || ref.startsWith(root + ':')) store.deleteNote(ref);
      }
      for (const chunk of chunks) {
        const ref = `${root}:${chunk.index}`;
        const note: ParsedNote = {
          ref,
          title: `${name} #${chunk.index + 1}`,
          type: 'attachment',
          tags: [],
          aliases: [],
          wikilinks: [],
          body: chunk.text,
          indexText: chunk.text,
        };
        const hash = createHash('sha1').update(chunk.text).digest('hex');
        store.upsertNote(note, `${name}#${chunk.index + 1}`, hash, mtimeMs);
      }
      store.upsertMeta({
        ref: root,
        path,
        name,
        size,
        ext,
        mtimeMs,
        ingestedAt: new Date().toISOString(),
        chunkCount: chunks.length,
        status: 'ok',
      });
      results.push({ path, name, ok: true, format: extracted.format, chunkCount: chunks.length });
    } catch (err) {
      results.push({ path, name, ok: false, reason: 'error', message: (err as Error).message });
    }
  }
  return results;
}

/**
 * Which extensions the picker may offer, split by whether an extractor exists.
 *
 * The allowlist deliberately still lists pdf/docx/xlsx/pptx: they are the
 * formats users reach for first, and the optional extractor package registers
 * them at runtime without a config change. Until then the UI marks them
 * "needs extension" instead of failing after the file is already picked.
 */
export function ragCapabilities(allowlist: string[]): {
  allowlist: string[];
  supported: string[];
  unsupported: string[];
} {
  const normalized = [...new Set(allowlist.map((e) => e.replace(/^\./, '').toLowerCase()).filter(Boolean))];
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const ext of normalized) (hasExtractor(ext) ? supported : unsupported).push(ext);
  return { allowlist: normalized, supported, unsupported };
}

/** Remove one file's chunks + metadata from the session store. */
export function removeAttachment(sessionId: string, path: string): void {
  const store = readStore(sessionId);
  if (!store) return;
  const root = rootRef(path);
  for (const ref of store.allRefs()) {
    if (ref === root || ref.startsWith(root + ':')) store.deleteNote(ref);
  }
  store.deleteMeta(root);
}

/** Empty the session store's contents (keeps the file for reuse). */
export function clearAttachmentStore(sessionId: string): void {
  readStore(sessionId)?.deleteAll();
}

/** Close + delete the session store (db + WAL/SHM). */
export function disposeAttachmentStore(sessionId: string): void {
  const store = stores.get(sessionId);
  if (store) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    stores.delete(sessionId);
  }
  const p = storePath(sessionId);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(p + suffix, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
