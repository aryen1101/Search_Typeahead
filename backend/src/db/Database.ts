import * as fs from "fs";
import * as path from "path";
import { Ranking } from "../config";
import { Suggestion, QueryRow, BatchEntry } from "../types";
import BetterSqlite3 from "better-sqlite3";
import { normalize } from "./normalize";

export class Database {
  private db: BetterSqlite3.Database;
  private stmtUpsert!: BetterSqlite3.Statement;
  private stmtTrending!: BetterSqlite3.Statement;
  private stmtCount!: BetterSqlite3.Statement;
  private stmtGetOne!: BetterSqlite3.Statement;
  private stmtDecay!: BetterSqlite3.Statement;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS queries (
        query        TEXT PRIMARY KEY,
        count        INTEGER NOT NULL DEFAULT 0,
        recent_score REAL    NOT NULL DEFAULT 0,
        updated_at   INTEGER NOT NULL DEFAULT 0
      );
      -- Index used by the global trending list (ORDER BY recent_score DESC).
      CREATE INDEX IF NOT EXISTS idx_recent ON queries(recent_score DESC);`);

    this.stmtUpsert = this.db.prepare(`
      INSERT INTO queries (query, count, recent_score, updated_at)
      VALUES (@query, @delta, @delta, @now)
      ON CONFLICT(query) DO UPDATE SET
        count        = count + @delta,
        recent_score = recent_score + @delta,
        updated_at   = @now
    `);

    this.stmtTrending = this.db.prepare(`
      SELECT query, count, recent_score
      FROM queries
      ORDER BY recent_score DESC, count DESC
      LIMIT @limit
    `);

    this.stmtCount = this.db.prepare(`SELECT COUNT(*) AS c FROM queries`);
    this.stmtGetOne = this.db.prepare(`SELECT * FROM queries WHERE query = ?`);
    this.stmtDecay = this.db.prepare(
      `UPDATE queries SET recent_score = recent_score * ?`,
    );
  }

  size(): number {
    return (this.stmtCount.get() as { c: number }).c;
  }

  isEmpty(): boolean {
    return this.size() === 0;
  }

  getOne(query: string): QueryRow | undefined {
    return this.stmtGetOne.get(normalize(query)) as QueryRow | undefined;
  }

  upsertBatch(entries: BatchEntry[], now: number): number {
    if (entries.length === 0) return 0;
    const tx = this.db.transaction((rows: BatchEntry[]) => {
      for (const r of rows) {
        this.stmtUpsert.run({ query: r.query, delta: r.delta, now });
      }
    });
    tx(entries);
    return entries.length;
  }

  bulkInsertSeed(rows: { query: string; count: number }[], now: number): void {
    const insert = this.db.prepare(`
      INSERT INTO queries (query, count, recent_score, updated_at)
      VALUES (@query, @count, @count, @now)
      ON CONFLICT(query) DO UPDATE SET
        count        = count + excluded.count,
        recent_score = recent_score + excluded.count
    `);
    const tx = this.db.transaction((batch: { query: string; count: number }[]) => {
      for (const r of batch) insert.run({ query: r.query, count: r.count, now });
    });
    tx(rows);
  }

  topKByPrefix(prefix: string, limit: number, ranking: Ranking): Suggestion[] {
    const norm = normalize(prefix);
    if (norm === "") return [];

    const orderCol = ranking === "basic" ? "count" : "recent_score";
    const stmt = this.db.prepare(`
      SELECT query, count, recent_score
      FROM queries
      WHERE query >= @lo AND query < @hi
      ORDER BY ${orderCol} DESC, count DESC
      LIMIT @limit
    `);
    const lo = norm;
    const hi = norm + "￿";
    const rows = stmt.all({ lo, hi, limit }) as QueryRow[];
    return rows.map((r) => ({
      query: r.query,
      count: r.count,
      score: ranking === "basic" ? r.count : r.recent_score,
    }));
  }

  trending(limit: number): Suggestion[] {
    const rows = this.stmtTrending.all({ limit }) as QueryRow[];
    return rows.map((r) => ({ query: r.query, count: r.count, score: r.recent_score }));
  }

  decay(rate: number): void {
    this.stmtDecay.run(rate);
  }

  close(): void {
    this.db.close();
  }
}
