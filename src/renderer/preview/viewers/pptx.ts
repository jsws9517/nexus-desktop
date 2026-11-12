/**
 * PR3 viewer for .pptx — renders the main-process-parsed slide model on the
 * doc-canvas: one slide at a time with ←/→ paging (buttons + arrow keys),
 * the embedded slide thumbnail when present, title + text runs. KPI row:
 * total slides / current page.
 */

import type { PreviewState, ViewerHandle } from '../core.js';
import type { PptxDoc, PptxSlide } from '../../../shared/preview-docs.js';
import { docShell, loadDocument } from './doc-shell.js';

export function mountPptxViewer(state: PreviewState): ViewerHandle {
  const shell = docShell(state, 'pptx');
  shell.showLoading();

  void loadDocument(state).then(({ doc, error }) => {
    if (!doc || doc.kind !== 'pptx') {
      shell.showError(error ?? 'Unsupported document');
      return;
    }
    const d = doc as PptxDoc;
    shell.setTitle(d.name || state.name);
    if (!d.slides.length) { shell.showError('No slides found in presentation'); return; }

    let index = 0;
    const total = d.slides.length;

    const pager = document.createElement('div');
    pager.className = 'doc-slide-pager';

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'doc-slide-btn';
    prev.textContent = '←';
    prev.setAttribute('aria-label', 'previous slide');

    const counter = document.createElement('span');
    counter.className = 'doc-slide-counter';

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'doc-slide-btn';
    next.textContent = '→';
    next.setAttribute('aria-label', 'next slide');

    pager.append(prev, counter, next);

    const view = document.createElement('div');
    view.className = 'doc-slide';

    const render = (): void => {
      const slide: PptxSlide = d.slides[index];
      view.replaceChildren();
      if (slide.image) {
        const img = document.createElement('img');
        img.className = 'doc-slide-image';
        img.src = slide.image;
        img.alt = `Slide ${slide.index}`;
        img.draggable = false;
        view.appendChild(img);
      }
      if (slide.title) {
        const t = document.createElement('div');
        t.className = 'doc-slide-title';
        t.textContent = slide.title;
        view.appendChild(t);
      }
      const rest = slide.bullets.slice(1);
      if (rest.length) {
        const ul = document.createElement('ul');
        ul.className = 'doc-slide-bullets';
        for (const b of rest) {
          const li = document.createElement('li');
          li.textContent = b;
          ul.appendChild(li);
        }
        view.appendChild(ul);
      }
      counter.textContent = `${index + 1} / ${total}`;
      prev.disabled = index === 0;
      next.disabled = index === total - 1;
      shell.setKpis([['Slides', total], ['Page', index + 1]]);
    };

    const go = (dir: 1 | -1): void => {
      const target = index + dir;
      if (target < 0 || target >= total) return;
      index = target;
      render();
    };
    prev.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));

    shell.body.append(pager, view);
    shell.body.setAttribute('tabindex', '0'); // ←/→ paging when the view has focus
    shell.body.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    });

    if (d.truncated) {
      const note = document.createElement('div');
      note.className = 'doc-note';
      note.textContent = 'Truncated — showing the first portion of the deck (preview caps).';
      shell.body.appendChild(note);
    }

    render();
  });

  return shell.container;
}
