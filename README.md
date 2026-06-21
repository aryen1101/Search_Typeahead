# Search Typeahead

A search‑as‑you‑type system that suggests popular queries while you type, records
searches, and serves suggestions with low latency from a **distributed cache** (Redis +
consistent hashing) backed by SQLite, with **write‑behind batching** via Kafka and a
**recency‑aware trending** ranking.

- **Demo video:** https://drive.google.com/file/d/1KxaegMsXSIbjEC45-4T06HSE5j6S_TzJ/view?usp=drive_link
- **Full report (PDF):** [REPORT.pdf](REPORT.pdf) — architecture, dataset, API, design choices, performance.

---

## Tech stack
Node 20 · Express 5 · better‑sqlite3 (WAL) · Redis 7 ×3 · Apache Kafka 3.8 · nginx ·
Docker Compose. Frontend is dependency‑free HTML/CSS/JS.

## Features → requirements

| Requirement | Implementation |
|---|---|
| Type a prefix → top‑10 suggestions sorted by count | `GET /suggest` |
| UI: search box + live dropdown + trending | `frontend/` (static SPA) |
| Dummy search API that records the query | `POST /search` → `{ "message": "Searched" }` |
| Query‑count storage | SQLite (`better-sqlite3`, WAL) |
| Distributed cache with consistent hashing | 3 Redis nodes, 150 virtual nodes/node |
| Cache expiry / invalidation | 60 s TTL per prefix key + re‑warm on write |
| Trending (recency‑aware) | `recent_score` + periodic decay |
| Batch writes | Kafka write‑behind consumer, one DB transaction per batch |

---

## Setup & run

```bash
docker compose up -d --build
```

- Frontend: **http://localhost:3000**
- Backend API: **http://localhost:8080**
- Reset & re‑seed: `docker compose down -v && docker compose up -d`

The dataset is downloaded and seeded automatically on first start if it is missing — no
separate step is needed.

---

## 1. Architecture

```
   Browser (frontend SPA)
        |  GET /api/suggest?q=...            POST /api/search
        v
   +--------------------------+
   |  nginx (frontend)  serves static UI + proxies /api/* -> backend:8080
   +-------------+------------+
                 v
   +============================== Backend (Express) ============================+
   |                                                                             |
   |  READ  GET /suggest -> SuggestionService                                    |
   |          1. consistent-hash the prefix -> owning Redis node                 |
   |          2. GET from that node -- hit --> return                            |
   |          3. miss -> SQLite prefix range scan (top-10)                       |
   |          4. SET result on owning node (TTL 60s) --> return                  |
   |                                                                             |
   |  WRITE POST /search -> Producer -> Kafka "search-events" (3 partitions)     |
   |                          |  (returns {message:"Searched"} now)              |
   |                          v                                                  |
   |               SearchConsumer (write-behind)                                 |
   |                 - aggregate duplicate queries per batch                     |
   |                 - one upsert transaction -> SQLite                          |
   |                 - re-warm affected prefix keys in Redis                     |
   |                                                                             |
   |  RecencyDecay timer: recent_score *= 0.9 every 60s  ->  trending freshness  |
   |  Stores:  SQLite (primary)     Redis x3 (distributed cache via hash ring)   |
   +=============================================================================+
```

**Components**

| Component | File(s) | Responsibility |
|---|---|---|
| HTTP API | `app.ts`, `routes/routes.ts` | Express routes, JSON, CORS |
| Suggestion service | `services/SuggestionService.ts` | Cache‑first read path, normalization |
| Cache cluster | `cache/CacheCluster.ts`, `CacheNode.ts` | Get/set across nodes, debug, stats |
| Consistent hash ring | `cache/ConsistenHashRing.ts`, `hash.ts` | Prefix → node routing |
| Database | `db/Database.ts`, `seed.ts`, `normalize.ts` | SQLite schema, queries, seeding |
| Write path (Kafka) | `queue/KafkaClient`, `SearchProducer`, `SearchConsumer` | Write‑behind ingestion + batching |
| Batch writer (fallback) | `services/BatchWrites.ts` | In‑memory batching when Kafka is absent |
| Recency decay | `services/RecencyDecay.ts` | Periodic score decay for trending |
| Metrics | `metrics/Metrics.ts` | Latency percentiles, hit rate, write reduction |

