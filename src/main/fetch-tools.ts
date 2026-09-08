/**
 * In-process mirror of the official mcp-server-fetch server
 * (https://github.com/modelcontextprotocol/servers/tree/main/src/fetch).
 *
 * Tool: fetch — schema, robots.txt handling, HTML→markdown extraction,
 * `max_length`/`start_index` truncation and error text aligned with
 * src/fetch/src/mcp_server_fetch/server.py.
 */

export type FetchToolResult = { content: string; isError: boolean };

export const FETCH_TOOLS = new Set(['fetch']);

export interface FetchToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  server: string;
}

export const FETCH_TOOL_DEFS: FetchToolDef[] = [
  {
    name: 'fetch',
    description:
      'Fetches a URL from the internet and optionally extracts its contents as markdown.\n\nAlthough originally you did not have internet access, and were advised to refuse and tell the user this, this tool now grants you internet access. Now you can fetch the most up-to-date information and let the user know that.',
    inputSchema: {
      type: 'object',
      title: 'Fetch',
      properties: {
        url: { title: 'Url', type: 'string', format: 'uri', description: 'URL to fetch' },
        max_length: {
          title: 'Max Length',
          type: 'integer',
          description: 'Maximum number of characters to return.',
          default: 5000,
          exclusiveMinimum: 0,
          exclusiveMaximum: 1000000,
        },
        start_index: {
          title: 'Start Index',
          type: 'integer',
          description:
            'On return output starting at this character index, useful if a previous fetch was truncated and more context is required.',
          default: 0,
          minimum: 0,
        },
        raw: {
          title: 'Raw',
          type: 'boolean',
          description: 'Get the actual HTML content of the requested page, without simplification.',
          default: false,
        },
      },
      required: ['url'],
    },
    server: 'fetch',
  },
];

const UA_AUTONOMOUS = 'ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)';
const UA_TOKEN = 'ModelContextProtocol';

const S = (v: unknown): string => (typeof v === 'string' ? v : '');
const N = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function robotsUrlFor(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}/robots.txt`;
}

/** Minimal Protego-style robots.txt: group matching + Allow/Disallow globs. */
function canFetchRobots(robotsTxt: string, url: string, userAgent: string): boolean {
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const path = new URL(url).pathname;
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; pattern: string }> }> = [];
  let current: { agents: string[]; rules: Array<{ allow: boolean; pattern: string }> } | null = null;
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (current) groups.push(current);
      current = { agents: [value.toLowerCase()], rules: [] };
    } else if (current && (field === 'allow' || field === 'disallow')) {
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  if (current) groups.push(current);

  const ua = userAgent.toLowerCase();
  let group: typeof current = null;
  for (const g of groups) {
    if (g.agents.some((a) => a === '*' || ua.includes(a) || a.includes('mcp') || a.includes('modelcontextprotocol'))) {
      group = g;
      break;
    }
  }
  if (!group || group.rules.length === 0) return true;

  const matchLen = (pattern: string): number => {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$') + '$');
    return re.test(path) ? pattern.length : -1;
  };
  let best = -1;
  let allow = true;
  for (const r of group.rules) {
    const ml = matchLen(r.pattern);
    if (ml > best) {
      best = ml;
      allow = r.allow;
    }
  }
  if (best < 0) return true;
  if (!allow) return false;
  const disallowLonger = group.rules.some((r) => !r.allow && matchLen(r.pattern) > best);
  return !disallowLonger;
}

async function checkRobots(url: string): Promise<void> {
  const robotsUrl = robotsUrlFor(url);
  let res: Response;
  try {
    res = await fetch(robotsUrl, {
      headers: { 'User-Agent': UA_AUTONOMOUS },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`Failed to fetch robots.txt ${robotsUrl} due to a connection issue`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `When fetching robots.txt (${robotsUrl}), received status ${res.status} so assuming that autonomous fetching is not allowed, the user can try manually fetching by using the fetch prompt`,
    );
  }
  if (res.status >= 400 && res.status < 500) return;
  const robotsTxt = await res.text();
  if (!canFetchRobots(robotsTxt, url, UA_AUTONOMOUS)) {
    throw new Error(
      `The sites robots.txt (${robotsUrl}), specifies that autonomous fetching of this page is not allowed, ` +
      `<useragent>${UA_AUTONOMOUS}</useragent>\n` +
      `<url>${url}</url>` +
      `<robots>\n${robotsTxt}\n</robots>\n` +
      'The assistant must let the user know that it failed to view the page. The assistant may provide further guidance based on the above information.\n' +
      'The assistant can tell the user that they can try manually fetching the page by using the fetch prompt within their UI.',
    );
  }
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©',
    reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘',
    rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', ensp: ' ',
    emsp: ' ', thinsp: ' ', laquo: '«', raquo: '»', frac12: '½', frac14: '¼',
    frac34: '¾', times: '×', divide: '÷', deg: '°', plusmn: '±',
  };
  return text.replace(/&#(x[0-9a-fA-F]+|\d+);|&([a-zA-Z][a-zA-Z0-9]+);/g, (m, num, name) => {
    if (num) return String.fromCodePoint(num.startsWith('x') ? parseInt(num.slice(1), 16) : parseInt(num, 10));
    return named[name] ?? m;
  });
}

/**
 * Readability-lite + markdownify-style conversion to ATX markdown (no DOM,
 * so the main/body selection and interactive-element stripping are regex-based).
 */
function htmlToMarkdown(html: string): string {
  if (!html) return '';
  const strip = (src: string, tags: string[]): string => {
    let out = src;
    for (const tag of tags) {
      out = out.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    }
    return out;
  };
  let doc = html;
  // Prefer <main>, then <article>, then <body>, else the whole document.
  const main = doc.match(/<main[^>]*>([\s\S]*)<\/main>/i);
  let body: string;
  if (main) body = main[1];
  else {
    const art = doc.match(/<article[^>]*>([\s\S]*)<\/article>/i);
    if (art) body = art[1];
    else {
      const b = doc.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      body = b ? b[1] : doc;
    }
  }
  body = strip(body, ['script', 'style', 'noscript', 'template', 'iframe', 'frame', 'object', 'embed', 'svg', 'form', 'nav', 'header', 'footer', 'aside', 'select', 'textarea']);

  body = body
    // Block boundaries to newlines.
    .replace(/<\/(p|div|li|h[1-6]|pre|blockquote|tr|ul|ol|table|section|figure|figcaption)>/gi, '\n')
    .replace(/<(br|hr)[^>]*>/gi, '\n')
    // Headings.
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, inner) => `${'#'.repeat(Number(n))} ${htmlToTextPass(inner)}\n`)
    // List items.
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `- ${htmlToTextPass(inner)}\n`)
    // Blockquotes.
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) => `> ${htmlToTextPass(stripQuotes(inner))}\n`.replace(/\n/g, '\n> '))
    // Images.
    .replace(/<img[^>]*>/gi, (m) => {
      const src = /src=["']([^"']*)/i.exec(m)?.[1] ?? '';
      const alt = /alt=["']([^"']*)/i.exec(m)?.[1] ?? '';
      return alt || src ? `![${alt || ''}](${src})\n` : '';
    })
    // Links.
    .replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
      const t = htmlToTextPass(inner).trim();
      return t && t !== href ? `[${t}](${href})` : (t || href);
    })
    // Inline emphasis.
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `**${htmlToTextPass(inner)}**`)
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `*${htmlToTextPass(inner)}*`)
    .replace(/<(code|pre)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `\`${htmlToTextPass(inner).trim()}\``);

  // Any tags surviving the conversions above are inert formatting cruft.
  body = body.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');

  return normalizeText(body);
}

