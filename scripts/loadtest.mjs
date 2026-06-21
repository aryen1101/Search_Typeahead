/**
 * Search Typeahead — load test & performance measurement.
 *
 * Plain Node (>=18, uses global fetch + performance). No dependencies.
 * Run the docker stack first (`docker compose up -d`), then:
 *
 *     node scripts/loadtest.mjs                 # against http://localhost:8080
 *     BASE=http://localhost:3000/api node scripts/loadtest.mjs   # through the nginx proxy
 *
 * It exercises three things the assignment asks us to measure and prints a
 * summary you can paste into the performance report:
 *   1. /suggest latency (p50/p95/p99) + cache hit rate under a skewed access pattern
 *   2. write reduction from batch (write-behind) writes via /search
 *   3. consistent-hash routing distribution across the cache nodes
 */

const BASE = process.env.BASE || "http://localhost:8080";

// Tunables (overridable via env).
const SUGGEST_REQUESTS = Number(process.env.SUGGEST_REQUESTS || 3000);
const DISTINCT_PREFIXES = Number(process.env.DISTINCT_PREFIXES || 200);
const SEARCH_REQUESTS = Number(process.env.SEARCH_REQUESTS || 2000);
const DISTINCT_QUERIES = Number(process.env.DISTINCT_QUERIES || 25);
const CONCURRENCY = Number(process.env.CONCURRENCY || 24);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

