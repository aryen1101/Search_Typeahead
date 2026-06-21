import { normalize } from "node:path";
import { CacheCluster } from "../cache/CacheCluster";
import { Ranking } from "../config";
import { Database } from "../db/Database";
import { Metrics } from "../metrics/Metrics";
import { Suggestion } from "../types";

export interface SuggestResult {
  prefix: string;
  ranking: Ranking;
  source: "cache" | "db";
  node: string;
  count: number;
  suggestions: Suggestion[];
  tookMs: number;
}

export class SuggestionService {
  constructor(
    private db: Database,
    private cache: CacheCluster,
    private metrics: Metrics,
    private opts: {
      limit: number;
      ttlSeconds: number;
      minPrefixLength: number;
    },
  ) {}

  async suggest(rawPrefix: string, ranking: Ranking): Promise<SuggestResult> {
    const start = process.hrtime.bigint();
    const prefix = normalize(rawPrefix);
    const node = prefix ? this.cache.ring_().getNode(prefix) : "-";
    if (prefix.length < this.opts.minPrefixLength) {
      const tookMs = this.elapsedMs(start);
      this.metrics.recordSuggest(tookMs, false);
      return {
        prefix,
        ranking,
        source: "db",
        node,
        count: 0,
        suggestions: [],
        tookMs,
      };
    }

    const cached = await this.cache.get(prefix, ranking);
    if (cached != null) {
      const suggestions = JSON.parse(cached) as Suggestion[];
      const tookMs = this.elapsedMs(start);
      this.metrics.recordSuggest(tookMs, true);
      return {
        prefix,
        ranking,
        source: "cache",
        node,
        count: suggestions.length,
        suggestions,
        tookMs,
      };
    }
    const suggestions = this.db.topKByPrefix(prefix, this.opts.limit, ranking);
    await this.cache.set(
      prefix,
      ranking,
      JSON.stringify(suggestions),
      this.opts.ttlSeconds,
    );
    const tookMs = this.elapsedMs(start);
    this.metrics.recordSuggest(tookMs, false);
    return {
      prefix,
      ranking,
      source: "db",
      node,
      count: suggestions.length,
      suggestions,
      tookMs,
    };
  }

  trending(limit: number): Suggestion[] {
    return this.db.trending(limit);
  }

  private elapsedMs(start: bigint): number {
    return Number(process.hrtime.bigint() - start) / 1_000_000;
  }
}
