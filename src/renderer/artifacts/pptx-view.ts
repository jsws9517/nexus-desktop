/**
 * T7 pptx preview view — renders a slide list with title + bullet preview.
 *
 * The body carries: { path, slideCount?, slides?: Array<{ title?, bullets? }> }.
 * Each slide is shown as a compact card. No external library needed.
 */

export function mountPptxView(
  container: HTMLElement,
  body: Record<string, unknown>,
): void {
  const slides = (body.slides ?? []) as Array<{ title?: string; bullets?: string[]; notes?: string }>;

  if (typeof body.path === 'string') {
    const ref = document.createElement('div');
    ref.className = 'artifact-office-ref';
    ref.textContent = `🎞️ ${body.path}`;
    container.appendChild(ref);
  }

  if (typeof body.slideCount === 'number' && slides.length === 0) {
    const meta = document.createElement('div');
    meta.className = 'artifact-meta';
    meta.textContent = `${body.slideCount} slides`;
    container.appendChild(meta);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'artifact-office-slides';

  slides.slice(0, 20).forEach((slide, i) => {
    const card = document.createElement('div');
    card.className = 'artifact-office-slide';

    const label = document.createElement('div');
    label.className = 'artifact-office-slide-label';
    label.textContent = `Slide ${i + 1}`;

    if (slide.title) {
      const title = document.createElement('div');
      title.className = 'artifact-office-slide-title';
      title.textContent = slide.title;
      card.appendChild(label);
      card.appendChild(title);
    }

    if (slide.bullets?.length) {
      const ul = document.createElement('ul');
      ul.className = 'artifact-office-slide-bullets';
      for (const b of slide.bullets.slice(0, 4)) {
        const li = document.createElement('li');
        li.textContent = b;
        ul.appendChild(li);
      }
      card.appendChild(ul);
      if (slide.bullets.length > 4) {
        const more = document.createElement('span');
        more.className = 'artifact-office-slide-more';
        more.textContent = `+${slide.bullets.length - 4} more`;
        card.appendChild(more);
      }
    }

    if (!slide.title && !slide.bullets?.length) {
      card.appendChild(label);
    }

    grid.appendChild(card);
  });

  if (slides.length > 20) {
    const meta = document.createElement('div');
    meta.className = 'artifact-meta';
    meta.textContent = `showing 20 of ${slides.length} slides`;
    grid.appendChild(meta);
  }

  container.appendChild(grid);
}
