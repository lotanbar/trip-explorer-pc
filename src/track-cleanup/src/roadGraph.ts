/**
 * A routable road network built from OpenStreetMap ways.
 *
 * Two jobs:
 *  1. Candidates — for a GPS point, the nearest road-segment projections within a radius
 *     (grid-accelerated).
 *  2. Network distance — the shortest on-road distance between two candidates, via a capped
 *     Dijkstra over the node graph, memoised per source node.
 *
 * The graph is undirected; one-way streets are a soft penalty on the distance, not a wall, because
 * GPS cannot tell which carriageway of a narrow couplet you are on, and OSM tagging is imperfect.
 */

import { bearingDeg, haversineMeters, projectOnSegment } from './geo';

export interface OsmWay {
  id: number;
  highway: string;
  /** Vertices, in order. */
  points: { lat: number; lon: number }[];
  /** OSM node ids parallel to [points]. Ways that meet share a node id; that is the topology. */
  nodeIds: number[];
  /** 0 = both ways, +1 = only in [points] order, -1 = only against it. */
  oneway: 0 | 1 | -1;
}

export interface Segment {
  aNode: number;
  bNode: number;
  aLat: number; aLon: number;
  bLat: number; bLon: number;
  lengthM: number;
  highway: string;
  bearing: number;
  oneway: 0 | 1 | -1;
  /** Multiplier on distance when travelling against [oneway]. */
  reverseMul: number;
}

export interface Candidate {
  segId: number;
  lat: number;
  lon: number;
  /** Fraction along the segment A→B. */
  t: number;
  distMeters: number;
  highway: string;
  segBearing: number;
}

/** Maximum on-road distance Dijkstra explores from one node. */
export const NETWORK_SEARCH_CAP_M = 2_000;

const DIJKSTRA_CACHE_MAX = 256;

/**
 * Wrong-way penalty by road class. On small streets one-way couplets are metres apart and a
 * wrong-carriageway match is invisible, so the penalty is mild; on motorways the carriageways are
 * physically separate and a wrong-way match is implausible, so it is strong.
 */
function reversePenalty(highway: string): number {
  switch (highway) {
    case 'motorway': case 'motorway_link': case 'trunk': case 'trunk_link': return 8.0;
    case 'primary': case 'primary_link': case 'secondary': case 'secondary_link': return 3.0;
    default: return 1.5;
  }
}

export class RoadGraph {
  readonly segments: Segment[] = [];
  private readonly adjacency = new Map<number, { to: number; lengthM: number }[]>();
  private readonly grid = new Map<string, number[]>();
  private readonly dijkstraCache = new Map<number, Map<number, number>>();

