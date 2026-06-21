# Design Choices & Trade‑offs

## 1. Storage: SQLite (better‑sqlite3, WAL) as the primary store
**Why:** zero‑config, embedded, and very fast for this workload. The `query` PRIMARY KEY is
a B‑tree, so prefix matching is an **indexed range scan**
(`query >= prefix AND query < prefix||'￿'`) with `LIMIT 10` — no full scan. WAL +
`synchronous = NORMAL` keep writes cheap.
**Trade‑off:** single‑node (no replication/sharding). Fine for the assignment's scale;
a production system would move to a replicated/partitioned store. Reliable enough for the
demo.

## 2. Caching: read‑through Redis with a 60 s TTL
**Why:** suggestions are read‑heavy and repetitive (every keystroke). A read‑through cache
turns most lookups into sub‑millisecond Redis hits and shields SQLite. Measured **93.8 %**
hit rate and ~6× faster warm reads.
**Trade‑off:** cached entries can be up to the TTL (60 s) stale. Mitigated by re‑warming
affected prefixes on every write, so popular prefixes refresh quickly; the TTL only bounds
staleness for the long tail. Lower TTL = fresher but more DB fallback; higher TTL =
cheaper but staler.

## 3. Distributed cache via consistent hashing (150 virtual nodes/node)
**Why:** spreads keys evenly across the 3 Redis nodes (~33/33/33) and, crucially, keeps
re‑mapping small (≈1/N of keys) when a node is added/removed — unlike modulo hashing, which
reshuffles almost everything. Virtual nodes prevent the lumpiness of a tiny physical ring.
**Trade‑off:** more moving parts (a ring, per‑node clients) and a hash computation per
lookup — negligible versus the network/DB cost it saves.

## 4. Write path: write‑behind batching through Kafka
**Why:** the assignment requires reducing synchronous DB writes. `/search` publishes to
Kafka and returns immediately; a consumer drains the topic in batches, **aggregates
duplicate queries**, and applies one transaction per batch — measured **3.6×** fewer DB
writes (more under bursts). Kafka also gives durability and natural back‑pressure.
**Trade‑off:** eventual consistency (counts appear after the next flush) and a small crash
window for events accepted by `/search` but not yet acknowledged to Kafka. Acceptable for
popularity counters where a rare lost increment is harmless. A `BatchWriter` fallback
provides the same batching in‑memory when Kafka is not configured (standalone local runs),
trading durability for simplicity.

## 5. Trending: recency score + periodic decay
**Why:** all‑time count alone makes historically popular queries dominate forever. Each
search bumps a `recent_score`; a timer multiplies all scores by `0.9` every 60 s. Recent
activity ranks higher, and decay ensures a brief spike fades instead of permanently
over‑ranking a query. The **same `/suggest` API** supports both modes: `ranking=basic`
(all‑time `count`) and `ranking=recency` (decayed score, default).
**Trade‑off:** a little background work and a second sort index (`idx_recent`). The decay
rate/interval are tunable knobs balancing freshness vs. stability. When rankings change, the
cache is refreshed by re‑warming on write plus TTL expiry.

## 6. Frontend: dependency‑free static SPA behind nginx
**Why:** no build toolchain to fail; nginx serves the static files and proxies `/api/*` to
the backend, so the browser stays same‑origin (no CORS issues). Debounced input avoids
unnecessary backend calls.
**Trade‑off:** no component framework — fine for a small, focused UI.

## Summary table
| Area | Choice | Main trade‑off |
|---|---|---|
| Primary store | SQLite (WAL) | single node |
| Cache | Redis read‑through, 60 s TTL | bounded staleness |
| Cache distribution | Consistent hashing, 150 vnodes | slight added complexity |
| Writes | Kafka write‑behind batching | eventual consistency, small crash window |
| Trending | recency score + decay | extra index + tuning knobs |
| Frontend | static SPA + nginx proxy | no framework |
