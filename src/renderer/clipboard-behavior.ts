/// <reference lib="dom" />

/**
 * Linux-style clipboard affordances for the chat surfaces.
 *
 * The transcript is read-only text rendered outside any editable control, so
 * its copy button is the only built-in way to get content out. These helpers
 * add the two X11 habits users expect on selection:
 *
 *  - selecting text in the transcript copies it to the clipboard right away
 *    (the "primary selection" feel), and Ctrl/Cmd+C is handled explicitly so
 *    it keeps working even though the window has no application menu on
 *    Windows/Linux;
 *  - middle-clicking a live selection copies it and suppresses Chromium's
 *    middle-click autoscroll.
 *
 * Right-click paste is installed separately on the composer only: the native
 * paste command is replayed into the focused textarea, so the renderer's
 * existing `paste` handler (image/file attachments) runs exactly as it does
 * for Ctrl+V. The attach and RAG picker buttons live outside that element and
 * keep their normal click behaviour.
 */

export type SelectionCopySource = 'selection' | 'shortcut' | 'middle';

export interface Disposable {
  dispose(): void;
}

/** Text currently selected inside `root`, or '' when the selection is
 *  collapsed, empty, or reaches outside the transcript. */
export function selectedTextIn(root: Node, selection: Selection | null): string {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';
  const text = selection.toString();
  if (!text.trim()) return '';
  const container = selection.getRangeAt(0).commonAncestorContainer;
  // 3 = Node.TEXT_NODE; compare numerically so the helper also works in DOM
  // shims that do not install a global `Node` constructor.
  const node = container.nodeType === 3 ? container.parentNode : container;
  if (!node || !root.contains(node)) return '';
  return text;
}

/** True for controls that own their own copy/paste shortcut handling. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return Boolean(
    (target as Element).closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
    ),
  );
}

export interface HistorySelectionCopyOptions {
  /** Transcript container — the only region that gets selection-copy. */
  root: HTMLElement;
  /** Clipboard bridge (Electron IPC in production). */
  writeText: (text: string) => Promise<unknown> | unknown;
  /** Fired after a successful explicit copy (Ctrl+C / middle-click). */
  onCopied?: (text: string, source: SelectionCopySource) => void;
  /** Idle delay before a drag selection is copied. Defaults to 180 ms. */
  debounceMs?: number;
}

/**
 * Install select-to-copy + Ctrl/Cmd+C + middle-click copy on a transcript
 * container. Returns a disposer (useful for tests / panel teardown).
 */
export function installHistorySelectionCopy(opts: HistorySelectionCopyOptions): Disposable {
  const { root, writeText, onCopied } = opts;
  const debounceMs = opts.debounceMs ?? 180;
  const doc = root.ownerDocument;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastCopied = '';

  const copyNow = async (
    text: string,
    source: SelectionCopySource,
    notify: boolean,
  ): Promise<void> => {
    lastCopied = text;
    try {
      await writeText(text);
      if (notify) onCopied?.(text, source);
    } catch {
      /* clipboard unavailable — leave the current clipboard untouched */
    }
  };

  // Select-to-copy: wait for the drag/keyboard selection to settle, then write
  // the final range. `lastCopied` avoids rewriting on every mouse movement.
  const onSelectionChange = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const text = selectedTextIn(root, doc.getSelection());
    if (!text) {
      lastCopied = '';
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      const current = selectedTextIn(root, doc.getSelection());
      if (!current || current === lastCopied) return;
      void copyNow(current, 'selection', false);
    }, debounceMs);
  };

  // Explicit Ctrl+C / Cmd+C. Chromium already knows how to copy a DOM
  // selection, but this renderer runs without an application menu on
  // Windows/Linux; intercepting the transcript case keeps the shortcut
  // deterministic. Editable controls are left alone.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (typeof e.key !== 'string' || e.key.toLowerCase() !== 'c') return;
    if (isEditableTarget(e.target)) return;
    const text = selectedTextIn(root, doc.getSelection());
    if (!text) return;
    e.preventDefault();
    void copyNow(text, 'shortcut', true);
  };

  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 1) return;
    // Autoscroll starts on mousedown; only suppress it when a selection exists.
    if (selectedTextIn(root, doc.getSelection())) e.preventDefault();
  };

  const onAuxClick = (e: MouseEvent): void => {
    if (e.button !== 1) return;
    const text = selectedTextIn(root, doc.getSelection());
    if (!text) return;
    e.preventDefault();
    void copyNow(text, 'middle', true);
  };

  doc.addEventListener('selectionchange', onSelectionChange);
  doc.addEventListener('keydown', onKeyDown);
  root.addEventListener('mousedown', onMouseDown);
  root.addEventListener('auxclick', onAuxClick);

  return {
    dispose() {
      if (timer) clearTimeout(timer);
      doc.removeEventListener('selectionchange', onSelectionChange);
      doc.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('mousedown', onMouseDown);
      root.removeEventListener('auxclick', onAuxClick);
    },
  };
}

export interface RightClickPasteOptions {
  /** Composer textarea only — never the surrounding toolbar/pickers. */
  input: HTMLElement;
  /** Replay the native paste command (Electron `webContents.paste()`). */
  paste: () => Promise<unknown> | unknown;
}

/**
 * Right-click on the composer behaves like Ctrl+V. The native command is used
 * (instead of reading text directly) so images and files still flow through
 * the renderer's paste handler and become attachments.
 */
export function installRightClickPaste(opts: RightClickPasteOptions): Disposable {
  const { input, paste } = opts;
  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    // The paste command targets the focused element; focus the composer even
    // when the right-click landed on its padding/border area.
    input.focus({ preventScroll: true });
    try {
      void Promise.resolve(paste()).catch(() => {});
    } catch {
      /* paste unavailable */
    }
  };
  input.addEventListener('contextmenu', onContextMenu);
  return {
    dispose() {
      input.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
