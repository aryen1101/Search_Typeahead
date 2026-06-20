/** A single suggestion returned to the client. */
export interface Suggestion {
  query: string;
  count: number;
  score: number;
}

/** A row in the Search-Frequency DB. */
export interface QueryRow {
  query: string;
  count: number;
  recent_score: number;
  updated_at: number;
}

/** Aggregated batch entry: how much to add to a query's count. */
export interface BatchEntry {
  query: string;
  delta: number;
}

export interface SearchIntake {
  mode: "kafka" | "in-memory";
  record(query: string): Promise<{ message: string }>;
  pendingSize(): number;
}
