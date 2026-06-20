import Redis from "ioredis";

export interface CacheNode {
  id: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  ttl(key: string): Promise<number>;
  stats(): {
    id: string;
    hits: number;
    misses: number;
    keys: number;
    backend: string;
  };
  close(): Promise<void>;
}

export class RedisCacheNode implements CacheNode {
  private client: Redis;
  private hits = 0;
  private misses = 0;

  constructor(
    public id: string,
    host: string,
    port: number,
  ) {
    this.client = new Redis({
      host,
      port,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.client.on("error", () => {});
  }

  async get(key: string): Promise<string | null> {
    const v = await this.client.get(key);
    if (v === null) this.misses++;
    else this.hits++;
    return v;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
      await this.client.set(key , value , "EX" , ttlSeconds)
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  stats() {
    return { id: this.id, hits: this.hits, misses: this.misses, keys: -1, backend: "redis" };
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
