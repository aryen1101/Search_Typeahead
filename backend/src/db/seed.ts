import * as fs from "fs";
import * as readline from "readline";
import { Database } from "./Database";
import { normalize } from "./normalize";
import { log } from "../logger";

async function loadFromFile(db: Database, file: string): Promise<number> {
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  const now = Date.now();
  let buffer: { query: string; count: number }[] = [];
  let total = 0;

  const flush = () => {
    if (buffer.length) {
      db.bulkInsertSeed(buffer, now);
      total += buffer.length;
      buffer = [];
    }
  };

  let first = true;
  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) continue;

    const parts = raw.split(/\t|,/);
    if (parts.length < 2) continue;
    const count = Number(parts[parts.length - 1]);
    const query = normalize(parts.slice(0, parts.length - 1).join(" "));
    if (first && (!Number.isFinite(count) || query === "query")) {
      first = false;
      continue;
    }
    first = false;
    if (!query || !Number.isFinite(count)) continue;
    buffer.push({ query, count });
    if (buffer.length >= 5000) flush();
  }
  flush();
  return total;
}

export async function seedIfEmpty(
  db: Database,
  opts: { seedFile: string },
): Promise<number> {
  if (!db.isEmpty()) {
    const n = db.size();
    log.info(`DB already has ${n.toLocaleString()} queries - skipping load.`);
    return n;
  }

  if (!opts.seedFile || !fs.existsSync(opts.seedFile)) {
    throw new Error(
      `Dataset file not found at "${opts.seedFile}". ` +
        `This project loads an open-source dataset only (no synthetic generation). ` +
        `Run:  node scripts/fetch-dataset.mjs   to download it, then start again. ` +
        `(In Docker the file must exist in ./data, mounted at /seed/queries.tsv.)`,
    );
  }

  log.info(`Loading open-source dataset: ${opts.seedFile}`);
  const n = await loadFromFile(db, opts.seedFile);
  log.info(
    `Loaded ${n.toLocaleString()} rows (${db.size().toLocaleString()} unique queries).`,
  );
  return db.size();
}
