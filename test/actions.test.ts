import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { placeFromAddress, poiSearchQuery, searchUrl } from '../src/actions';

describe('search actions', () => {
  it('builds an English Google search in the agreed shape', () => {
    expect(poiSearchQuery('Κούρος Φαράγγι', 'Naxos')).toBe('Κούρος Φαράγγι Naxos info english short answer');
    expect(poiSearchQuery('Portara', '')).toBe('Portara info english short answer');
    expect(searchUrl('Portara Naxos info english')).toBe('https://www.google.com/search?hl=en&q=Portara%20Naxos%20info%20english');
  });

  it('picks the town from a Nominatim address, without the country', () => {
    expect(placeFromAddress({ town: 'Naxos', country: 'Greece' })).toBe('Naxos');
    expect(placeFromAddress({ village: 'Filoti', county: 'Naxos Regional Unit', country: 'Greece' })).toBe('Filoti');
    expect(placeFromAddress({ county: 'Naxos Regional Unit', country: 'Greece' })).toBe('Naxos');
    expect(placeFromAddress({ municipality: 'Municipality of Naxos and Lesser Cyclades', county: 'Naxos Regional Unit' })).toBe('Naxos');
    expect(placeFromAddress({ municipality: 'Municipality of Naxos and Lesser Cyclades' })).toBe('Naxos and Lesser Cyclades');
    expect(placeFromAddress({ country: 'Greece' })).toBe('');
  });
});

describe('browser history', () => {
  it('records visits after the cursor, drops forward ones on a new page, and stops at both ends', async () => {
    const { pushVisit, stepCursor } = await import('../src/browser');
    const list: { url: string }[] = [];
    let c = pushVisit(list, -1, { url: 'a' });
    c = pushVisit(list, c, { url: 'b' });
    c = pushVisit(list, c, { url: 'b' }); // the same page again is not a new visit
    expect(list.map((v) => v.url)).toEqual(['a', 'b']);
    expect(c).toBe(1);
    c = stepCursor(list.length, c, -1);
    expect(c).toBe(0);
    expect(stepCursor(list.length, c, -1)).toBe(0);
    c = pushVisit(list, c, { url: 'c' });
    expect(list.map((v) => v.url)).toEqual(['a', 'c']);
    expect(stepCursor(list.length, c, 1)).toBe(1);
  });
});
