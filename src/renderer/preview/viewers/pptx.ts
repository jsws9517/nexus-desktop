/**
 * PR3 viewer for .pptx — renders the main-process-parsed slide model on the
 * doc-canvas: one slide at a time with ←/→ paging (buttons + arrow keys),
 * KPI row: total slides / current page.
 *
 * Two layout modes per slide:
 *   - positioned stage (enhanced layout engine): when the parser produced
 *     placed shapes (a:xfrm geometry), the slide is drawn at its real
 *     aspect ratio (p:sldSz) — shapes at % offsets, text sized in cqw
 *     (pt → cqw conversion), per-slide background image.
 *   - legacy fallback: slides without placeable content keep the old
 *     thumbnail + title + bullets list layout.
 */

import type { PreviewState, ViewerHandle } from '../core.js';
import {
  PPTX_DEFAULT_SLIDE_H,
  PPTX_DEFAULT_SLIDE_W,
  type PptxDoc,
  type PptxShape,
  type PptxSlide,
} from '../../../shared/preview-docs.js';
import { docShell, loadDocument } from './doc-shell.js';
import { t } from '../../i18n.js';

/** pt → cqw conversion at the slide's EMU width (1 in = 914400 EMU = 72 pt:
 *  fontPt pt is fontPt/(W/914400·72) of the slide width = ×100 cqw). */
const cqwPerPtAt = (slideWEmu: number): number => (100 * 914400) / (72 * slideWEmu);

/** A text box at its a:off/a:ext position. The font size is passed as the
 *  `--doc-pptx-pt` custom property — styles.css multiplies it by the
 *  stage's `--doc-pptx-cqw-per-pt` (pt → cqw conversion for the deck's
 *  p:sldSz width) so the type scales with the rendered slide. */
function textShapeEl(shape: PptxShape): HTMLElement {
  const el = document.createElement('div');
  el.className = 'doc-pptx-shape doc-pptx-text';
  el.style.left = `${shape.x * 100}%`;
  el.style.top = `${shape.y * 100}%`;
  el.style.width = `${shape.w * 100}%`;
  el.style.height = `${shape.h * 100}%`;
  const pt = shape.fontPt && shape.fontPt > 0 ? shape.fontPt : 20;
  el.style.setProperty('--doc-pptx-pt', String(pt));
  for (const p of shape.paragraphs ?? []) {
    const para = document.createElement('p');
    para.textContent = p;
    el.appendChild(para);
  }
  return el;
}

/** A picture at its position; over-cap / vector media render as an outlined
 *  placeholder box (the shape's footprint is still visible). */
function imageShapeEl(shape: PptxShape): HTMLElement {
  const el = document.createElement('div');
  el.className = 'doc-pptx-shape doc-pptx-img';
  el.style.left = `${shape.x * 100}%`;
  el.style.top = `${shape.y * 100}%`;
  el.style.width = `${shape.w * 100}%`;
  el.style.height = `${shape.h * 100}%`;
  if (shape.image) {
    const img = document.createElement('img');
    img.src = shape.image;
    img.alt = '';
    img.draggable = false;
    el.appendChild(img);
  } else {
    el.classList.add('empty');
  }
  return el;
}

/** A table shape: compact grid inside the shape's footprint. */
function tableShapeEl(shape: PptxShape): HTMLElement {
  const el = document.createElement('div');
  el.className = 'doc-pptx-shape doc-pptx-table-wrap';
  el.style.left = `${shape.x * 100}%`;
  el.style.top = `${shape.y * 100}%`;
  el.style.width = `${shape.w * 100}%`;
  el.style.height = `${shape.h * 100}%`;
  const table = document.createElement('table');
  table.className = 'doc-pptx-table';
  for (const row of shape.rows ?? []) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  el.appendChild(table);
  return el;
}

/** The positioned slide: real aspect-ratio stage + absolutely-placed shapes.
 *  The aspect comes from `p:sldSz` (doc-level), so a 4:3 deck renders 4:3.
 *  `--doc-pptx-cqw-per-pt` feeds the CSS pt→cqw font scaling. */