  /** @param cellSizeDeg Spatial grid cell size; 0.002° ≈ 220 m. */
  constructor(ways: OsmWay[], private readonly cellSizeDeg = 0.002) {
    let synthetic = -1; // node ids for ways that arrived without them
    for (const way of ways) {
      const pts = way.points;
      if (pts.length < 2) continue;
      const hasNodes = way.nodeIds.length === pts.length;
      const reverseMul = reversePenalty(way.highway);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const aNode = hasNodes ? way.nodeIds[i] : synthetic--;
        const bNode = hasNodes ? way.nodeIds[i + 1] : synthetic--;
        const lengthM = haversineMeters(a.lat, a.lon, b.lat, b.lon);
        if (lengthM === 0) continue;
        const segId = this.segments.length;
        this.segments.push({
          aNode, bNode,
          aLat: a.lat, aLon: a.lon, bLat: b.lat, bLon: b.lon,
          lengthM, highway: way.highway,
          bearing: bearingDeg(a.lat, a.lon, b.lat, b.lon),
          oneway: way.oneway, reverseMul,
        });
        this.addEdge(aNode, bNode, lengthM);
        this.addEdge(bNode, aNode, lengthM);
        this.indexSegment(segId, a.lat, a.lon, b.lat, b.lon);
      }
    }
  }

  get isEmpty(): boolean {
    return this.segments.length === 0;
  }

  /** Up to [maxK] candidate projections within [radiusM] of the point, nearest first. */
  candidates(lat: number, lon: number, radiusM: number, maxK: number): Candidate[] {
    if (this.isEmpty) return [];
    const cells = Math.floor(radiusM / (this.cellSizeDeg * 111_320)) + 1;
    const cLat = Math.floor(lat / this.cellSizeDeg);
    const cLon = Math.floor(lon / this.cellSizeDeg);
    const seen = new Set<number>();
    const found: Candidate[] = [];
    for (let dLat = -cells; dLat <= cells; dLat++) {
      for (let dLon = -cells; dLon <= cells; dLon++) {
        const ids = this.grid.get(`${cLat + dLat},${cLon + dLon}`);
        if (!ids) continue;
        for (const segId of ids) {
          if (seen.has(segId)) continue;
          seen.add(segId);
          const s = this.segments[segId];
          const p = projectOnSegment(lat, lon, s.aLat, s.aLon, s.bLat, s.bLon);
          if (p.distMeters <= radiusM) {
            found.push({ segId, lat: p.lat, lon: p.lon, t: p.t, distMeters: p.distMeters, highway: s.highway, segBearing: s.bearing });
          }
        }
      }
    }
    found.sort((x, y) => x.distMeters - y.distMeters);
    return found.length > maxK ? found.slice(0, maxK) : found;
  }

  /**
   * Shortest on-road distance between two candidates, or null when none within [maxDistM]. Null
   * means "degraded", not impossible: the fetched roads may be missing a connection.
   */
  networkDistance(a: Candidate, b: Candidate, maxDistM: number): number | null {
    if (a.segId === b.segId) {
      const seg = this.segments[a.segId];
      return this.dirCost(seg, Math.abs(a.t - b.t) * seg.lengthM, b.t >= a.t);
    }
    const sa = this.segments[a.segId];
    const sb = this.segments[b.segId];
    const aEnds: [number, number][] = [
      [sa.aNode, this.dirCost(sa, a.t * sa.lengthM, false)],
      [sa.bNode, this.dirCost(sa, (1 - a.t) * sa.lengthM, true)],
    ];
    const bEnds: [number, number][] = [
      [sb.aNode, this.dirCost(sb, b.t * sb.lengthM, true)],
      [sb.bNode, this.dirCost(sb, (1 - b.t) * sb.lengthM, false)],
    ];
    let best = Infinity;
    for (const [src, srcCost] of aEnds) {
      if (srcCost >= best) continue;
      const dist = this.dijkstraFrom(src);
      for (const [dst, dstCost] of bEnds) {
        const mid = dist.get(dst);
        if (mid === undefined) continue;
        const total = srcCost + mid + dstCost;
        if (total < best) best = total;
      }
    }
    return best <= maxDistM ? best : null;
  }

  private dirCost(seg: Segment, dist: number, towardB: boolean): number {
    const against = (towardB && seg.oneway === -1) || (!towardB && seg.oneway === 1);
    return against ? dist * seg.reverseMul : dist;
  }

  private dijkstraFrom(src: number): Map<number, number> {
    const cached = this.dijkstraCache.get(src);
    if (cached) return cached;
    const dist = new Map<number, number>();
    if (this.adjacency.has(src)) {
      dist.set(src, 0);
      const heap = new MinHeap();
      heap.push(src, 0);
      while (heap.size > 0) {
        const { node, d } = heap.pop();
        if (d > (dist.get(node) ?? Infinity)) continue;
        if (d > NETWORK_SEARCH_CAP_M) break;
        for (const e of this.adjacency.get(node) ?? []) {
          const nd = d + e.lengthM;
          if (nd > NETWORK_SEARCH_CAP_M) continue;
          if (nd < (dist.get(e.to) ?? Infinity)) {
            dist.set(e.to, nd);
            heap.push(e.to, nd);
          }
        }
      }
    }
    if (this.dijkstraCache.size >= DIJKSTRA_CACHE_MAX) {
      this.dijkstraCache.delete(this.dijkstraCache.keys().next().value!);
    }
    this.dijkstraCache.set(src, dist);
    return dist;
  }

  private addEdge(from: number, to: number, lengthM: number): void {
    let list = this.adjacency.get(from);
    if (!list) this.adjacency.set(from, (list = []));
    list.push({ to, lengthM });
  }

  private indexSegment(segId: number, aLat: number, aLon: number, bLat: number, bLon: number): void {
    const c = this.cellSizeDeg;
    const lat0 = Math.floor(Math.min(aLat, bLat) / c), lat1 = Math.floor(Math.max(aLat, bLat) / c);
    const lon0 = Math.floor(Math.min(aLon, bLon) / c), lon1 = Math.floor(Math.max(aLon, bLon) / c);
    for (let la = lat0; la <= lat1; la++) {
      for (let lo = lon0; lo <= lon1; lo++) {
        const key = `${la},${lo}`;
        let list = this.grid.get(key);
        if (!list) this.grid.set(key, (list = []));
        list.push(segId);
      }
    }
  }
}

/** Minimal binary heap keyed on distance. */
class MinHeap {
  private nodes: number[] = [];
  private dists: number[] = [];

  get size(): number { return this.nodes.length; }

  push(node: number, d: number): void {
    this.nodes.push(node); this.dists.push(d);
    let i = this.nodes.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.dists[p] <= this.dists[i]) break;
      this.swap(i, p); i = p;
    }
  }

  pop(): { node: number; d: number } {
    const top = { node: this.nodes[0], d: this.dists[0] };
    const lastN = this.nodes.pop()!, lastD = this.dists.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastN; this.dists[0] = lastD;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.dists.length && this.dists[l] < this.dists[m]) m = l;
        if (r < this.dists.length && this.dists[r] < this.dists[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }

  private swap(i: number, j: number): void {
    [this.nodes[i], this.nodes[j]] = [this.nodes[j], this.nodes[i]];
    [this.dists[i], this.dists[j]] = [this.dists[j], this.dists[i]];
  }
}
