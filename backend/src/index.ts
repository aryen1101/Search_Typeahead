import { config } from "./config";
import { Database } from "./db/Database";
import { seedIfEmpty } from "./db/seed";
import { CacheCluster } from "./cache/CacheCluster";
import { Metrics } from "./metrics/Metrics";
import { SuggestionService } from "./services/SuggestionService";
import { BatchWriter } from "./services/BatchWrites";
import { RecencyDecay } from "./services/RecencyDecay";
import { createKafkaClient, ensureTopic } from "./queue/KafkaClient";
import { SearchProducer } from "./queue/SearchProducer";
import { SearchConsumer } from "./queue/SearchConsumer";
import { SearchIntake } from "./types";
import { createApp } from "./app";
import { log } from "./logger";

async function main() {
  log.info("Starting Search Typeahead backend...");
  log.info("Config:", {
    port: config.port,
    redisNodes: config.redisNodes.length ? config.redisNodes : "(in-memory)",
    kafkaBrokers: config.kafkaBrokers.length ? config.kafkaBrokers : "(in-memory batch)",
    cacheTtlSeconds: config.cacheTtlSeconds,
    decayIntervalMs: config.decayIntervalMs,
    decayRate: config.decayRate,
    defaultRanking: config.defaultRanking,
  });

  const db = new Database(config.dbPath);
  await seedIfEmpty(db, { seedFile: config.seedFile });

  const cache = new CacheCluster(config.redisNodes, config.cacheVirtualNodes);

  const metrics = new Metrics();
  const suggestions = new SuggestionService(db, cache, metrics, {
    limit: config.suggestLimit,
    ttlSeconds: config.cacheTtlSeconds,
    minPrefixLength: config.minPrefixLength,
  });

  let intake: SearchIntake;
  let stopWritePath: () => Promise<void>;

  if (config.kafkaBrokers.length > 0) {
    log.info(`Search ingestion: KAFKA -> [${config.kafkaBrokers.join(", ")}]`);
    const kafka = createKafkaClient(config.kafkaClientId, config.kafkaBrokers);
    await ensureTopic(kafka, config.kafkaTopic, config.kafkaPartitions);

    const producer = new SearchProducer(kafka, config.kafkaTopic, metrics);
    await producer.connect();

    const consumer = new SearchConsumer(kafka, config.kafkaGroupId, config.kafkaTopic, db, cache, metrics, {
      limit: config.suggestLimit,
      ttlSeconds: config.cacheTtlSeconds,
      minPrefixLength: config.minPrefixLength,
    });
    await consumer.start();

    intake = { mode: "kafka", record: (q) => producer.record(q), pendingSize: () => 0 };
    stopWritePath = async () => {
      await consumer.stop();
      await producer.disconnect();
    };
  } else {
    log.info("Search ingestion: IN-MEMORY batch writer (no KAFKA_BROKERS set)");
    const batch = new BatchWriter(db, cache, metrics, {
      flushMs: config.batchFlushMs,
      maxSize: config.batchMaxSize,
      minPrefixLength: config.minPrefixLength,
    });
    batch.start();
    intake = { mode: "in-memory", record: async (q) => batch.record(q), pendingSize: () => batch.pendingSize() };
    stopWritePath = async () => {
      await batch.stop();
    };
  }

  const decay = new RecencyDecay(db, metrics, {
    intervalMs: config.decayIntervalMs,
    rate: config.decayRate,
  });
  decay.start();

  const app = createApp({ config, db, cache, metrics, suggestions, intake });
  const httpServer = app.listen(config.port, () => {
    log.info(`Backend listening on http://localhost:${config.port}`);
  });

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down...`);
    httpServer.close();
    decay.stop();
    await stopWritePath();
    await cache.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("Fatal startup error:", e);
  process.exit(1);
});
