import { describe, expect, it } from 'vitest';
import { parseGpx } from '../src/gpx';
import { GpsKalmanFilter } from '../src/kalman';
import { RoadGraph } from '../src/roadGraph';
import { buildQuery, fetchRoadsForTiles, parseWays, tileKey, type RoadCache } from '../src/overpass';
import { cleanTrack, prepare, DEFAULT_CLEANUP_OPTIONS } from '../src/pipeline';
import { bearingDeg, bearingPerpendicularity, haversineMeters, projectOnSegment } from '../src/geo';
import { at, toRaw, track, way } from './fixtures';

describe('geo', () => {
  it('haversine and bearing', () => {
    const a = at(0, 0), b = at(1000, 0);
    expect(haversineMeters(a.lat, a.lon, b.lat, b.lon)).toBeCloseTo(1000, -1);
    expect(bearingDeg(a.lat, a.lon, b.lat, b.lon)).toBeCloseTo(90, 0);
    expect(bearingPerpendicularity(90, 270)).toBe(0);
    expect(bearingPerpendicularity(0, 90)).toBe(90);
  });

  it('projects onto a segment', () => {
    const a = at(0, 0), b = at(100, 0), p = at(50, 30);
    const proj = projectOnSegment(p.lat, p.lon, a.lat, a.lon, b.lat, b.lon);
    expect(proj.t).toBeCloseTo(0.5, 3);
    expect(proj.distMeters).toBeCloseTo(30, 0);
    const beyond = at(150, 0);
    expect(projectOnSegment(beyond.lat, beyond.lon, a.lat, a.lon, b.lat, b.lon).t).toBe(1);
  });
});

describe('gpx', () => {
  const xml = `<?xml version="1.0"?>
<gpx version="1.1"><trk><trkseg>
<trkpt lat="32.0" lon="34.8"><time>2026-09-14T08:10:00Z</time><extensions><accuracy>5</accuracy></extensions></trkpt>
<trkpt lon="34.8001" lat="32.0001"><time>2026-09-14T08:10:01Z</time><extensions><accuracy>7.5</accuracy></extensions></trkpt>
</trkseg><trkseg>
<trkpt lat="32.001" lon="34.801"><time>2026-09-14T08:20:00Z</time></trkpt>
<trkpt lat="32.002" lon="34.802"><time>2026-09-14T08:20:0`;

  it('reads segments, accuracy and ignores a half-written last point', () => {
    const segs = parseGpx(xml);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toHaveLength(2);
    expect(segs[0][0]).toEqual({ lat: 32, lon: 34.8, timeMs: Date.parse('2026-09-14T08:10:00Z'), accuracyM: 5 });
    expect(segs[0][1].accuracyM).toBe(7.5);
    expect(segs[1]).toHaveLength(1);
    expect(Number.isNaN(segs[1][0].accuracyM)).toBe(true);
  });
});

describe('kalman', () => {
  it('reduces noise on a straight walk', () => {
    const obs = track({ from: [0, 0], to: [300, 0], speedMps: 1.5, noiseM: 8 });
    const k = new GpsKalmanFilter();
    let rawErr = 0, smoothErr = 0;
    obs.forEach((o, i) => {
      const s = k.process(o.lat, o.lon, o.accuracyM, o.timeMs, k.speedMps);
      if (i < 10) return; // let it settle
      rawErr += Math.abs(o.lat - at(0, 0).lat) * 111_320;
      smoothErr += Math.abs(s.lat - at(0, 0).lat) * 111_320;
    });
    expect(smoothErr).toBeLessThan(rawErr * 0.6);
  });
});

describe('roadGraph', () => {
  it('finds candidates and on-road distances through a junction', () => {
    const g = new RoadGraph([
      way(1, 'residential', [[0, 0], [100, 0], [200, 0]], 0, [1, 2, 3]),
      way(2, 'residential', [[100, 0], [100, 100]], 0, [2, 4]),
    ]);
    const p = at(150, 10);
    const c = g.candidates(p.lat, p.lon, 50, 6);
    expect(c.length).toBeGreaterThan(0);
    expect(c[0].distMeters).toBeCloseTo(10, 0);
    const q = at(100, 60);
    const c2 = g.candidates(q.lat, q.lon, 50, 6);
    const d = g.networkDistance(c[0], c2[0], 1000);
    expect(d).toBeCloseTo(50 + 60, 0);
  });

  it('penalises driving against a one-way', () => {
    const g = new RoadGraph([way(1, 'primary', [[0, 0], [100, 0]], 1, [1, 2])]);
    const a = g.candidates(at(20, 0).lat, at(20, 0).lon, 10, 1)[0];
    const b = g.candidates(at(80, 0).lat, at(80, 0).lon, 10, 1)[0];
    expect(g.networkDistance(a, b, 1000)).toBeCloseTo(60, 0);
    expect(g.networkDistance(b, a, 1000)).toBeCloseTo(180, 0);
  });
});

