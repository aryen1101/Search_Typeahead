# Performance Report — Search Typeahead

Measured against the running Docker stack on the development machine
(Windows 11, Docker Desktop). All numbers below are produced by the reproducible
load-test script and the backend's own `/stats` endpoint — nothing is hand-tuned.

## 1. Setup

| Item | Value |
|------|-------|
| Backend | Node 20 + Express 5, `better-sqlite3` (WAL) as the primary store |
| Cache | 3 Redis nodes (`redis-cache-1/2/3`) behind a consistent-hash ring (150 virtual nodes/node) |
| Ingestion | Kafka write-behind (`search-events`, 3 partitions) → batched SQLite upserts + cache warming |
| Dataset | **591,775 unique queries** (open-source word/query frequency dataset, `data/queries.tsv`) |
| Cache TTL | 60 s per suggestion key (`sug:<ranking>:<prefix>`) |

**Reproduce:**
```bash
docker compose up -d            # bring up redis x3 + kafka + backend (+ frontend)
node scripts/loadtest.mjs       # 3,000 suggest reqs + 2,000 search reqs + routing probe
# or through the nginx proxy:
BASE=http://localhost:3000/api node scripts/loadtest.mjs
```
Test parameters: 3,000 `/suggest` requests over 200 distinct prefixes (skewed/Zipf-like
access), 2,000 `/search` posts over 25 distinct queries, concurrency 24.

---

## 2. Suggestion latency

Server-side latency is measured by the backend per request (`process.hrtime`) and
exposed at `/stats`. Client-side latency is wall-clock from the load tester (includes
HTTP + JSON).

| Metric | p50 | p95 | p99 | avg |
|--------|----:|----:|----:|----:|
| **Server-side `/suggest`** (3,200 samples) | **1.26 ms** | **13.33 ms** | 34.37 ms | — |
| Client-side, warm (cache hits) | 7.65 ms | 13.59 ms | 19.31 ms | 8.26 ms |
| Client-side, cold (cache misses → SQLite) | 44.16 ms | 101.94 ms | 138.35 ms | 54.0 ms |

- **Throughput:** ~**2,897 `/suggest` req/s** sustained at concurrency 24.
- The cold pass (first hit per prefix) pays the SQLite range-scan + Redis `SET` cost;
  the warm pass is served from Redis and is ~6× faster end-to-end. The p95 served from
  cache stays in the low‑teens of milliseconds.
- The prefix lookup itself is an indexed range scan: `WHERE query >= @lo AND query < @hi`
  on the `query` PRIMARY KEY, ordered by `count`/`recent_score`, `LIMIT 10`.

---

## 3. Cache hit rate

Distributed cache: each prefix key is routed to one of three Redis nodes via consistent
hashing; misses fall back to SQLite and then populate the cache.

| Metric | Value |
|--------|------:|
| Suggest lookups | 3,200 |
| Cache hits | 3,000 |
| Cache misses | 200 |
| **Hit rate** | **93.8 %** |

The miss count equals the number of distinct prefixes (200) — i.e. exactly one cold miss
per key, every subsequent skewed repeat is a hit. This is the expected behavior for a
read-through cache with a 60 s TTL under a realistic, repetitive typing workload.

---

## 4. Write reduction via batching (write-behind)

`/search` does **not** write to SQLite synchronously. It publishes the query to Kafka;
the consumer aggregates each fetched batch (summing duplicate counts) and performs **one**
`upsertBatch` transaction per batch, then warms the affected prefix keys.

| Metric | Value |
|--------|------:|
| `/search` requests submitted | 2,000 |
| SQLite rows written (upserts) | **555** |
| Consumer flushes (batches) | 70 |
| **Write reduction factor** | **3.6×** |
| `/search` throughput | ~732 req/s |

Representative consumer log lines:
```
Kafka consumer: 9 queries -> SQLite, 24 prefixes warmed in cache
Kafka consumer: 8 queries -> SQLite, 24 prefixes warmed in cache
Kafka consumer: 7 queries -> SQLite, 24 prefixes warmed in cache
```
Each flush collapses ~6–9 duplicate events into a single transaction. The reduction
scales with arrival burstiness: faster bursts (or a larger batch window) aggregate more
duplicates per flush and push the factor higher; here the stream arrived steadily, so each
Kafka fetch batch held only a few duplicates of the 25 distinct queries.

**Failure trade-off:** events buffered in Kafka but not yet consumed/flushed survive a
backend crash (they are durable in the Kafka log and re-read on restart from the committed
offset). The narrow window of loss is events accepted by `/search` but not yet acknowledged
to Kafka. This favors low write-latency and DB protection over strict per-request
durability — acceptable for popularity counters where an occasional lost increment is
harmless.

---

## 5. Consistent hashing behavior

The ring places **150 virtual nodes per physical node** (450 ring points for 3 nodes) and
routes each prefix key by `hash(key)` to the first ring point clockwise.

**Ring ownership (share of the hash space, from startup logs / `/cache/nodes`):**
```
redis-cache-1:6379 : 33.48 %
redis-cache-2:6379 : 33.20 %
redis-cache-3:6379 : 33.32 %
```
Near-perfect thirds — the virtual-node trick smooths what would otherwise be a lumpy
3-point ring.

**Actual routing of the 200 test prefixes** (`/cache/debug?prefix=…`):
```
redis-cache-1:6379 : 73 prefixes
redis-cache-2:6379 : 67 prefixes
redis-cache-3:6379 : 60 prefixes
```
Sample routes (prefix → node, keyHash):
```
qr → redis-cache-1  (1115916825)
hf → redis-cache-1  (4213249998)
qb → redis-cache-2  (1444764921)
re → redis-cache-2  ( 265304831)
dq → redis-cache-3  (3077027030)
```
Keys spread across all three nodes roughly in proportion to ownership. Because routing is
hash-based, adding/removing a node only remaps the keys in the affected arcs (≈1/N of keys),
not the whole keyspace.

---

## 6. Design choices & trade-offs

- **Cache layer (Redis + consistent hashing):** sub-millisecond reads on hits and
  horizontal cache scaling; consistent hashing keeps remap churn to ≈1/N when the cluster
  changes. Trade-off: cached suggestions can be up to `TTL` (60 s) stale.
- **Freshness vs latency (TTL + write-behind warming):** the consumer proactively
  re-warms the prefixes it just wrote, so popular prefixes refresh quickly; the TTL bounds
  staleness for the long tail. Lower TTL = fresher but more DB fallback; higher TTL =
  cheaper but staler.
- **Recency-aware ranking:** a `recent_score` column is incremented on each search and
  decayed periodically (`recent_score *= 0.9`), so short-lived spikes fade instead of
  permanently dominating. `ranking=basic` sorts by all-time `count`; `ranking=recency`
  (default) sorts by the decayed score. Trade-off: more background work + a second sort
  index vs. better trending quality.
- **Write-behind batching:** protects SQLite from per-keystroke write pressure (3.6×
  fewer writes here, higher under bursts) at the cost of a small eventual-consistency and
  crash-window trade-off described in §4.

---

*Generated from `scripts/loadtest.mjs` + `/stats`. Re-run the script to regenerate these
figures; absolute numbers vary with hardware and load parameters, but the relationships
(cache >> DB, batched << raw writes, even ring distribution) hold.*
