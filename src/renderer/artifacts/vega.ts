/**
 * Vega runtime adapter for the renderer.
 *
 * The bundles are loaded as classic <script> tags from ./static/ (no bundler in
 * this repo), so vega-embed surfaces on window; this helper centralizes the
 * lookup + typing so the views fail gracefully when a bundle is missing.
 */

export interface VegaEmbedResult {
  view: { toCanvas?: (scale?: number) => Promise<HTMLCanvasElement> };
}

type VegaEmbedFn = (
  el: HTMLElement,
  spec: unknown,
  opts?: Record<string, unknown>,
) => Promise<VegaEmbedResult>;

/** Resolve the window-provided vegaEmbed entrypoint, or null when unavailable. */
export function getVegaEmbed(): VegaEmbedFn | null {
  const w = window as unknown as { vegaEmbed?: VegaEmbedFn };
  return typeof w.vegaEmbed === 'function' ? w.vegaEmbed : null;
}