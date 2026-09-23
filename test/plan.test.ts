import { describe, expect, it } from 'vitest';

import { checkName } from '../src/names';
import { matchMyPois, parsePhoton, placeOf, resultKey } from '../src/photon';
import { moveStop, parsePlanFile, planFileText, toggleStop, type PlanStop } from '../src/plan';

const a: PlanStop = { key: 'osm:n1', lat: 45.4642, lon: 9.19, name: 'Castello Sforzesco' };
const b: PlanStop = { key: 'search:w2', lat: 37.1, lon: 25.4, name: 'Portara, Naxos' };
const c: PlanStop = { key: 'mine:C:\\trips\\x\\Beach', lat: 37.0, lon: 25.3, name: 'Beach' };

describe('plan file', () => {
  it('writes one stop per line as lat, lon, name', () => {
    expect(planFileText([a, b])).toBe('45.46420, 9.19000, Castello Sforzesco\n37.10000, 25.40000, Portara, Naxos\n');
    expect(planFileText([])).toBe('');
  });

  it('reads it back, keeping commas in names and skipping junk lines', () => {
    const stops = parsePlanFile('45.46420, 9.19000, Castello Sforzesco\r\n\r\nnot a stop\n37.1,25.4,Portara, Naxos\n91, 0, out of range\n37.0, 25.3\n');
    expect(stops.map((s) => [s.lat, s.lon, s.name])).toEqual([
      [45.4642, 9.19, 'Castello Sforzesco'],
      [37.1, 25.4, 'Portara, Naxos'],
      [37, 25.3, '37, 25.3'],
    ]);
    expect(new Set(stops.map((s) => s.key)).size).toBe(3);
  });

  it('toggles and reorders stops', () => {
    expect(toggleStop([a], b)).toEqual([a, b]);
    expect(toggleStop([a, b], a)).toEqual([b]);
    expect(moveStop([a, b, c], 2, 0)).toEqual([c, a, b]);
    expect(moveStop([a, b, c], 0, 2)).toEqual([b, c, a]);
  });
});

describe('plan names', () => {
  it('applies the spec rules', () => {
    expect(checkName('Naxos day 1')).toBeNull();
    expect(checkName('')).toMatch(/required/);
    expect(checkName('a:b')).toMatch(/isn't allowed/);
    expect(checkName('a.')).toMatch(/dot/);
    expect(checkName('a ')).toMatch(/space/);
    expect(checkName('con')).toMatch(/reserved/);
    expect(checkName('Naxos', ['naxos'])).toMatch(/already exists/);
  });
});

describe('photon', () => {
  it('parses features into results with a place line', () => {
    const json = {
      features: [
        { geometry: { coordinates: [9.19, 45.4642] }, properties: { osm_type: 'W', osm_id: 1, osm_key: 'historic', osm_value: 'castle', name: 'Castello Sforzesco', city: 'Milan', country: 'Italy' } },
        { geometry: { coordinates: [9.19, 45.4642] }, properties: { osm_type: 'W', osm_id: 1, name: 'dup' } },
        { geometry: { coordinates: [1, 2] }, properties: { osm_type: 'N', osm_id: 2, osm_key: 'place', osm_value: 'city', name: 'Milan', city: 'Milan', state: 'Lombardy', country: 'Italy' } },
        { geometry: { coordinates: [1, 2] }, properties: { osm_type: 'N', osm_id: 3 } },
      ],
    };
    const r = parsePhoton(json);
    expect(r.map((x) => x.id)).toEqual(['W1', 'N2']);
    expect(r[0]).toMatchObject({ name: 'Castello Sforzesco', place: 'Milan, Italy', kind: 'castle', lat: 45.4642, lon: 9.19 });
    expect(placeOf({ name: 'Milan', city: 'Milan', state: 'Lombardy', country: 'Italy' })).toBe('Lombardy, Italy');
  });

  it('matches my POIs by name, case-insensitively, and keys them like the map does', () => {
    const pois = [
      { name: 'Portara', path: 'C:/trips/Greece/Portara', lat: 37.11, lon: 25.37, trip: 'Greece 2026' },
      { name: 'Kastro cave', path: 'C:/trips/Greece/Kastro cave', lat: 37.1, lon: 25.4, trip: 'Greece 2026' },
    ];
    expect(matchMyPois('  ', pois)).toEqual([]);
    const r = matchMyPois('CAVE', pois);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 'C:/trips/Greece/Kastro cave', name: 'Kastro cave', place: 'Greece 2026', kind: 'my POI', mine: true });
    expect(resultKey(r[0])).toBe('mine:C:/trips/Greece/Kastro cave');
    expect(resultKey({ id: 'W1', name: 'x', place: '', kind: '', lat: 0, lon: 0 })).toBe('search:W1');
  });
});