function stripQuotes(src: string): string {
  return src.replace(/<blockquote[^>]*>|<\/blockquote>/gi, '');
}

function htmlToTextPass(src: string): string {
  return decodeEntities(
    src
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<\/?(script|style)[^>]*>[\s\S]*?<\/(script|style)>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

function normalizeText(src: string): string {
  return decodeEntities(src)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchUrl(url: string, forceRaw: boolean): Promise<{ content: string; prefix: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA_AUTONOMOUS },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`Failed to fetch ${url}: ${String(e)}`);
  }
  if (res.status >= 400) {
    throw new Error(`Failed to fetch ${url} - status code ${res.status}`);
  }
  const pageRaw = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  const isPageHtml = pageRaw.slice(0, 100).toLowerCase().includes('<html') || contentType.includes('text/html') || !contentType;
  if (isPageHtml && !forceRaw) {
    const md = htmlToMarkdown(pageRaw);
    if (!md) return { content: '<error>Page failed to be simplified from HTML</error>', prefix: '' };
    return { content: md, prefix: '' };
  }
  return {
    content: pageRaw,
    prefix: `Content type ${contentType} cannot be simplified to markdown, but here is the raw content:\n`,
  };
}

function validateArgs(a: Record<string, unknown>): { url: string; maxLength: number; startIndex: number; raw: boolean } {
  const url = S(a.url);
  if (!url) throw new Error('URL is required');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Input should be a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Input should be a valid URL`);
  }
  const maxLength = N(a.max_length) ?? 5000;
  if (maxLength <= 0 || maxLength >= 1000000) throw new Error('Input should be less than 1000000');
  const startIndex = N(a.start_index) ?? 0;
  if (startIndex < 0) throw new Error('Input should be greater than or equal to 0');
  return { url, maxLength, startIndex, raw: a.raw === true };
}

export async function callFetchTool(name: string, args: unknown): Promise<FetchToolResult> {
  if (name !== 'fetch') return { content: `Unknown tool: ${name}`, isError: true };
  let a: { url: string; maxLength: number; startIndex: number; raw: boolean };
  try {
    a = validateArgs((args ?? {}) as Record<string, unknown>);
  } catch (e) {
    return { content: e instanceof Error ? e.message : String(e), isError: true };
  }
  try {
    await checkRobots(a.url);
    const { content, prefix } = await fetchUrl(a.url, a.raw);
    const originalLength = content.length;
    let out = content;
    if (a.startIndex >= originalLength) {
      out = '<error>No more content available.</error>';
    } else {
      const truncated = content.slice(a.startIndex, a.startIndex + a.maxLength);
      if (!truncated) {
        out = '<error>No more content available.</error>';
      } else {
        out = truncated;
        const remaining = originalLength - (a.startIndex + truncated.length);
        if (truncated.length === a.maxLength && remaining > 0) {
          out += `\n\n<error>Content truncated. Call the fetch tool with a start_index of ${a.startIndex + truncated.length} to get more content.</error>`;
        }
      }
    }
    return { content: `${prefix}Contents of ${a.url}:\n${out}`, isError: false };
  } catch (e) {
    return { content: e instanceof Error ? e.message : String(e), isError: true };
  }
}