**Data model (SQLite)**

```sql
CREATE TABLE queries (
  query        TEXT PRIMARY KEY,   -- normalized (lowercase, single-spaced)
  count        INTEGER NOT NULL,   -- all-time search count
  recent_score REAL    NOT NULL,   -- decayed recency score (drives trending)
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_recent ON queries(recent_score DESC);
```

The `query` PRIMARY KEY is a B‑tree, so prefix matching is an indexed range scan
(`query >= prefix AND query < prefix||'￿'`), ordered by `count` (basic) or `recent_score`
(recency), `LIMIT 10`. WAL + `synchronous = NORMAL` keep writes cheap.

**Flows**
- **Read (/suggest):** consistent hashing maps the prefix to one Redis node. Hit → instant.
  Miss → indexed SQLite range scan, then cache the result for 60 s.
- **Write (/search):** publishes to Kafka and returns immediately (no synchronous DB write).
  The consumer drains the topic in batches, collapses duplicate queries into one
  transaction, and re‑warms affected prefixes.
- **Trending:** each search bumps `recent_score`; a timer decays all scores by `×0.9` every
  minute so short spikes fade. `ranking=recency` (default) sorts by this score;
  `ranking=basic` sorts by all‑time `count`.

**Consistent hashing:** 150 virtual nodes per physical node (450 ring points for 3 nodes);
a key routes to the first ring point clockwise from `hash(key)`. Cache key =
`sug:<ranking>:<prefix>`, value = JSON top‑10, TTL = 60 s. Adding/removing a node remaps
only ≈1/N of keys.

---

## 2. Dataset source & loading

