import { describe, expect, it } from 'vitest';
import { applyLengthRule, parseTrails, trailHover, type TrailLine } from '../src/trails';

// ~0.001° of latitude is 111 m; these pieces are 222 m each.
function way(id: number, tags: Record<string, string>, lat0: number, lon = 25.0): object {
  return {
    type: 'way',
    id,
    tags,
    geometry: [
      { lat: lat0, lon },
      { lat: lat0 + 0.002, lon },
    ],
  };
}

describe('trail parsing', () => {
  it('classifies ways and relations and skips non-way relation members', () => {
    const lines = parseTrails({
      elements: [
        way(1, { railway: 'abandoned' }, 37),
        way(2, { aerialway: 'gondola' }, 37),
        way(3, { aerialway: 'station' }, 37),
        {
          type: 'relation',
          id: 9,
          tags: { route: 'hiking', name: 'Zas trail', from: 'Filoti', to: 'Zas', distance: '4.2' },
          members: [
            { type: 'node', ref: 5, role: 'guidepost' },
            { type: 'way', ref: 6, role: '', geometry: [{ lat: 37, lon: 25 }, { lat: 37.01, lon: 25 }] },
          ],
        },
      ],
    });
    expect(lines.map((l) => [l.id, l.category])).toEqual([
      ['w1:0', 'rail'],
      ['w2:0', 'cable'],
      ['r9:1:0', 'hiking'],
    ]);
    expect(trailHover(lines[2])).toBe('Zas trail\nFiloti → Zas\n4.2 km');
    expect(trailHover(lines[0])).toBe('Abandoned railway (unnamed)');
  });

  it('splits a geometry at points clipped away by the strip', () => {
    const lines = parseTrails({
      elements: [
        {
          type: 'way',
          id: 1,
          tags: { historic: 'road' },
          geometry: [{ lat: 37, lon: 25 }, { lat: 37.001, lon: 25 }, null, { lat: 37.005, lon: 25 }, { lat: 37.006, lon: 25 }],
        },
      ],
    });
    expect(lines.map((l) => l.id)).toEqual(['w1:0', 'w1:1']);
  });
});

describe('500 m rule', () => {
  it('joins pieces that share an endpoint and the same tags before measuring', () => {
    const tags = { railway: 'abandoned', name: 'Old line' };
    // Three 222 m pieces in a chain (666 m) plus one lone 222 m piece elsewhere.
    const lines = parseTrails({
      elements: [way(1, tags, 37.0), way(2, tags, 37.002), way(3, tags, 37.004), way(4, tags, 38.0)],
    });
    const kept = applyLengthRule(lines).map((l) => l.id);
    expect(kept).toEqual(['w1:0', 'w2:0', 'w3:0']);
  });

  it('does not join pieces with different tags', () => {
    const lines = parseTrails({
      elements: [
        way(1, { railway: 'abandoned', name: 'A' }, 37.0),
        way(2, { railway: 'abandoned', name: 'B' }, 37.002),
        way(3, { railway: 'abandoned', name: 'A' }, 37.004),
      ],
    });
    expect(applyLengthRule(lines)).toEqual([]);
  });

  it('shows via ferratas and routes at any length', () => {
    const lines = parseTrails({
      elements: [
        way(1, { highway: 'via_ferrata' }, 37.0),
        { type: 'relation', id: 2, tags: { route: 'foot' }, members: [{ type: 'way', ref: 1, role: '', geometry: [{ lat: 37, lon: 25 }, { lat: 37.0001, lon: 25 }] }] },
      ],
    });
    expect(applyLengthRule(lines).map((l: TrailLine) => l.category)).toEqual(['via_ferrata', 'hiking']);
  });
});
