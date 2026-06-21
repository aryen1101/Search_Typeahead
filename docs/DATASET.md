# Dataset

## Source
Peter Norvig's open‑source n‑gram frequency lists (derived from the Google Web Trillion
Word Corpus):

- Single words: <https://norvig.com/ngrams/count_1w.txt>
- Bigrams: <https://norvig.com/ngrams/count_2w.txt>

Both are plain text, tab‑separated, freely available for use.

## Format
The loader expects one record per line:

```
query<TAB>count
```

Examples (from the actual file):
```
the      23135851162
of       13151942776
java     55360149
iphone   50988
```

This already matches the assignment's expected `query  count` input format, so no
transformation is required. The single‑word and bigram lists are concatenated, giving a mix
of one‑ and two‑word queries.

## Size
- ~620,000 raw rows downloaded.
- **~591,000 unique queries** after normalization (lower‑casing + whitespace collapse and
  merging duplicates), comfortably above the 100,000 minimum.

## Loading instructions

### Automatic (default)
The backend seeds the database on startup if it is empty. If the dataset file is missing,
it **downloads the dataset automatically** from the source URLs, saves it, and loads it —
so `docker compose up` works on a fresh clone with no extra step. Requires internet access;
there is no synthetic fallback.

Loading streams the file line‑by‑line and inserts in batches of 5,000 inside SQLite
transactions, so ~620k rows seed in a few seconds. Counts for duplicate queries are summed.

### Manual (optional)
To fetch the dataset yourself beforehand (e.g. to inspect or cache it):
```bash
node scripts/fetch-dataset.mjs                 # words + bigrams -> data/queries.tsv
node scripts/fetch-dataset.mjs --words-only    # single words only (smaller)
```
In Docker, `data/queries.tsv` is mounted at `/seed/queries.tsv` (`SEED_FILE`) and used if
present; otherwise the auto‑download writes to the data volume.

### Re‑seeding
- **Docker:** `docker compose down -v` (removes the `backend-data` volume), then
  `docker compose up -d`.
- **Local:** delete `backend/data/typeahead.db*` and restart.

## Relevant configuration
| Env var | Default | Meaning |
|---|---|---|
| `SEED_FILE` | `/seed/queries.tsv` (Docker) / `../data/queries.tsv` (local) | Dataset path |
| `DB_PATH` | `/data/typeahead.db` (Docker) / `./data/typeahead.db` (local) | SQLite file |
| `MIN_PREFIX_LENGTH` | `1` | Minimum prefix length served |
