import * as fs from "fs";
import * as readline from "readline";
import { Database } from "./Database";
import { normalize } from "./normalize";
import { downloadDataset } from "./fetchDataset";
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
  opts: { seedFile: string; fallbackDir: string },
): Promise<number> {
  if (!db.isEmpty()) {
    const n = db.size();
    log.info(`DB already has ${n.toLocaleString()} queries - skipping load.`);
    return n;
  }

  let file = opts.seedFile;
  if (!file || !fs.existsSync(file)) {
    log.info(
      `Dataset not found at "${file}". Downloading open-source dataset automatically...`,
    );
    file = await downloadDataset(opts.fallbackDir);
  }

  log.info(`Loading open-source dataset: ${file}`);
  const n = await loadFromFile(db, file);
  log.info(
    `Loaded ${n.toLocaleString()} rows (${db.size().toLocaleString()} unique queries).`,
  );
  return db.size();
}
