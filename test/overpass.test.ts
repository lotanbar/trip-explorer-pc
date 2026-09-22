import { describe, expect, it } from 'vitest';
import { atLeastKm, uncovered, type Bounds } from '../src/overpass';

const b = (south: number, west: number, north: number, east: number): Bounds => ({ south, west, north, east });

describe('uncovered strips', () => {
  it('returns the whole target when nothing is covered', () => {
    expect(uncovered(b(0, 0, 1, 1), [])).toEqual([b(0, 0, 1, 1)]);
  });

  it('returns nothing when the target is inside a covered area', () => {
    expect(uncovered(b(0.2, 0.2, 0.8, 0.8), [b(0, 0, 1, 1)])).toEqual([]);
  });

  it('returns only the new strips after a pan', () => {
    // Pan north-east by 0.5: two strips remain (a top band and a right band).
    const strips = uncovered(b(0.5, 0.5, 1.5, 1.5), [b(0, 0, 1, 1)]);
    expect(strips).toHaveLength(2);
    const area = strips.reduce((a, s) => a + (s.north - s.south) * (s.east - s.west), 0);
    expect(area).toBeCloseTo(1 - 0.25, 6);
  });

  it('subtracts several covered areas without overlap between the pieces', () => {
    const strips = uncovered(b(0, 0, 2, 2), [b(0, 0, 1, 1), b(1, 1, 2, 2)]);
    const area = strips.reduce((a, s) => a + (s.north - s.south) * (s.east - s.west), 0);
    expect(area).toBeCloseTo(2, 6);
  });
});

describe('minimum fetch area', () => {
  it('grows a tiny viewport to at least 5 km across', () => {
    const grown = atLeastKm(b(37.1, 25.37, 37.101, 25.371), 5);
    expect((grown.north - grown.south) * 111).toBeGreaterThanOrEqual(4.99);
    expect((grown.east - grown.west) * 111 * Math.cos((37.1 * Math.PI) / 180)).toBeGreaterThanOrEqual(4.99);
  });

  it('leaves a large viewport alone', () => {
    const big = b(37, 25, 38, 26);
    expect(atLeastKm(big, 5)).toEqual(big);
  });
});
