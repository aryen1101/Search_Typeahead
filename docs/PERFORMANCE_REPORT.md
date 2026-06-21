# Performance Report

Measured against the running Docker stack (Windows 11 + Docker Desktop) using the
reproducible load‑test script and the backend's own `/stats` endpoint. Nothing is
hand‑tuned.

## Setup
| Item | Value |
|---|---|
| Backend | Node 20 + Express 5, `better-sqlite3` (WAL) primary store |
| Cache | 3 Redis nodes behind a consistent‑hash ring (150 virtual nodes/node) |
| Ingestion | Kafka write‑behind → batched SQLite upserts + cache warming |
| Dataset | ~591,775 unique queries |
| Cache TTL | 60 s per suggestion key |

**Reproduce**
```bash
docker compose up -d
node scripts/loadtest.mjs
# through the nginx proxy instead:
BASE=http://localhost:3000/api node scripts/loadtest.mjs
```
Workload: 3,000 `/suggest` requests over 200 distinct prefixes with a skewed (Zipf‑like)
access pattern, 2,000 `/search` posts over 25 distinct queries, concurrency 24.

---

## 1. Suggestion latency

| Metric | p50 | p95 | p99 | avg |
|---|---:|---:|---:|---:|
| **Server‑side `/suggest`** (3,200 samples) | **1.26 ms** | **13.33 ms** | 34.37 ms | — |
| Client‑side, warm (cache hits) | 7.65 ms | 13.59 ms | 19.31 ms | 8.26 ms |
| Client‑side, cold (cache miss → SQLite) | 44.16 ms | 101.94 ms | 138.35 ms | 54.0 ms |

- Sustained throughput: **~2,897 `/suggest` req/s** at concurrency 24.
- The cold pass pays SQLite range scan + Redis `SET`; the warm pass is served from Redis
  and is ~6× faster end‑to‑end. p95 from cache stays in the low‑teens of ms.

---

## 2. Cache hit rate

| Lookups | Hits | Misses | Hit rate |
|---:|---:|---:|---:|
| 3,200 | 3,000 | 200 | **93.8 %** |

Misses equal the number of distinct prefixes (200) — exactly one cold miss per key, every
subsequent skewed repeat is a hit. Expected behavior for a read‑through cache with a 60 s
TTL under a realistic, repetitive typing workload.

---

## 3. Write reduction via batching (write‑behind)

`/search` does not write to SQLite synchronously — it publishes to Kafka; the consumer
aggregates each batch and performs one transaction per batch.

| `/search` requests | SQLite rows written | Flushes | Reduction factor |
|---:|---:|---:|---:|
| 2,000 | 555 | 70 | **3.6×** |

Representative consumer log lines:
```
Kafka consumer: 9 queries -> SQLite, 24 prefixes warmed in cache
Kafka consumer: 8 queries -> SQLite, 24 prefixes warmed in cache
Kafka consumer: 7 queries -> SQLite, 24 prefixes warmed in cache
```
Each flush collapses ~6–9 duplicate events into a single transaction. The factor grows with
arrival burstiness (faster bursts / larger batch window aggregate more duplicates per
flush); here the stream arrived steadily over 25 distinct queries.

**Failure trade‑off:** events buffered in Kafka survive a backend crash (durable in the log,
re‑read from the committed offset on restart). The only loss window is events accepted by
`/search` but not yet acknowledged to Kafka. This favors low write latency and DB protection
over strict per‑request durability — acceptable for popularity counters where a rare lost
increment is harmless.

---

## 4. Consistent hashing behavior

**Ring ownership** (share of hash space, from `/cache/nodes` / startup logs):
```
redis-cache-1:6379 : 33.48 %
redis-cache-2:6379 : 33.20 %
redis-cache-3:6379 : 33.32 %
```
**Actual routing of the 200 test prefixes** (`/cache/debug`):
```
redis-cache-1 : 73 prefixes
redis-cache-2 : 67 prefixes
redis-cache-3 : 60 prefixes
```
Sample routes (prefix → node, keyHash):
```
qr → redis-cache-1 (1115916825)
qb → redis-cache-2 (1444764921)
dq → redis-cache-3 (3077027030)
```
150 virtual nodes per physical node smooth what would otherwise be a lumpy 3‑point ring.
Because routing is hash‑based, adding/removing a node only remaps ≈1/N of keys.

---

## 5. Summary

| Dimension | Result |
|---|---|
| Suggest latency (server) | p50 1.26 ms · p95 13.33 ms · p99 34.37 ms |
| Throughput | ~2,897 req/s |
| Cache hit rate | 93.8 % |
| Write reduction | 3.6× (2,000 → 555 DB rows) |
| Ring balance | 33.48 / 33.20 / 33.32 % |

Absolute numbers vary with hardware and load parameters, but the relationships hold:
cache hits ≫ DB reads, batched writes ≪ raw writes, and the ring distributes evenly.