**Source:** Peter Norvig's open‑source n‑gram frequency lists —
[`count_1w.txt`](https://norvig.com/ngrams/count_1w.txt) (single words) and
[`count_2w.txt`](https://norvig.com/ngrams/count_2w.txt) (bigrams).

**Format & size:** one record per line, `query<TAB>count` (exactly the expected input).
Concatenating the lists gives ~620,000 rows → **~591,000 unique queries** after
normalization (above the 100,000 minimum).

```
the      23135851162
java     55360149
iphone   50988
```

**Loading — automatic (default):** the backend seeds on startup if empty; if the dataset
file is missing it downloads it from the source URLs, saves it, and loads it — so
`docker compose up` works on a fresh clone with no extra step (internet required; no
synthetic fallback). Rows are inserted in batches of 5,000 inside SQLite transactions;
duplicate counts are summed.

**Loading — manual (optional):**
```bash
node scripts/fetch-dataset.mjs
node scripts/fetch-dataset.mjs --words-only
```
In Docker, `data/queries.tsv` is mounted at `/seed/queries.tsv` and used if present;
otherwise the auto‑download writes to the data volume.
Re‑seed: `docker compose down -v && docker compose up -d`.

---

## 3. API documentation

Base URL: `http://localhost:8080` (direct) or `http://localhost:3000/api` (frontend proxy).
All responses are JSON.

| Method & path | Purpose | Response |
|---|---|---|
| `GET /suggest?q=<prefix>&ranking=recency\|basic` | Top‑10 suggestions | `{ prefix, ranking, source, node, count, suggestions[], tookMs }` |
| `POST /search` body `{ "query": "..." }` | Record a search | `{ "message": "Searched" }` (400 if query missing) |
| `GET /trending?limit=10` | Trending queries | `{ ranking, suggestions[] }` |
| `GET /cache/debug?prefix=<p>` | Cache routing for a prefix | owner node, HIT/MISS, key hash, ring info |
| `GET /cache/nodes` | Cluster overview | nodes + ownership % + per‑node stats |
| `GET /stats` | Metrics | latency p50/p95/p99, cache hit rate, write reduction |
| `GET /health` | Liveness | `{ status, queries, uptimeSec }` |

```bash
curl "http://localhost:8080/suggest?q=iph&ranking=basic"
curl -X POST "http://localhost:8080/search" -H "Content-Type: application/json" -d '{"query":"iphone 15"}'
curl "http://localhost:8080/cache/debug?prefix=iph"
```

Sample `GET /suggest?q=iph` response:
```json
{
  "prefix": "iph", "ranking": "recency", "source": "cache", "node": "redis-cache-3:6379",
  "count": 10,
  "suggestions": [ { "query": "iphoto", "count": 608838, "score": 608838 } ],
  "tookMs": 1.83
}
```

---

## 4. Design choices & trade‑offs

| Area | Choice | Trade‑off |
|---|---|---|
| Primary store | SQLite (WAL) — zero‑config, fast indexed prefix scans | Single node (no replication/sharding); fine for this scale |
| Cache | Read‑through Redis, 60 s TTL — sub‑ms hits (93.8%) | Up to 60 s stale; mitigated by re‑warm on write |
| Cache distribution | Consistent hashing, 150 vnodes — even spread, ≈1/N remap | Slightly more complexity + a hash per lookup |
| Writes | Kafka write‑behind batching — 3.6× fewer DB writes | Eventual consistency + small crash window before Kafka ack |
| Trending | `recent_score` + periodic `×0.9` decay | Minor background work + a second sort index |
| Frontend | Static SPA + nginx `/api` proxy — same‑origin, no build | No component framework |

**Write‑path failure trade‑off:** events buffered in Kafka survive a backend crash (durable
in the log, replayed from the committed offset). The only loss window is events accepted by
`/search` but not yet acknowledged to Kafka — acceptable for popularity counters. A
`BatchWriter` fallback gives the same batching in‑memory when Kafka is not configured.

---

## 5. Performance report

Measured via `node scripts/loadtest.mjs` + `/stats`. Workload: 3,000 `/suggest` requests
over 200 prefixes (skewed/Zipf‑like), 2,000 `/search` posts over 25 distinct queries,
concurrency 24. Dataset ~591,775 unique queries.

**Latency (`/suggest`)**

| Metric | p50 | p95 | p99 |
|---|---:|---:|---:|
| Server‑side (3,200 samples) | **1.26 ms** | **13.33 ms** | 34.37 ms |
| Client‑side, warm (cache hits) | 7.65 ms | 13.59 ms | 19.31 ms |
| Client‑side, cold (cache miss → SQLite) | 44.16 ms | 101.94 ms | 138.35 ms |

Throughput: **~2,897 `/suggest` req/s**.

**Cache hit rate:** 3,000 hits / 200 misses of 3,200 lookups = **93.8 %** (one cold miss per
distinct prefix; every skewed repeat is a hit).

**Write reduction:** 2,000 searches → **555** DB rows in 70 flushes = **3.6×** (each Kafka
batch collapses ~6–9 duplicate events into one transaction; grows with burstiness).

**Consistent hashing:** ring ownership `33.48 / 33.20 / 33.32 %`; routing 200 test prefixes
spread 73 / 67 / 60 across the three nodes.

---

## Repository layout
```
backend/     Express API, cache ring, SQLite, Kafka producer/consumer, services
frontend/    Static SPA (HTML/CSS/JS) + nginx (serves UI, proxies /api to backend)
scripts/     fetch-dataset.mjs (manual dataset download), loadtest.mjs (performance)
data/        queries.tsv (auto-downloaded dataset)
docker-compose.yml   redis x3 + kafka + backend + frontend
REPORT.pdf   full submission report (same content as sections 1-5 above)
```
