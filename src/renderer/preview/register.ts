/**
 * Register user-reached directories into the main process's preview
 * containment list so that clicking a path link in chat actually previews the
 * file (the static root list — project cwds, ~/.nexus, tmp — misses folders
 * the user only ever attached a file from, e.g. `E:\低效小区`).
 *
 * Called from two places:
 *   - `attachFiles` — the user explicitly attached these local files; their
 *     containing directory is as much a "project root" as an opened folder.
 *   - `linkifyPreviewPaths` — every previewable path that reached the chat
 *     transcript (agent tool results, assistant text) registers its directory.
 *     The path is already visible in the user's own transcript, so previewing
 *     the file widens no information boundary.
 *
 * De-duped here (and again in the main process); the IPC fire-and-forget.
 */

const registered = new Set<string>();
/** Cap the dedup cache so a very long single app run stays bounded. */
const MAX_REGISTERED = 4000;

/**
 * Register the given file/directory paths for preview. No-op when every path
 * was already registered in this app run; never throws (bridge may be
 * absent in embedded/test contexts).
 */
export function registerPreviewPaths(paths: string[]): void {
  void registerPreviewPathsAsync(paths);
}

/**
 * Same as {@link registerPreviewPaths} but returns the bridge call's promise,
 * so callers that must NOT issue a preview request until the main process has
 * the root (the inline card's mount path) can `await` it. Resolves to the
 * bridge result, or `null` when there was nothing to send / no bridge.
 */
export async function registerPreviewPathsAsync(paths: string[]): Promise<{ ok: boolean; added: number; error?: string } | null> {
  const fresh: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0 || p.length > 4096) continue;
    // Only absolute local paths register (drive / UNC / POSIX). Relative
    // strings are never preview roots, so they never cross the bridge.
    if (!(/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/'))) continue;
    if (registered.has(p)) continue;
    registered.add(p);
    fresh.push(p);
  }
  if (fresh.length === 0) return null;
  if (registered.size > MAX_REGISTERED) {
    registered.clear();
    for (const p of fresh) registered.add(p);
  }
  // Fire-and-forget; the bridge (or its method) may be absent in embedded or
  // test contexts — degrade to the static roots without throwing.
  const fn = window.nexusDesktop?.previewAllowPaths;
  if (!fn) return null;
  try {
    return await fn(fresh);
  } catch {
    // Bridge threw: the preview will fall back to its static roots;
    // re-attempt on the next fresh registration.
    for (const p of fresh) registered.delete(p);
    return null;
  }
}

/** Test seam: forget every registration. */
export function clearRegisteredPreviewPaths(): void {
  registered.clear();
}
