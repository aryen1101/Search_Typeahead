# Search Typeahead

A search‑as‑you‑type system that suggests popular queries while you type, records
searches, and serves suggestions with low latency from a **distributed cache** (Redis +
consistent hashing) backed by SQLite, with **write‑behind batching** via Kafka and a
**recency‑aware trending** ranking.

## Demo video
https://drive.google.com/file/d/1KxaegMsXSIbjEC45-4T06HSE5j6S_TzJ/view?usp=drive_link

---

## Documentation index

| Document | Contents |
|---|---|
| **README.md** (this file) | Overview, features, tech stack, setup & run |
| [docs/DATASET.md](docs/DATASET.md) | Dataset source, format, and loading instructions |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, components, data model, request flows |
| [docs/API.md](docs/API.md) | API reference (endpoints, params, responses, examples) |
| [docs/PERFORMANCE_REPORT.md](docs/PERFORMANCE_REPORT.md) | Latency, cache hit rate, write reduction, consistent hashing |
| [docs/DESIGN_CHOICES.md](docs/DESIGN_CHOICES.md) | Design decisions and trade‑offs |

---

## Features → requirements

| Requirement | Implementation |
|---|---|
| Type a prefix → top‑10 suggestions sorted by count | `GET /suggest` |
| UI: search box + live dropdown + trending | `frontend/` (static SPA) |
| Dummy search API that records the query | `POST /search` → `{ "message": "Searched" }` |
| Query‑count storage | SQLite (`better-sqlite3`, WAL) |
| Distributed cache with **consistent hashing** | 3 Redis nodes, 150 virtual nodes/node |
| Cache expiry / invalidation | 60 s TTL per prefix key + re‑warm on write |
| **Trending** (recency‑aware) | `recent_score` + periodic decay |
| **Batch writes** | Kafka write‑behind consumer, one DB transaction per batch |

---

## Tech stack
Node 20 · Express 5 · better‑sqlite3 (WAL) · Redis 7 ×3 · Apache Kafka 3.8 · nginx ·
Docker Compose. Frontend is dependency‑free HTML/CSS/JS.

---

## Setup & run

```bash
docker compose up -d --build
```

- Frontend: **http://localhost:3000**
- Backend API: **http://localhost:8080**
- Reset & re‑seed: `docker compose down -v && docker compose up -d`

The dataset is downloaded automatically on first start if it is missing — no separate
step is needed. See [docs/DATASET.md](docs/DATASET.md) for details.

---

## Repository layout
```
backend/     Express API, cache ring, SQLite, Kafka producer/consumer, services
frontend/    Static SPA (HTML/CSS/JS) + nginx (serves UI, proxies /api to backend)
scripts/     fetch-dataset.mjs (manual dataset download), loadtest.mjs (performance)
data/        queries.tsv (auto-downloaded dataset)
docs/        DATASET, ARCHITECTURE, API, PERFORMANCE_REPORT, DESIGN_CHOICES
docker-compose.yml   redis x3 + kafka + backend + frontend
```