function stageEl(
  slide: PptxSlide,
  cqwPerPt: number,
  slideWEmu: number,
  slideHEmu: number,
): HTMLElement {
  const stage = document.createElement('div');
  stage.className = 'doc-pptx-stage';
  stage.dataset.slide = String(slide.index);
  stage.style.aspectRatio = `${slideWEmu} / ${slideHEmu}`;
  stage.style.setProperty('--doc-pptx-cqw-per-pt', String(cqwPerPt));
  if (slide.background) {
    stage.style.backgroundImage = `url(${slide.background})`;
    stage.classList.add('has-bg');
  }
  for (const shape of slide.shapes ?? []) {
    stage.appendChild(
      shape.kind === 'text' ? textShapeEl(shape)
      : shape.kind === 'image' ? imageShapeEl(shape)
      : tableShapeEl(shape),
    );
  }
  return stage;
}

/** The pre-shapes layout: embedded thumbnail (if any) + title + bullets. */
function legacySlideEl(slide: PptxSlide): HTMLElement {
  const el = document.createElement('div');
  el.className = 'doc-pptx-legacy';
  if (slide.image) {
    const img = document.createElement('img');
    img.className = 'doc-slide-image';
    img.src = slide.image;
    img.alt = slide.title || String(slide.index);
    img.draggable = false;
    el.appendChild(img);
  }
  if (slide.title) {
    const h = document.createElement('div');
    h.className = 'doc-slide-title';
    h.textContent = slide.title;
    el.appendChild(h);
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
    el.appendChild(ul);
  }
  return el;
}

export function mountPptxViewer(state: PreviewState): ViewerHandle {
  const shell = docShell(state, 'pptx');
  shell.showLoading();

  void loadDocument(state).then(({ doc, error }) => {
    if (!doc || doc.kind !== 'pptx') {
      shell.showError(error ?? t('docUnsupported'));
      return;
    }
    const d = doc as PptxDoc;
    shell.setTitle(d.name || state.name);
    if (!d.slides.length) { shell.showError(t('docNoSlides')); return; }

    const slideW = d.sizeW ?? PPTX_DEFAULT_SLIDE_W;
    const slideH = d.sizeH ?? PPTX_DEFAULT_SLIDE_H;
    const cqwPerPt = cqwPerPtAt(slideW);

    let index = 0;
    const total = d.slides.length;

    const pager = document.createElement('div');
    pager.className = 'doc-slide-pager';

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'doc-slide-btn';
    prev.textContent = '←';
    prev.setAttribute('aria-label', t('docSlidePrev'));
    prev.dataset.i18nTitle = 'docSlidePrev';
    prev.title = t('docSlidePrev');

    const counter = document.createElement('span');
    counter.className = 'doc-slide-counter';

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'doc-slide-btn';
    next.textContent = '→';
    next.setAttribute('aria-label', t('docSlideNext'));
    next.dataset.i18nTitle = 'docSlideNext';
    next.title = t('docSlideNext');

    pager.append(prev, counter, next);

    const view = document.createElement('div');
    view.className = 'doc-slide';

    const render = (): void => {
      const slide: PptxSlide = d.slides[index];
      view.replaceChildren();
      view.appendChild(
        slide.shapes && slide.shapes.length
          ? stageEl(slide, cqwPerPt, slideW, slideH)
          : legacySlideEl(slide),
      );
      counter.textContent = `${index + 1} / ${total}`;
      prev.disabled = index === 0;
      next.disabled = index === total - 1;
      shell.setKpis([
        ['docKpiSlides', total],
        ['docKpiPage', index + 1],
      ]);
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
      note.dataset.i18n = 'docPptxTruncated';
      note.textContent = t('docPptxTruncated');
      shell.body.appendChild(note);
    }

    render();
  });

  return shell.container;
}