describe('overpass', () => {
  it('builds one query per tile chunk and parses ways', () => {
    const q = buildQuery(['3200,3480']);
    expect(q).toContain('out geom');
    expect(q).toContain('(31.9950,34.7950,32.0150,34.8150)');
    const ways = parseWays({
      elements: [
        { type: 'way', id: 7, tags: { highway: 'residential', oneway: 'yes' }, nodes: [1, 2], geometry: [{ lat: 32, lon: 34.8 }, { lat: 32.001, lon: 34.8 }] },
        { type: 'way', id: 8, tags: { building: 'yes' }, nodes: [1, 2], geometry: [{ lat: 32, lon: 34.8 }, { lat: 32.001, lon: 34.8 }] },
        { type: 'node', id: 9 },
      ],
    });
    expect(ways).toHaveLength(1);
    expect(ways[0]).toMatchObject({ id: 7, highway: 'residential', oneway: 1, nodeIds: [1, 2] });
  });

  it('uses the cache, falls over on 429, and fills the cache', async () => {
    const store = new Map<string, any>();
    const cache: RoadCache = {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
    };
    store.set('3200,3480', []);
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      if (calls.length === 1) return new Response('', { status: 429 });
      return new Response(JSON.stringify({ elements: [
        { type: 'way', id: 1, tags: { highway: 'path' }, nodes: [1, 2], geometry: [{ lat: 32.015, lon: 34.815 }, { lat: 32.016, lon: 34.815 }] },
      ] }), { status: 200 });
    }) as unknown as typeof fetch;
    const ways = await fetchRoadsForTiles(['3200,3480', '3201,3481'], { cache, fetchFn });
    expect(ways).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(store.get('3201,3481')).toHaveLength(1);
    expect(tileKey(32.015, 34.815)).toBe('3201,3481');
  });
});

describe('pipeline', () => {
  it('drops bad accuracy, stationary jitter and impossible jumps', () => {
    const base = toRaw(track({ from: [0, 0], to: [200, 0], speedMps: 2, noiseM: 3 }));
    base[10].accuracyM = 80;                      // bad fix
    const jitter = { ...base[20], timeMs: base[20].timeMs + 500, lat: base[20].lat + 1e-6 }; // 0.1 m away
    const jump = { ...base[30], timeMs: base[30].timeMs + 500, lat: base[30].lat + 0.01 }; // 1.1 km away
    const seg = [...base.slice(0, 21), jitter, ...base.slice(21, 31), jump, ...base.slice(31)];
    const obs = prepare(seg, DEFAULT_CLEANUP_OPTIONS);
    // 2 m/s with a 5 m minimum movement keeps roughly every third point; the bad fix, the
    // jitter and the jump are all gone.
    expect(obs.length).toBeGreaterThan(base.length / 4);
    expect(obs.length).toBeLessThan(base.length);
    expect(obs.every((o) => Math.abs(o.lat - at(0, 0).lat) * 111_320 < 20)).toBe(true);
    expect(obs.every((o) => o.accuracyM <= 50)).toBe(true);
    expect(obs[20].speedMps).toBeGreaterThan(1);
    expect(obs[20].bearingDeg).not.toBeNull();
  });

  it('end to end: a drive comes out on the road, a walk in the field stays put', () => {
    const roads = [way(1, 'tertiary', [[0, 0], [1000, 0], [2000, 0]], 0, [1, 2, 3])];
    const drive = toRaw(track({ from: [0, 0], to: [2000, 0], speedMps: 12, noiseM: 7, seed: 11 }));
    const walk = toRaw(track({ from: [500, 300], to: [900, 500], speedMps: 1.3, noiseM: 7, seed: 12 }));
    const [d, w] = cleanTrack([drive, walk], roads);
    expect(d.filter((p) => p.onRoad).length / d.length).toBeGreaterThan(0.9);
    expect(w.every((p) => !p.onRoad)).toBe(true);
  });
});
