/**
 * A tiny byte-budgeted LRU cache for fetched image artifacts.
 *
 * A live-updating matplotlib plot produces a DISTINCT image (new sha) every
 * step, so the per-id artifact cache would otherwise hold every frame's full
 * bytes for the whole session — unbounded extension-host memory over a long
 * training run. This evicts least-recently-used entries once a byte budget (or
 * an entry-count backstop) is exceeded. Superseded frames are never re-requested
 * (each sha is unique), so eviction is safe; a re-fetch is at worst one round trip.
 *
 * Values may be `null` (= fetched, not found / GC'd on the host): kept so we do
 * not hammer the daemon for a known-missing image, counted toward the entry cap
 * but not the byte budget. `undefined` means "not in the cache".
 */
export class ArtifactCache<V> {
  private readonly map = new Map<string, V>();
  private bytes = 0;

  constructor(
    private readonly sizeOf: (v: V) => number,
    private readonly maxBytes = 64 * 1024 * 1024, // 64 MiB of decoded image bytes
    private readonly maxEntries = 1024,
  ) {}

  /** LRU read: returns the value (which may be null), or undefined if absent. */
  get(id: string): V | undefined {
    if (!this.map.has(id)) return undefined;
    const v = this.map.get(id) as V;
    this.map.delete(id); // re-insert to move to the most-recently-used end
    this.map.set(id, v);
    return v;
  }

  set(id: string, v: V): void {
    if (this.map.has(id)) this.bytes -= this.sizeOf(this.map.get(id) as V);
    this.map.set(id, v);
    this.bytes += this.sizeOf(v);
    this.evict();
  }

  private evict(): void {
    // Drop oldest (front of insertion order) until within both bounds. Never
    // drop the just-set entry to nothing if it alone exceeds the budget — the
    // loop stops at one remaining entry.
    const iter = () => this.map.keys().next().value as string | undefined;
    while (this.map.size > 1 && (this.bytes > this.maxBytes || this.map.size > this.maxEntries)) {
      const oldest = iter();
      if (oldest === undefined) break;
      this.bytes -= this.sizeOf(this.map.get(oldest) as V);
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  /** Test/introspection helpers. */
  get entries(): number {
    return this.map.size;
  }
  get byteSize(): number {
    return this.bytes;
  }
}
