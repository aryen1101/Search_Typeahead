# API Documentation

**Base URL:** `http://localhost:8080` (direct) or `http://localhost:3000/api` (through the
frontend's nginx proxy). All responses are JSON.

| Method | Path | Purpose |
|---|---|---|
| GET | `/suggest` | Prefix suggestions (typeahead) |
| POST | `/search` | Record a search (dummy response) |
| GET | `/trending` | Trending queries |
| GET | `/cache/debug` | Cache routing for a prefix |
| GET | `/cache/nodes` | Cache cluster overview |
| GET | `/stats` | Performance metrics |
| GET | `/health` | Liveness |

---

## GET /suggest
Returns up to 10 suggestions whose query starts with the prefix, sorted descending.

**Query params**
| Param | Required | Default | Notes |
|---|---|---|---|
| `q` | yes | — | The prefix. Normalized (lowercased, whitespace‑collapsed). Empty/short → empty list. |
| `ranking` | no | `recency` | `basic` = sort by all‑time `count`; `recency` = sort by recent score. |

**Example**
```bash
curl "http://localhost:8080/suggest?q=iph&ranking=basic"
```
**Response 200**
```json
{
  "prefix": "iph",
  "ranking": "basic",
  "source": "cache",
  "node": "redis-cache-3:6379",
  "count": 10,
  "suggestions": [
    { "query": "iphoto", "count": 608838, "score": 608838 },
    { "query": "iphone", "count": 50988,  "score": 50988 }
  ],
  "tookMs": 1.83
}
```
`source` is `cache` or `db`; `node` is the owning cache node; `tookMs` is server‑side
latency. Mixed case, empty, missing, and no‑match prefixes are all handled gracefully
(empty `suggestions`).

---

## POST /search
Records a submitted search and returns a dummy acknowledgement. The count update is applied
asynchronously (write‑behind), so it appears in suggestions/trending shortly after.

**Body**
```json
{ "query": "iphone 15" }
```
**Example**
```bash
curl -X POST "http://localhost:8080/search" \
     -H "Content-Type: application/json" \
     -d '{"query":"iphone 15"}'
```
**Response 200**
```json
{ "message": "Searched" }
```
**Response 400** (missing/empty query)
```json
{ "error": "missing_query", "message": "Body must include { query }" }
```

---

## GET /trending
Top queries by recency score.

**Query params:** `limit` (optional, default 10, max 50).
```bash
curl "http://localhost:8080/trending?limit=5"
```
```json
{
  "ranking": "recency",
  "suggestions": [
    { "query": "the", "count": 23135851162, "score": 26050.23 }
  ]
}
```

---

## GET /cache/debug
Shows how a prefix is routed through the consistent‑hash ring and whether it is cached.

**Query params:** `prefix` (required), `ranking` (optional).
```bash
curl "http://localhost:8080/cache/debug?prefix=iph"
```
```json
{
  "prefix": "iph",
  "ranking": "recency",
  "ownerNode": "redis-cache-3:6379",
  "status": "HIT",
  "ttlSeconds": 60,
  "cachedSuggestionCount": 9,
  "consistentHashing": {
    "keyHash": 517625183,
    "ringPointHash": 524673431,
    "virtualNodesPerNode": 150,
    "totalRingPoints": 450
  },
  "valueKey": "sug:recency:iph"
}
```
`status` is `HIT` or `MISS`.

---

## GET /cache/nodes
Cluster membership, ring ownership share, and per‑node hit/miss stats.
```bash
curl "http://localhost:8080/cache/nodes"
```
```json
{
  "nodes": ["redis-cache-1:6379", "redis-cache-2:6379", "redis-cache-3:6379"],
  "ownershipPercent": {
    "redis-cache-1:6379": 33.48,
    "redis-cache-2:6379": 33.20,
    "redis-cache-3:6379": 33.32
  },
  "perNodeStats": [
    { "id": "redis-cache-1:6379", "hits": 0, "misses": 0, "keys": -1, "backend": "redis" }
  ]
}
```

---

## GET /stats
Aggregate metrics (used for the performance report).
```bash
curl "http://localhost:8080/stats"
```
```json
{
  "uptimeSeconds": 175,
  "suggest": {
    "requests": 3200,
    "cacheHits": 3000,
    "cacheMisses": 200,
    "cacheHitRate": 0.9375,
    "latencyMs": { "p50": 1.256, "p95": 13.331, "p99": 34.367, "samples": 3200 }
  },
  "writes": {
    "searchRequestsReceived": 2000,
    "dbRowsWritten": 555,
    "flushes": 70,
    "cacheInvalidations": 1680,
    "writeReductionFactor": 3.6
  },
  "recency": { "decayTicks": 2 },
  "dataset": { "uniqueQueries": 591775 },
  "cache": { "nodes": ["..."], "ownershipPercent": { "...": 33.3 }, "perNode": ["..."] },
  "ingestion": { "mode": "kafka", "pendingBufferSize": 0 }
}
```

---

## GET /health
```bash
curl "http://localhost:8080/health"
```
```json
{ "status": "ok", "queries": 591775, "uptimeSec": 361 }
```
