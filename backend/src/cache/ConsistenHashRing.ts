import { hashFn } from "./hash";

interface RingPoint {
  hash: number;
  nodeId: string;
}

export interface RouteDebug {
  key: string;
  keyHash: number;
  nodeId: string;
  ringPointHash: number;
  virtualNodesPerNode: number;
  totalRingPoints: number;
}

export class ConsistentHashRing {
  private points: RingPoint[] = [];
  private nodes = new Set<string>();

  constructor(private readonly virtualNodes: number = 150) {}

  addNode(nodeId: string): void {
    if (this.nodes.has(nodeId)) return;
    this.nodes.add(nodeId);
    for (let i = 0; i < this.virtualNodes; i++) {
      this.points.push({ hash: hashFn(`${nodeId}#vn${i}`), nodeId });
    }
    this.points.sort((a, b) => a.hash - b.hash);
  }

  removeNode(nodeId: string): void {
    if (!this.nodes.has(nodeId)) return;
    this.nodes.delete(nodeId);
    this.points = this.points.filter((p) => p.nodeId !== nodeId);
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  listNodes(): string[] {
    return Array.from(this.nodes);
  }

  private getFirstPointFrom(h: number): RingPoint {
    let low = 0;
    let high = this.points.length - 1;
    let ans = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.points[mid].hash >= h) {
        ans = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    if (low > this.points.length - 1) ans = 0;
    return this.points[ans];
  }

  getNode(key: string): string {
    if (this.points.length === 0)
      throw new Error("ConsistentHashRing has no nodes");
    const h = hashFn(key);
    return this.getFirstPointFrom(h).nodeId;
  }

  getRouteDebug(key: string): RouteDebug {
    const keyHash = hashFn(key);
    const point = this.getFirstPointFrom(keyHash);
    return {
      key,
      keyHash,
      nodeId: point.nodeId,
      ringPointHash: point.hash,
      virtualNodesPerNode: this.virtualNodes,
      totalRingPoints: this.points.length,
    };
  }

  nodeDistribution(): Record<string, number> {
    const owned : Record<string , number> = {}
    for (const id of this.nodes) owned[id] = 0;
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const cur = this.points[i];
      const next = this.points[(i + 1) % n];
      let arc = next.hash - cur.hash;
      if (arc <= 0) arc += 0x100000000; 
      owned[cur.nodeId] += arc;
    }
    const total = 0x100000000;
    for (const id of Object.keys(owned)) {
      owned[id] = Number(((owned[id] / total) * 100).toFixed(2)); 
    }
    return owned;
  }
}
