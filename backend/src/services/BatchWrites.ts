import { Database } from "../db/Database";
import { CacheCluster } from "../cache/CacheCluster";
import { Metrics } from "../metrics/Metrics";
import { normalize } from "../db/normalize";
import { log } from "../logger";

export class BatchWriter {
  private buffer = new Map<string, number>(); 
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(
    private db: Database,
    private cache: CacheCluster,
    private metrics: Metrics,
    private opts: { flushMs: number; maxSize: number; minPrefixLength: number }
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.flush("interval");
    }, this.opts.flushMs);
  }

  record(rawQuery: string): { message: string } {
    const q = normalize(rawQuery);
    if (q) {
      this.buffer.set(q, (this.buffer.get(q) ?? 0) + 1);
      this.metrics.recordSearch();
      if (this.buffer.size >= this.opts.maxSize) {
        void this.flush("size");
      }
    }
    return { message: "Searched" };
  }

  pendingSize(): number {
    return this.buffer.size;
  }

  async flush(reason: string): Promise<void> {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;

    const snapshot = this.buffer;
    this.buffer = new Map<string, number>();

    try {
      const now = Date.now();
      const entries = Array.from(snapshot.entries()).map(([query, delta]) => ({ query, delta }));

      const rows = this.db.upsertBatch(entries, now);

      const prefixes = this.collectPrefixes(snapshot.keys());
      await Promise.all(
        Array.from(prefixes).map((p) => this.cache.invalidate(p, ["basic", "recency"]))
      );

      this.metrics.recordFlush(rows, prefixes.size);
      log.info(
        `batch flush (${reason}): ${rows} queries persisted, ${prefixes.size} prefixes invalidated`
      );
    } catch (e) {
      for (const [q, d] of snapshot) this.buffer.set(q, (this.buffer.get(q) ?? 0) + d);
      log.error("batch flush failed, re-buffered:", (e as Error).message);
    } finally {
      this.flushing = false;
    }
  }

  private collectPrefixes(queries: Iterable<string>): Set<string> {
    const set = new Set<string>();
    for (const q of queries) {
      for (let i = this.opts.minPrefixLength; i <= q.length; i++) {
        set.add(q.slice(0, i));
      }
    }
    return set;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush("shutdown");
  }
}
