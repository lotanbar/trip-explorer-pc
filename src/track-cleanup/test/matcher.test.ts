import { describe, expect, it } from 'vitest';
import { MapMatcher } from '../src/matcher';
import { RoadGraph } from '../src/roadGraph';
import { haversineMeters } from '../src/geo';
import { at, track, way } from './fixtures';

/** One straight road along the x axis from 0 to 2000 m, with a side street at x = 1000. */
function roads() {
  return [
    way(1, 'residential', [[0, 0], [500, 0], [1000, 0], [1500, 0], [2000, 0]], 0, [1, 2, 3, 4, 5]),
    way(2, 'residential', [[1000, 0], [1000, 500], [1000, 1000]], 0, [3, 6, 7]),
  ];
}

function distToRoad(lat: number, lon: number): number {
  return Math.abs(lat - at(0, 0).lat) * 111_320;
}

describe('MapMatcher', () => {
  it('snaps slow driving along a road', () => {
    const m = new MapMatcher(new RoadGraph(roads()));
    const obs = track({ from: [50, 0], to: [1950, 0], speedMps: 4, noiseM: 6 });
    const out = m.match(obs);
    expect(out).toHaveLength(obs.length);
    const onRoad = out.filter((p) => p.onRoad).length / out.length;
    expect(onRoad).toBeGreaterThan(0.95);
    for (const p of out) if (p.onRoad) expect(distToRoad(p.lat, p.lon)).toBeLessThan(0.5);
  });

  it('leaves a walk 40 m beside the road off-road', () => {
    const m = new MapMatcher(new RoadGraph(roads()));
    const obs = track({ from: [50, 40], to: [1950, 40], speedMps: 1.3, noiseM: 6 });
    const out = m.match(obs);
    const offRoad = out.filter((p) => !p.onRoad).length / out.length;
    expect(offRoad).toBeGreaterThan(0.95);
    // Off-road points are returned exactly where they were.
    out.forEach((p, i) => { if (!p.onRoad) { expect(p.lat).toBe(obs[i].lat); expect(p.lon).toBe(obs[i].lon); } });
  });

  it('crossing a road while off-road does not snap', () => {
    const m = new MapMatcher(new RoadGraph(roads()));
    // Walk from y = -150 to y = +150 across the road at x = 600.
    const obs = track({ from: [600, -150], to: [600, 150], speedMps: 1.3, noiseM: 5 });
    const out = m.match(obs);
    expect(out.filter((p) => p.onRoad).length).toBeLessThanOrEqual(2);
  });

  it('drives on, walks off, drives back on', () => {
    const m = new MapMatcher(new RoadGraph(roads()));
    const drive1 = track({ from: [50, 0], to: [800, 0], speedMps: 5, noiseM: 6, seed: 2 });
    const t1 = drive1[drive1.length - 1].timeMs;
    const walk = track({ from: [800, 0], to: [800, 60], speedMps: 1.3, noiseM: 5, startMs: t1 + 1000, seed: 3 })
      .concat(track({ from: [800, 60], to: [900, 60], speedMps: 1.3, noiseM: 5, startMs: t1 + 1000 + 46_000, seed: 4 }));
    const t2 = walk[walk.length - 1].timeMs;
    const drive2 = track({ from: [900, 0], to: [1950, 0], speedMps: 5, noiseM: 6, startMs: t2 + 1000, seed: 5 });
    const out = m.match([...drive1, ...walk, ...drive2]);

    const d1 = out.slice(0, drive1.length);
    const w = out.slice(drive1.length, drive1.length + walk.length);
    const d2 = out.slice(drive1.length + walk.length);
    expect(d1.filter((p) => p.onRoad).length / d1.length).toBeGreaterThan(0.9);
    expect(d2.filter((p) => p.onRoad).length / d2.length).toBeGreaterThan(0.9);
    // The part of the walk that is more than 20 m from the road is off-road.
    const far = w.filter((_, i) => haversineMeters(walk[i].lat, walk[i].lon, at(800, 0).lat, walk[i].lon) > 25);
    expect(far.filter((p) => !p.onRoad).length / far.length).toBeGreaterThan(0.9);
  });

  it('prefers the road you are heading along at a junction', () => {
    const m = new MapMatcher(new RoadGraph(roads()));
    // Drive along the main road straight through the junction at x = 1000.
    const obs = track({ from: [800, 0], to: [1200, 0], speedMps: 8, noiseM: 5, seed: 7 });
    const out = m.match(obs);
    // Every snapped point should lie on the main road (y = 0), none on the side street.
    for (const p of out) expect(distToRoad(p.lat, p.lon)).toBeLessThan(1);
  });

  it('with no roads at all everything is off-road and unchanged', () => {
    const m = new MapMatcher(new RoadGraph([]));
    const obs = track({ from: [0, 0], to: [300, 300], speedMps: 1.3, noiseM: 5 });
    const out = m.match(obs);
    expect(out.every((p) => !p.onRoad)).toBe(true);
    out.forEach((p, i) => expect(p.lat).toBe(obs[i].lat));
  });

  it('a long time gap splits the track into independent runs', () => {
    const m = new MapMatcher(new RoadGraph(roads()));
    const a = track({ from: [50, 0], to: [400, 0], speedMps: 5, noiseM: 5 });
    const b = track({ from: [1200, 0], to: [1600, 0], speedMps: 5, noiseM: 5, startMs: a[a.length - 1].timeMs + 120_000 });
    const out = m.match([...a, ...b]);
    expect(out).toHaveLength(a.length + b.length);
    expect(out.filter((p) => p.onRoad).length / out.length).toBeGreaterThan(0.9);
  });
});
