import { ConsistentHashRing, RouteDebug } from "./ConsistenHashRing";
import { log } from "../logger";
import { CacheNode, RedisCacheNode } from "./CacheNode";

export class CacheCluster {
  private ring: ConsistentHashRing;
  private nodes = new Map<string, CacheNode>();

  constructor(redisNodes: string[], virtualNodes: number) {
    this.ring = new ConsistentHashRing(virtualNodes);

    if (redisNodes.length === 0) {
      throw new Error("No cache nodes configured. Set REDIS_NODES.");
    }

    for (const spec of redisNodes) {
      const [host, portStr] = spec.split(":");
      const port = Number(portStr) || 6379;
      const id = spec;
      this.nodes.set(id, new RedisCacheNode(id, host, port));
      this.ring.addNode(id);

      log.info(
        `Cache cluster: ${redisNodes.length} REDIS nodes -> [${redisNodes.join(", ")}]`,
      );
      log.info(
        "Ring ownership distribution (%):",
        this.ring.nodeDistribution(),
      );
    }
  }

  private valueKey(prefix: string, ranking: string): string {
    return `sug:${ranking}:${prefix}`;
  }

  private nodeFor(prefix: string): CacheNode {
    const id = this.ring.getNode(prefix);
    const node = this.nodes.get(id);
    if (!node) throw new Error(`No cache node for id ${id}`);
    return node;
  }

  async get(prefix: string, ranking: string): Promise<string | null> {
    try {
      return await this.nodeFor(prefix).get(this.valueKey(prefix, ranking));
    } catch (e) {
      log.warn("cache get failed (treating as miss):", (e as Error).message);
      return null;
    }
  }

  async set(
    prefix: string,
    ranking: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.nodeFor(prefix).set(
        this.valueKey(prefix, ranking),
        value,
        ttlSeconds,
      );
    } catch (e) {
      log.warn("cache set failed (ignored):", (e as Error).message);
    }
  }

  async invalidate(prefix: string, rankings: string[]): Promise<void> {
    try {
      const node = this.nodeFor(prefix);
      await Promise.all(
        rankings.map((r) => node.del(this.valueKey(prefix, r))),
      );
    } catch (e) {
      log.warn("cache invalidate failed (ignored):", (e as Error).message);
    }
  }

  async debug(
    prefix: string,
    ranking: string,
  ): Promise<{
    route: RouteDebug;
    valueKey: string;
    status: "HIT" | "MISS";
    ttlSeconds: number;
    cachedCount: number | null;
  }> {
    const route = this.ring.getRouteDebug(prefix);
    const node = this.nodeFor(prefix);
    const vKey = this.valueKey(prefix, ranking);
    let status: "HIT" | "MISS" = "MISS";
    let ttlSeconds = -2;
    let cachedCount: number | null = null;

    try {
      const v = await node.get(vKey);
      if (v !== null) {
        status = "HIT";
        ttlSeconds = await node.ttl(vKey);
        try {
          cachedCount = (JSON.parse(v) as unknown[]).length;
        } catch {
          cachedCount = null;
        }
      }
    } catch (e) {
      log.warn("cache debug failed:", (e as Error).message);
    }
    return { route, valueKey: vKey, status, ttlSeconds, cachedCount };
  }

  ring_(): ConsistentHashRing {
    return this.ring;
  }

  nodeStats() {
    return Array.from(this.nodes.values()).map((n) => n.stats());
  }

  ownership(): Record<string, number> {
    return this.ring.nodeDistribution();
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.nodes.values()).map((n) => n.close()));
  }
}
