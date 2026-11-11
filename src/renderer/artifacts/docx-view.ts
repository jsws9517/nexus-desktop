/**
 * T7 docx preview view — renders a lightweight outline + text preview for a
 * .docx artifact without loading the full OOXML package in the renderer.
 *
 * The body carries: { path, content?: { title?, headings?, paragraphs? } }.
 * If `content` is present we render it directly; otherwise we show the file
 * reference and a "save-as" hint. No external library needed.
 */

export function mountDocxView(
  container: HTMLElement,
  body: Record<string, unknown>,
): void {
  const content = body.content as
    | { title?: string; headings?: Array<{ text: string; level?: number }>; paragraphs?: string[] }
    | undefined;

  // File reference banner
  if (typeof body.path === 'string') {
    const ref = document.createElement('div');
    ref.className = 'artifact-office-ref';
    ref.textContent = `📄 ${body.path}`;
    container.appendChild(ref);
  }

  if (!content) {
    // No structured content — just show the file path
    return;
  }

  if (content.title) {
    const h1 = document.createElement('h2');
    h1.className = 'artifact-office-title';
    h1.textContent = content.title;
    container.appendChild(h1);
  }

  const outline = document.createElement('div');
  outline.className = 'artifact-office-outline';

  if (content.headings?.length) {
    const hList = document.createElement('ul');
    for (const h of content.headings) {
      const li = document.createElement('li');
      li.style.marginLeft = `${(h.level ?? 1) - 1} * 1em`;
      li.textContent = h.text;
      if (h.level === 2) li.style.fontWeight = '600';
      hList.appendChild(li);
    }
    outline.appendChild(hList);
  }

  if (content.paragraphs?.length) {
    const pWrap = document.createElement('div');
    pWrap.className = 'artifact-office-paragraphs';
    // Show first 5 paragraphs as preview, rest in a scrollable div
    const preview = content.paragraphs.slice(0, 5);
    for (const p of preview) {
      const el = document.createElement('p');
      el.textContent = p;
      pWrap.appendChild(el);
    }
    if (content.paragraphs.length > 5) {
      const more = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `show remaining ${content.paragraphs.length - 5} paragraphs`;
      const rest = document.createElement('div');
      for (const p of content.paragraphs.slice(5)) {
        const el = document.createElement('p');
        el.textContent = p;
        rest.appendChild(el);
      }
      more.appendChild(summary);
      more.appendChild(rest);
      pWrap.appendChild(more);
    }
    outline.appendChild(pWrap);
  }

  container.appendChild(outline);
}
