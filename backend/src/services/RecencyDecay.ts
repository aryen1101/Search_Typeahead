import { Database } from "../db/Database";
import { Metrics } from "../metrics/Metrics";
import { log } from "../logger";

export class RecenyDecay {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database,
    private metrics: Metrics,
    private opts: { intervalMs: number; rate: number },
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.db.decay(this.opts.rate);
      this.metrics.recordDecay();
      log.info(`recency decay : recent_score *= ${this.opts.rate}`);
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
