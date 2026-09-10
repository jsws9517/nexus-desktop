/**
 * Vega-Lite chart renderer — hands the compiled artifact spec to vega-embed.
 * Incremental updates (artifact.patch) re-embed the newest spec; export flows
 * through view.toCanvas() → save dialog (nexus:saveArtifact).
 */

import { getVegaEmbed } from './vega.js';

const PNG_PREFIX = 'data:image/png;base64,';

export interface ChartMenu {
  render: () => Promise<void>;
  exportPng: (title: string) => Promise<void>;
  dispose: () => void;
}

export function mountChart(container: HTMLElement, artifactBody: unknown): ChartMenu {
  const body = (artifactBody ?? {}) as { spec?: unknown; mark?: unknown } | null;
  const host = document.createElement('div');
  host.className = 'chart-vis';
  container.appendChild(host);

  let view: { toCanvas?: (scale?: number) => Promise<HTMLCanvasElement> } | null = null;
  let disposed = false;

  const render = async (): Promise<void> => {
    if (disposed) return;
    const vegaEmbed = getVegaEmbed();
    const spec = body?.spec;
    if (!vegaEmbed || !spec) {
      const fallback = document.createElement('details');
      fallback.className = 'chart-fallback';
      const summary = document.createElement('summary');
      summary.textContent = vegaEmbed ? 'chart (bundle missing?)' : 'chart';
      const pre = document.createElement('pre');
      pre.textContent = typeof spec === 'string' ? spec : JSON.stringify(spec ?? null, null, 2);
      fallback.appendChild(summary);
      fallback.appendChild(pre);
      host.appendChild(fallback);
      return;
    }
    host.textContent = '';
    try {
      const res = await vegaEmbed(host, spec, {
        mode: 'vega' as const,
        actions: false,
        width: 'container',
        theme: 'light',
      });
      view = res.view;
    } catch (e) {
      const err = document.createElement('div');
      err.className = 'artifact-error-text';
      err.textContent = e instanceof Error ? e.message : String(e);
      host.appendChild(err);
    }
  };

  const exportPng = async (title: string): Promise<void> => {
    if (!view?.toCanvas) return;
    try {
      const canvas = await view.toCanvas(2);
      const dataUrl = canvas.toDataURL('image/png');
      if (!dataUrl.startsWith(PNG_PREFIX)) return;
      const result = await window.nexusDesktop.saveArtifact(
        `${title || 'chart'}.png`,
        dataUrl.slice(PNG_PREFIX.length),
        'base64',
      );
      if (result.ok && result.path) void window.nexusDesktop.revealFile(result.path);
    } catch {
      /* export is best-effort */
    }
  };

  const dispose = (): void => {
    disposed = true;
    host.textContent = '';
    if (container.contains(host)) container.removeChild(host);
  };

  void render();
  return { render, exportPng, dispose };
}