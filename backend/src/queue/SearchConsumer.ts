import { Kafka, Consumer, KafkaJSDeleteGroupsError } from "kafkajs";
import { Database } from "../db/Database";
import { CacheCluster } from "../cache/CacheCluster";
import { Metrics } from "../metrics/Metrics";
import { log } from "../logger";

const RANKINGS = ["basic", "recency"] as const;

export class SearchConsumer {
  private consumer: Consumer;

  constructor(
    kafka: Kafka,
    groupId: string,
    private topic: string,
    private db: Database,
    private cache: CacheCluster,
    private metrics: Metrics,
    private opts: {
      limit: number;
      ttlSeconds: number;
      minPrefixLength: number;
    },
  ) {
    this.consumer = kafka.consumer({ groupId });
  }

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });

    await this.consumer.run({
      eachBatchAutoResolve: true,
      eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
        const agg = new Map<string, number>();
        for (const m of batch.messages) {
          const q = m.value?.toString() ?? "";
          if (q) agg.set(q, (agg.get(q) ?? 0) + 1);
          resolveOffset(m.offset);
        }
        if (agg.size === 0) return;
        await this.process(agg);
        await heartbeat();
      },
    });
    log.info("Kafka consumer running (write-behind: SQLite + cache warm)");
  }

  private async process(agg: Map<string, number>): Promise<void> {
    const now = Date.now();
    const entries = [...agg].map(([query, delta]) => ({ query, delta }));
    const rows = this.db.upsertBatch(entries, now);
    const prefixes = this.collectPrefixes(agg.keys());
    await Promise.all(
      [...prefixes].flatMap((p) =>
        RANKINGS.map(async (r) => {
          const top = this.db.topKByPrefix(p, this.opts.limit, r);
          await this.cache.set(p, r, JSON.stringify(top), this.opts.ttlSeconds);
        }),
      ),
    );

    this.metrics.recordFlush(rows, prefixes.size);
    log.info(
      `Kafka consumer: ${rows} queries -> SQLite, ${prefixes.size} prefixes warmed in cache`,
    );
  }

  private collectPrefixes(queries: Iterable<string>): Set<string> {
    const set = new Set<string>();
    for (const q of queries) {
      for (let i = this.opts.minPrefixLength; i <= q.length; i++)
        set.add(q.slice(0, i));
    }
    return set;
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
  }
}
