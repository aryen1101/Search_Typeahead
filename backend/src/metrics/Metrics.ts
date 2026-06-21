export class Metrics {
  suggestRequests = 0;
  cacheHits = 0;
  cacheMisses = 0;
  private latencies: number[] = [];
  private readonly maxSamples = 20000;
  searchRequest = 0;
  dbRowswritten = 0;
  flushCount = 0;
  decayTicks = 0;
  cacheInvalidations = 0;
  startedAt = Date.now();

  recordSuggest(latency: number, hit: boolean): void {
    this.suggestRequests++;
    if (hit) this.cacheHits++;
    else this.cacheMisses++;
    if (this.latencies.length >= this.maxSamples) this.latencies.shift();
    this.latencies.push(latency);
  }

  recordSearch(): void {
    this.searchRequest++;
  }

  recordFlush(rows: number, prefixUpdated: number): void {
    this.flushCount++;
    this.dbRowswritten += rows;
    this.cacheInvalidations += prefixUpdated;
  }

  recordDecay(): void {
    this.decayTicks++;
  }

  private percentile(p: number): number {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.floor((p / 100) * sorted.length),
    );
    return Number(sorted[idx].toFixed(3));
  }

  snapshot() {
    const totalCacheLookups = this.cacheHits + this.cacheMisses;
    const hitRate =
      totalCacheLookups === 0 ? 0 : this.cacheHits / totalCacheLookups;
    const writeReduction =
      this.dbRowswritten === 0 ? null : this.searchRequest / this.dbRowswritten;

    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      suggest: {
        requests: this.suggestRequests,
        cacheHits: this.cacheHits,
        cacheMisses: this.cacheMisses,
        cacheHitRate: Number(hitRate.toFixed(4)),
        latencyMs: {
          p50: this.percentile(50),
          p95: this.percentile(95),
          p99: this.percentile(99),
          samples: this.latencies.length,
        },
      },
      writes: {
        searchRequestsReceived: this.searchRequest,
        dbRowsWritten: this.dbRowswritten,
        flushes: this.flushCount,
        cacheInvalidations: this.cacheInvalidations,
        writeReductionFactor:
          writeReduction === null ? null : Number(writeReduction.toFixed(2)),
      },
      recency: { decayTicks: this.decayTicks },
    };
  }
}
