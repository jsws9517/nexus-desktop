/**
 * T7 pdf preview view — renders the file reference + a text preview.
 *
 * The body carries: { path, content?: { title?, text? } }.
 * PDF rendering in the renderer would require a heavy library; instead we
 * show the file reference and any embedded text so the user can confirm what
 * was written before opening the file.
 */

export function mountPdfView(
  container: HTMLElement,
  body: Record<string, unknown>,
): void {
  if (typeof body.path === 'string') {
    const ref = document.createElement('div');
    ref.className = 'artifact-office-ref';
    ref.textContent = `📄 ${body.path}`;
    container.appendChild(ref);
  }

  const content = body.content as { title?: string; text?: string } | undefined;

  if (content?.title) {
    const h2 = document.createElement('h2');
    h2.className = 'artifact-office-title';
    h2.textContent = content.title;
    container.appendChild(h2);
  }

  if (content?.text) {
    const pre = document.createElement('pre');
    pre.className = 'artifact-pdf-text';
    // Show first 800 chars as a preview
    pre.textContent = content.text.length > 800
      ? `${content.text.slice(0, 800)}…`
      : content.text;
    pre.title = 'PDF text preview (truncated)';
    container.appendChild(pre);
  }
}