// ---- prefix corpus -------------------------------------------------------
// Build a realistic prefix pool from common letters / 2-3 char stems.
function buildPrefixPool(n) {
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const pool = [];
  for (const a of letters) pool.push(a);
  for (const a of letters) for (const b of letters) pool.push(a + b);
  // de-dupe, shuffle deterministically, take first n
  const out = [];
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const copy = [...pool];
  while (out.length < n && copy.length) {
    const i = Math.floor(rand() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

// Zipf-ish skewed pick: small indices (popular prefixes) chosen far more often.
function makeSkewedPicker(pool) {
  let seed = 6789;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return () => {
    // bias toward the front of the list (popular prefixes => cache hits)
    const r = rand();
    const idx = Math.floor(pool.length * r * r); // r^2 skews low
    return pool[Math.min(idx, pool.length - 1)];
  };
}

// Run `total` tasks with bounded concurrency; collect per-request latency (ms).
async function runPool(total, makeTask) {
  const latencies = new Array(total);
  let next = 0;
  let errors = 0;
  const t0 = performance.now();
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) return;
      const s = performance.now();
      try {
        await makeTask(i);
        latencies[i] = performance.now() - s;
      } catch {
        latencies[i] = performance.now() - s;
        errors++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const wallMs = performance.now() - t0;
  return { latencies, wallMs, errors };
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
function summarize(latencies) {
  const s = [...latencies].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    count: s.length,
    avg: +(sum / s.length).toFixed(3),
    p50: +pct(s, 50).toFixed(3),
    p95: +pct(s, 95).toFixed(3),
    p99: +pct(s, 99).toFixed(3),
    max: +s[s.length - 1].toFixed(3),
  };
}

// ==========================================================================
async function main() {
  console.log(`\n=== Search Typeahead load test ===`);
  console.log(`Target: ${BASE}`);
  const health = await getJSON("/health");
  console.log(`Backend OK — ${health.queries.toLocaleString()} unique queries indexed\n`);

  const pool = buildPrefixPool(DISTINCT_PREFIXES);
  const pick = makeSkewedPicker(pool);

  // ---- Phase 1: cold pass (every distinct prefix once => mostly misses) ----
  console.log(`[1/4] Cold pass: ${pool.length} distinct prefixes (cache warm-up)…`);
  const cold = await runPool(pool.length, (i) =>
    getJSON(`/suggest?q=${encodeURIComponent(pool[i])}&ranking=recency`),
  );
  const coldStats = summarize(cold.latencies);

  // ---- Phase 2: warm pass (skewed repeats => mostly hits) -----------------
  console.log(`[2/4] Warm pass: ${SUGGEST_REQUESTS} skewed /suggest requests @ concurrency ${CONCURRENCY}…`);
  const warm = await runPool(SUGGEST_REQUESTS, () =>
    getJSON(`/suggest?q=${encodeURIComponent(pick())}&ranking=recency`),
  );
  const warmStats = summarize(warm.latencies);
  const warmThroughput = Math.round((SUGGEST_REQUESTS / warm.wallMs) * 1000);

  // ---- Phase 3: write reduction via /search (write-behind batching) -------
  console.log(`[3/4] Write load: ${SEARCH_REQUESTS} /search posts over ${DISTINCT_QUERIES} distinct queries…`);
  const queries = Array.from({ length: DISTINCT_QUERIES }, (_, i) => `loadtest query ${i}`);
  const beforeStats = await getJSON("/stats");
  let pickSeed = 999;
  const prand = () => ((pickSeed = (pickSeed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const write = await runPool(SEARCH_REQUESTS, async () => {
    const q = queries[Math.floor(prand() * queries.length)];
    const res = await fetch(`${BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    if (!res.ok) throw new Error(`search ${res.status}`);
  });
  const writeThroughput = Math.round((SEARCH_REQUESTS / write.wallMs) * 1000);

  console.log(`      waiting 4s for the write-behind consumer to flush…`);
  await sleep(4000);
  const afterStats = await getJSON("/stats");

  // ---- Phase 4: consistent-hash routing distribution ----------------------
  console.log(`[4/4] Probing consistent-hash routing for ${pool.length} prefixes…`);
  const nodes = await getJSON("/cache/nodes");
  const routeCount = {};
  const sampleRoutes = [];
  for (let i = 0; i < pool.length; i++) {
    const dbg = await getJSON(`/cache/debug?prefix=${encodeURIComponent(pool[i])}`);
    routeCount[dbg.ownerNode] = (routeCount[dbg.ownerNode] || 0) + 1;
    if (i < 8) sampleRoutes.push({ prefix: pool[i], node: dbg.ownerNode, keyHash: dbg.consistentHashing.keyHash });
  }

  // ---- Report -------------------------------------------------------------
  const srvSuggest = afterStats.suggest;
  const writesDelta = {
    searches: afterStats.writes.searchRequestsReceived - beforeStats.writes.searchRequestsReceived,
    rows: afterStats.writes.dbRowsWritten - beforeStats.writes.dbRowsWritten,
    flushes: afterStats.writes.flushes - beforeStats.writes.flushes,
  };
  const reduction =
    writesDelta.rows > 0 ? +(writesDelta.searches / writesDelta.rows).toFixed(2) : null;

  const out = {
    target: BASE,
    datasetUniqueQueries: health.queries,
    config: { SUGGEST_REQUESTS, DISTINCT_PREFIXES, SEARCH_REQUESTS, DISTINCT_QUERIES, CONCURRENCY },
    latencyClientMs: { cold: coldStats, warm: warmStats },
    throughputReqPerSec: { suggestWarm: warmThroughput, search: writeThroughput },
    serverSuggest: {
      requests: srvSuggest.requests,
      cacheHits: srvSuggest.cacheHits,
      cacheMisses: srvSuggest.cacheMisses,
      cacheHitRate: srvSuggest.cacheHitRate,
      latencyMs: srvSuggest.latencyMs,
    },
    writeReduction: {
      searchesSubmitted: writesDelta.searches,
      dbRowsWritten: writesDelta.rows,
      flushes: writesDelta.flushes,
      reductionFactor: reduction,
    },
    consistentHashing: {
      nodes: nodes.nodes,
      virtualNodesPerNode: 150,
      ownershipPercent: nodes.ownershipPercent,
      routedPrefixDistribution: routeCount,
      sampleRoutes,
    },
  };

  console.log(`\n========== RESULTS ==========`);
  console.log(JSON.stringify(out, null, 2));
  console.log(`\n--- headline ---`);
  console.log(`suggest p50/p95/p99 (server): ${srvSuggest.latencyMs.p50} / ${srvSuggest.latencyMs.p95} / ${srvSuggest.latencyMs.p99} ms`);
  console.log(`suggest warm p95 (client):    ${warmStats.p95} ms`);
  console.log(`cache hit rate:               ${(srvSuggest.cacheHitRate * 100).toFixed(1)}%`);
  console.log(`suggest throughput:           ${warmThroughput} req/s`);
  console.log(`write reduction:              ${writesDelta.searches} searches -> ${writesDelta.rows} DB rows (${reduction}x) in ${writesDelta.flushes} flushes`);
  console.log(`ring ownership:               ${JSON.stringify(nodes.ownershipPercent)}`);
  console.log(`routed prefix distribution:   ${JSON.stringify(routeCount)}`);
}

main().catch((e) => {
  console.error("Load test failed:", e.message);
  process.exit(1);
});
