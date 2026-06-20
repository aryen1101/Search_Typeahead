function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(name: string, def: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return v;
}

export type Ranking = "basic" | "recency";

export const config = {
  port: num("PORT", 8080),

  redisNodes: str("REDIS_NODES", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  cacheTtlSeconds: num("CACHE_TTL_SECONDS", 60),
  cacheVirtualNodes: num("CACHE_VIRTUAL_NODES", 150),

  suggestLimit: num("SUGGEST_LIMIT", 10),
  minPrefixLength: num("MIN_PREFIX_LENGTH", 1),

  batchFlushMs: num("BATCH_FLUSH_MS", 2000),
  batchMaxSize: num("BATCH_MAX_SIZE", 500),

  decayIntervalMs: num("DECAY_INTERVAL_MS", 60000),
  decayRate: num("DECAY_RATE", 0.9),

  defaultRanking: str("DEFAULT_RANKING", "recency") as Ranking,

  kafkaBrokers: str("KAFKA_BROKERS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  kafkaTopic: str("KAFKA_TOPIC", "search-events"),
  kafkaGroupId: str("KAFKA_GROUP_ID", "typeahead-consumer"),
  kafkaClientId: str("KAFKA_CLIENT_ID", "typeahead-backend"),
  kafkaPartitions: num("KAFKA_PARTITIONS", 3),

  dbPath: str("DB_PATH", "./data/typeahead.db"),

  seedFile: str("SEED_FILE", "../data/queries.tsv"),
  seedTarget: num("SEED_TARGET", 120000),
};
