import { ChatChunk } from '../types.js';

/** Thrown when no LLM chunk arrives within the idle window (half-dead stream). */
export class IdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`LLM stream stalled: no chunk received within ${idleMs}ms`);
    this.name = 'IdleTimeoutError';
  }
}


/**
 * Wraps an async iterable of LLM chunks with a per-chunk idle timeout.
 *
 * Some upstream providers (e.g. free proxy aggregators) occasionally let a
 * streaming response enter a "half-dead" state: the HTTP connection stays open
 * but stops delivering chunks. The SDK's `for await` then blocks forever
 * waiting for the next chunk, so the turn never completes and the client never
 * receives a reply (until an unrelated watchdog aborts much later).
 *
 * This wrapper arms a timer after every chunk. If no new chunk arrives within
 * `idleMs`, it aborts the request via `signal` (or a dedicated controller when
 * none was supplied), causing the underlying `for await` to throw AbortError so
 * the failure surfaces quickly instead of hanging.
 */
export async function* withChunkTimeout(
  source: AsyncIterable<ChatChunk>,
  idleMs: number,
  signal?: AbortSignal,
): AsyncIterable<ChatChunk> {
  const ownController = !signal ? new AbortController() : undefined;
  const activeSignal = signal ?? ownController!.signal;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (ownController) ownController.abort();
      else (signal as AbortSignal & { abort?: () => void }).abort?.();
    }, idleMs);
  };
  const disarm = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  // If an external abort happens, stop waiting on the stream.
  if (signal) {
    if (signal.aborted) {
      disarm();
      return;
    }
    signal.addEventListener('abort', disarm, { once: true });
  }

  try {
    const iterator = source[Symbol.asyncIterator]();
    arm();
    while (true) {
      // Race the next chunk against BOTH the idle timer AND an external abort,
      // so a watchdog abort (or any signal abort) breaks the await immediately
      // instead of leaving `for await` stuck on a never-resolving next().
      const abortPromise = signal
        ? new Promise<'__abort__'>((resolve) => {
            if (signal.aborted) { resolve('__abort__'); return; }
            signal.addEventListener('abort', () => resolve('__abort__'), { once: true });
          })
        : null;

      const next = await Promise.race([
        iterator.next(),
        new Promise<'__idle__'>((resolve) =>
          setTimeout(() => resolve('__idle__'), idleMs),
        ),
        ...(abortPromise ? [abortPromise] : []),
      ]);

      if (next === '__abort__') {
        // Throwing instead of returning is intentional: if we `return`, the JS
        // engine calls `iterator.return()` on the SDK's stream, which may try to
        // cancel the pending HTTP request and HANG (the stuck server never
        // responds). By throwing, `iterator.return()` is never called; the
        // underlying socket will be GC'd as a dangling unhandled rejection (which
        // the ACP server's global handler logs and survives).
        disarm();
        throw new IdleTimeoutError(idleMs);
      }

      if (next === '__idle__') {
        // No chunk within idleMs: abort the request and surface a distinct
        // error so the caller can fail fast instead of silently retrying.
        if (ownController) ownController.abort();
        else (signal as AbortSignal & { abort?: () => void }).abort?.();
        disarm();
        throw new IdleTimeoutError(idleMs);
      }

      disarm();
      if (next.done) return;
      yield next.value;
      arm();
    }
  } finally {
    disarm();
    if (signal) signal.removeEventListener('abort', disarm);
  }
}
