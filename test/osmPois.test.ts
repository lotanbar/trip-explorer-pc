import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));

import { isShown, type OsmPoi } from '../src/osmPois';

const poi = (tags: Record<string, string>, name: string | null = 'X'): OsmPoi =>
  ({ id: 'n1', lat: 0, lon: 0, name, searchName: name, groupId: 'water', type: 'Spring', tags });

describe('which OSM POIs are shown', () => {
  it('shows any named object', () => {
    expect(isShown(poi({ natural: 'spring' }))).toBe(true);
    expect(isShown(poi({ historic: 'castle' }))).toBe(true);
    expect(isShown(poi({ natural: 'spring' }, null))).toBe(false);
  });

  it('needs a notable tag for places of worship and cemeteries', () => {
    expect(isShown(poi({ amenity: 'place_of_worship' }))).toBe(false);
    expect(isShown(poi({ amenity: 'place_of_worship', wikidata: 'Q1' }))).toBe(true);
    expect(isShown(poi({ amenity: 'place_of_worship', 'name:en': 'Panagia Drosiani' }))).toBe(true);
    expect(isShown(poi({ landuse: 'cemetery' }))).toBe(false);
    expect(isShown(poi({ amenity: 'grave_yard', heritage: '2' }))).toBe(true);
    expect(isShown(poi({ amenity: 'monastery' }))).toBe(true);
  });

  it('treats a name that is only the type, in any language, as no name', () => {
    expect(isShown(poi({ natural: 'spring', name: 'Source', 'name:el': 'Πηγή' }))).toBe(false);
    expect(isShown(poi({ natural: 'spring', name: 'Πηγη' }))).toBe(false);
    expect(isShown(poi({ tourism: 'viewpoint', name: 'Aussichtspunkt' }))).toBe(false);
    expect(isShown(poi({ historic: 'ruins', name: 'Historic Site' }))).toBe(false);
    expect(isShown(poi({ natural: 'spring', name: 'Source Aria' }))).toBe(true);
    expect(isShown(poi({ tourism: 'viewpoint', name: 'Θέα στα νησιά', int_name: 'View to the islands' }))).toBe(true);
    expect(isShown(poi({ natural: 'spring', name: 'Πηγή', 'name:en': 'Levgassa Spring' }))).toBe(true);
    // Another type's name is a real name here.
    expect(isShown(poi({ historic: 'castle', name: 'Source' }))).toBe(true);
  });
});
