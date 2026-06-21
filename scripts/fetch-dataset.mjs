import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT = path.join(DATA_DIR, "queries.tsv");

const SOURCES = [
  { name: "words (1-grams)", url: "https://norvig.com/ngrams/count_1w.txt" },
  { name: "bigrams (2-grams)", url: "https://norvig.com/ngrams/count_2w.txt" },
];

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const wordsOnly = process.argv.includes("--words-only");
  const sources = wordsOnly ? SOURCES.slice(0, 1) : SOURCES;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT, ""); 

  let total = 0;
  for (const s of sources) {
    process.stdout.write(`Downloading ${s.name} from ${s.url} ... `);
    const text = await download(s.url);
    const lines = text.split(/\r?\n/).filter((l) => l.includes("\t"));
    fs.appendFileSync(OUT, lines.join("\n") + "\n");
    total += lines.length;
    console.log(`${lines.length.toLocaleString("en-US")} rows`);
  }

  console.log(`\nWrote ${total.toLocaleString("en-US")} rows -> ${OUT}`);
  console.log("Format: query<TAB>count (already what the backend loader expects).");
  console.log("\nNext: start the backend (it loads this file automatically):");
  console.log("  - local:  cd backend && npm run dev");
  console.log("  - docker: docker compose up --build   (mounted at /seed/queries.tsv)");
  console.log("Re-seed: delete backend/data (local) or `docker compose down -v` (docker).");
}

main().catch((e) => {
  console.error("\nfetch failed:", e.message);
  console.error("The backend needs this dataset (no synthetic fallback). Check your internet and retry.");
  process.exit(1);
});
