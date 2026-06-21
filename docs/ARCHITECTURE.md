# Architecture

## High‑level diagram

```
   Browser (frontend SPA)
        │  GET /api/suggest?q=...           POST /api/search
        ▼
   ┌──────────────────────────┐
   │  nginx (frontend container)  serves static UI + proxies /api/* → backend:8080
   └─────────────┬────────────┘
                 ▼
   ┌──────────────────────────────── Backend (Express) ───────────────────────────────┐
   │                                                                                    │
   │  READ  GET /suggest ─► SuggestionService                                           │
   │                         │ 1. consistent-hash the prefix → owning Redis node        │
   │                         │ 2. GET from that node ── hit ──► return                  │
   │                         │ 3. miss → SQLite prefix range scan (top-10)              │
   │                         │ 4. SET result on the owning node (TTL 60s) → return      │
   │                                                                                    │
   │  WRITE POST /search ─► SearchProducer ─► Kafka topic "search-events" (3 partitions)│
   │                                              │  (returns {message:"Searched"} now) │
   │                                              ▼                                      │
   │                                   SearchConsumer (write-behind)                    │
   │                                     • aggregate duplicates per batch               │
   │                                     • one upsert transaction → SQLite              │
   │                                     • re-warm affected prefix keys in Redis        │
   │                                                                                    │
   │  RecencyDecay (timer): UPDATE recent_score = recent_score * 0.9  every 60s         │
   │                                                                                    │
   │  Stores:   SQLite (primary)        Redis ×3 (distributed cache via hash ring)      │
   └────────────────────────────────────────────────────────────────────────────────┘
```

## Components

| Component | File(s) | Responsibility |
|---|---|---|
| HTTP API | `backend/src/app.ts`, `routes/routes.ts` | Express routes, JSON, CORS |
| Suggestion service | `services/SuggestionService.ts` | Cache‑first read path, normalization |
| Cache cluster | `cache/CacheCluster.ts`, `cache/CacheNode.ts` | Get/set across nodes, debug, stats |
| Consistent hash ring | `cache/ConsistenHashRing.ts`, `cache/hash.ts` | Prefix → node routing |
| Database | `db/Database.ts`, `db/seed.ts`, `db/normalize.ts` | SQLite schema, queries, seeding |
| Write path (Kafka) | `queue/KafkaClient.ts`, `SearchProducer.ts`, `SearchConsumer.ts` | Write‑behind ingestion + batching |
| Batch writer (fallback) | `services/BatchWrites.ts` | In‑memory batching when Kafka is absent |
| Recency decay | `services/RecencyDecay.ts` | Periodic score decay for trending |
| Metrics | `metrics/Metrics.ts` | Latency percentiles, hit rate, write reduction |

## Data model (SQLite)

```sql
CREATE TABLE queries (
  query        TEXT PRIMARY KEY,   -- normalized (lowercase, single-spaced)
  count        INTEGER NOT NULL,   -- all-time search count
  recent_score REAL    NOT NULL,   -- decayed recency score (drives trending)
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_recent ON queries(recent_score DESC);
```

- `query` is the PRIMARY KEY (a B‑tree), so prefix matches are an **indexed range scan**:
  `WHERE query >= @prefix AND query < @prefix||'￿'`, ordered by `count` (basic) or
  `recent_score` (recency), `LIMIT 10`.
- WAL mode + `synchronous = NORMAL` for fast writes.

## Distributed cache & consistent hashing

- The ring places **150 virtual nodes per physical node** (450 ring points for 3 nodes),
  each at `hash(nodeId#vnN)`. A key is routed to the first ring point clockwise from
  `hash(key)`.
- Virtual nodes smooth distribution: ownership lands at ≈33.5 / 33.2 / 33.3 % for the three
  nodes (see the performance report).
- Cache key = `sug:<ranking>:<prefix>`; value = the JSON top‑10; TTL = 60 s.
- **Invalidation:** when the consumer writes a query, it re‑computes and re‑warms every
  affected prefix key, so popular prefixes stay fresh; the TTL bounds staleness for the
  long tail.
- Adding/removing a node only remaps the keys in the affected arcs (≈1/N), not the whole
  keyspace.

## Read path (`GET /suggest`)
1. Normalize the prefix (lowercase, collapse whitespace).
2. Route to the owning Redis node via the ring.
3. Cache hit → return immediately (`source: "cache"`).
4. Cache miss → SQLite prefix range scan (top‑10) → set on the owning node (60 s TTL) →
   return (`source: "db"`).

## Write path (`POST /search`)
1. Publish the query to Kafka; respond `{ "message": "Searched" }` right away (no
   synchronous DB write).
2. The consumer reads in batches, **aggregates duplicate queries** (summing counts), and
   applies a **single upsert transaction** to SQLite.
3. It then re‑warms the affected prefix keys in the cache.
4. If `KAFKA_BROKERS` is unset, an in‑memory `BatchWriter` provides the same batching
   behavior (flush by size or interval) for standalone local runs.

## Trending (recency)
- Each search increments `recent_score` along with `count`.
- A timer decays all scores (`recent_score *= 0.9`) every 60 s, so brief spikes fade and do
  not permanently dominate.
- `GET /suggest?ranking=basic` sorts by `count`; `ranking=recency` (default) sorts by
  `recent_score`. `GET /trending` returns the global top by `recent_score`.

## Deployment (docker‑compose)
`redis-cache-1/2/3` (cache nodes) · `kafka` (KRaft mode) · `backend` (API) ·
`frontend` (nginx). The backend depends on all caches + Kafka being healthy before start.
