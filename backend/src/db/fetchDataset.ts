import * as fs from "fs";
import * as path from "path";
import { log } from "../logger";

const SOURCES = [
  "https://norvig.com/ngrams/count_1w.txt",
  "https://norvig.com/ngrams/count_2w.txt",
];

export async function downloadDataset(destDir: string): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });
  const out = path.join(destDir, "queries.tsv");
  const parts: string[] = [];
  for (const url of SOURCES) {
    log.info(`Downloading open-source dataset: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter((l) => l.includes("\t"));
    parts.push(lines.join("\n"));
  }
  fs.writeFileSync(out, parts.join("\n") + "\n");
  log.info(`Dataset saved to ${out}`);
  return out;
}
