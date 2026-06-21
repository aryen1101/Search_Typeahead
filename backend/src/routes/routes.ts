import { Router, Request, Response } from "express";
import { SuggestionService } from "../services/SuggestionService";
import { CacheCluster } from "../cache/CacheCluster";
import { Database } from "../db/Database";
import { Metrics } from "../metrics/Metrics";
import { Ranking, AppConfig } from "../config";
import { SearchIntake } from "../types";

interface Deps {
  suggestions: SuggestionService;
  intake: SearchIntake;
  cache: CacheCluster;
  db: Database;
  metrics: Metrics;
  config: AppConfig;
}

function parseRanking(value: unknown, def: Ranking): Ranking {
  return value === "basic" || value === "recency" ? value : def;
}

export function buildRouter(deps: Deps): Router {
  const router = Router();
  const { suggestions, intake, cache, db, metrics, config } = deps;

  router.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      queries: db.size(),
      uptimeSec: metrics.snapshot().uptimeSeconds,
    });
  });

  router.get("/suggest", async (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const ranking = parseRanking(req.query.ranking, config.defaultRanking);
    const result = await suggestions.suggest(q, ranking);
    res.json(result);
  });

  router.post("/search", async (req: Request, res: Response) => {
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query.trim()) {
      return res.status(400).json({
        error: "missing_query",
        message: "Body must include { query }",
      });
    }
    const result = await intake.record(query);
    res.json(result);
  });

  router.get("/trending", (req: Request, res: Response) => {
    const limit = Math.min(
      50,
      Math.max(1, Number(req.query.limit) || config.suggestLimit),
    );
    res.json({ ranking: "recency", suggestions: suggestions.trending(limit) });
  });

  router.get("/cache/debug", async (req: Request, res: Response) => {
    const prefix =
      typeof req.query.prefix === "string"
        ? req.query.prefix.toLowerCase().trim()
        : "";
    const ranking = parseRanking(req.query.ranking, config.defaultRanking);
    if (!prefix) {
      return res
        .status(400)
        .json({ error: "missing_prefix", message: "Pass ?prefix=<text>" });
    }
    const info = await cache.debug(prefix, ranking);
    res.json({
      prefix,
      ranking,
      ownerNode: info.route.nodeId,
      status: info.status,
      ttlSeconds: info.ttlSeconds,
      cachedSuggestionCount: info.cachedCount,
      consistentHashing: {
        keyHash: info.route.keyHash,
        ringPointHash: info.route.ringPointHash,
        virtualNodesPerNode: info.route.virtualNodesPerNode,
        totalRingPoints: info.route.totalRingPoints,
      },
      valueKey: info.valueKey,
    });
  });

  router.get("/cache/nodes", (_req: Request, res: Response) => {
    res.json({
      nodes: cache.ring_().listNodes(),
      ownershipPercent: cache.ownership(),
      perNodeStats: cache.nodeStats(),
    });
  });

  router.get("/stats", (_req: Request, res: Response) => {
    res.json({
      ...metrics.snapshot(),
      dataset: { uniqueQueries: db.size() },
      cache: {
        nodes: cache.ring_().listNodes(),
        ownershipPercent: cache.ownership(),
        perNode: cache.nodeStats(),
      },
      ingestion: { mode: intake.mode, pendingBufferSize: intake.pendingSize() },
    });
  });

  return router;
}
