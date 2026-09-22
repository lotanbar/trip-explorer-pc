import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));

import { isShown, type OsmPoi } from '../src/osmPois';

const poi = (tags: Record<string, string>, name: string | null = 'X'): OsmPoi =>
  ({ id: 'n1', lat: 0, lon: 0, name, searchName: name, groupId: 'water', type: 'Spring', tags });

describe('notable OSM POIs', () => {
  it('shows only named objects with a Wikidata, Wikipedia or heritage tag', () => {
    expect(isShown(poi({ wikidata: 'Q1' }))).toBe(true);
    expect(isShown(poi({ wikipedia: 'el:Πορτάρα' }))).toBe(true);
    expect(isShown(poi({ heritage: '2' }))).toBe(true);
    expect(isShown(poi({ 'name:en': 'Portara' }))).toBe(true);
    expect(isShown(poi({ description: 'a spring' }))).toBe(true);
    expect(isShown(poi({}))).toBe(false);
    expect(isShown(poi({ wikidata: 'Q1' }, null))).toBe(false);
  });
});
