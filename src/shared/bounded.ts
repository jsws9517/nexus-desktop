/**
 * Bounded-map helper for caches that must not grow forever.
 *
 * `Map` iteration order is insertion order, so dropping the first key evicts
 * the oldest entry — a cheap FIFO bound for token/estimate caches.
 */

/** Insert `value` at `key`, then evict oldest entries until size ≤ `maxEntries`. */
export function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  map.set(key, value);
  if (maxEntries < 0) maxEntries = 0;
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}