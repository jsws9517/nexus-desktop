/**
 * Minimal-but-sufficient Markdown-ish renderer for chat output.
 *
 * Kept dependency-free (CSP `script-src 'self'`), unit-testable pure functions.
 * Supports: fenced code (+lang badge + copy button), diff blocks, headings,
 * lists, horizontal rules, inline code/bold/links, images (data:/blob:/local via
 * IPC hydration), GitHub-style tables and task checklists.
 */

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(s: string): string {
  return esc(s);
}

const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

export function renderInline(src: string): string {
  // Images first (data:/blob: inline, local paths get a data-src for hydration).
  let out = src.replace(IMG_RE, (m, alt, url) => {
    if (/^(data:|blob:|https?:\/\/)/.test(url)) {
      return `<img alt="${esc(String(alt))}" src="${esc(url)}" loading="lazy" />`;
    }
    if (url.startsWith('local:')) {
      return `<img alt="${esc(String(alt))}" data-src="${esc(url.slice(6))}" loading="lazy" />`;
    }
    return m;
  });
  out = out
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(LINK_RE, '<a href="$2" target="_blank">$1</a>');
  return out;
}

function renderDiff(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const cls = line.startsWith('+')
        ? 'style="color:#7bc96f"'
        : line.startsWith('-')
          ? 'style="color:#e05a5a"'
          : line.startsWith('@@')
            ? 'style="color:#4f8cff"'
            : '';
      return cls ? `<div ${cls}>${escapeHtml(line)}</div>` : escapeHtml(line);
    })
    .join('\n');
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

/** Parse a run of consecutive `|…|` lines starting at index i. Returns rows. */
function collectTable(lines: string[], i: number): { rows: string[][]; end: number } | null {
  if (!lines[i].includes('|')) return null;
  const rows: string[][] = [];
  let j = i;
  while (j < lines.length && lines[j].trim() !== '' && lines[j].includes('|')) {
    const cells = lines[j]
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    rows.push(cells);
    j++;
  }
  if (rows.length < 2 || !isTableSeparator(rows[1].join('|'))) return null;
  return { rows, end: j };
}

function renderTable(rows: string[][]): string {
  const header = rows[0];
  const body = rows.slice(2);
  const thead = `<thead><tr>${header.map((h) => `<th>${renderInline(escapeHtml(h))}</th>`).join('')}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body
        .map(
          (r) =>
            `<tr>${r
              .map((c, idx) => {
                const tag = idx === 0 ? 'th' : 'td';
                return `<${tag}>${renderInline(escapeHtml(c))}</${tag}>`;
              })
              .join('')}</tr>`,
        )
        .join('')}</tbody>`
    : '';
  return `<table class="md-table">${thead}${tbody}</table>`;
}

export function renderBlocks(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let i = 0;
  let inFence = false;
  let fenceLang = '';
  let code: string[] = [];

  const flushCode = () => {
    if (code.length > 0) {
      const joined = code.join('\n');
      if (fenceLang === 'diff') {
        out.push(`<div class="code-block"><pre>${renderDiff(joined)}</pre></div>`);
      } else {
        const lang = fenceLang || '';
        out.push(
          `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(lang)}</span>` +
            `<button class="code-copy" type="button">Copy</button></div>` +
            `<pre><code>${escapeHtml(joined)}</code></pre></div>`,
        );
      }
      code = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```([\w+-]*)\s*$/.exec(line.trim());
    if (fence) {
      if (inFence) {
        flushCode();
        inFence = false;
        fenceLang = '';
      } else {
        inFence = true;
        fenceLang = fence[1];
      }
      i++;
      continue;
    }
    if (inFence) {
      code.push(line);
      i++;
      continue;
    }
    if (/^###\s/.test(line)) out.push(`<h3>${renderInline(line.replace(/^###\s/, ''))}</h3>`);
    else if (/^##\s/.test(line)) out.push(`<h2>${renderInline(line.replace(/^##\s/, ''))}</h2>`);
    else if (/^#\s/.test(line)) out.push(`<h1>${renderInline(line.replace(/^#\s/, ''))}</h1>`);
    else if (/^\s*[-*]\s\[[ xX]\]\s/.test(line)) {
      const checked = /^\s*[-*]\s\[[xX]\]\s/.test(line);
      out.push(
        `<div class="task-item"><input type="checkbox"${checked ? ' checked' : ''} disabled /> ` +
          `${renderInline(line.replace(/^\s*[-*]\s\[[ xX]\]\s/, ''))}</div>`,
      );
    } else if (/^\s*[-*]\s/.test(line)) out.push(`• ${renderInline(line.replace(/^\s*[-*]\s/, ''))}`);
    else if (/^\s*\d+\.\s/.test(line)) out.push(`&nbsp;&nbsp;${renderInline(line)}`);
    else if (/^---+\s*$/.test(line)) out.push('<hr>');
    else if (line.trim() === '') out.push('');
    else if (line.includes('|')) {
      const tbl = collectTable(lines, i);
      if (tbl) {
        out.push(renderTable(tbl.rows));
        i = tbl.end;
        continue;
      }
      out.push(renderInline(escapeHtml(line)));
    } else out.push(renderInline(escapeHtml(line)));
    i++;
  }
  flushCode();
  return out.join('\n');
}

/** Bind copy buttons inside `container` (after its innerHTML was set). */
export function attachCodeCopy(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>('.code-copy').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const code = btn.closest('.code-block')?.querySelector('code, pre');
      const text = code ? code.textContent ?? '' : '';
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          btn.textContent = '✓';
          setTimeout(() => {
            btn.textContent = 'Copy';
          }, 1200);
        })
        .catch(() => {});
    });
  });
}

/**
 * Resolve `<img data-src="path">` (local images the core referenced) to data
 * URLs via the main process. Only images that are already in the DOM get
 * hydrated; failures leave the placeholder (or remove the broken node).
 */
export function hydrateImages(container: HTMLElement): void {
  container.querySelectorAll<HTMLImageElement>('img[data-src]').forEach((img) => {
    if (img.dataset.hydrated) return;
    img.dataset.hydrated = '1';
    const path = img.dataset.src!;
    const api = (window as unknown as { nexusDesktop?: { readImagePreview?: (p: string) => Promise<string> } })
      .nexusDesktop;
    if (!api?.readImagePreview) {
      img.remove();
      return;
    }
    void api
      .readImagePreview(path)
      .then((dataUrl) => {
        img.src = dataUrl;
      })
      .catch(() => {
        img.remove();
      });
  });
}
