import express from "express";
import cors from "cors";
import { buildRouter } from "./routes/routes";
import { SuggestionService } from "./services/SuggestionService";
import { CacheCluster } from "./cache/CacheCluster";
import { Database } from "./db/Database";
import { Metrics } from "./metrics/Metrics";
import { AppConfig } from "./config";
import { SearchIntake } from "./types";

export interface App {
  server: express.Express;
  shutdown: () => Promise<void>;
}

export function createApp(deps: {
  config: AppConfig;
  db: Database;
  cache: CacheCluster;
  metrics: Metrics;
  suggestions: SuggestionService;
  intake: SearchIntake;
}): express.Express {
  const server = express();
  server.use(cors());
  server.use(express.json());

  server.use((req, _res, next) => {
    if (req.path !== "/health") {
    }
    next();
  });

  server.use(buildRouter(deps));

  server.get("/", (_req, res) => {
    res.json({
      service: "search-typeahead-backend",
      endpoints: [
        "/suggest?q=",
        "/search (POST)",
        "/trending",
        "/cache/debug?prefix=",
        "/cache/nodes",
        "/stats",
        "/health",
      ],
    });
  });

  return server;
}
