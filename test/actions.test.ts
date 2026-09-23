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

describe('screen history', () => {
  it('records screens after the cursor, drops forward ones on a new screen, and stops at both ends', async () => {
    const { pushScreen, stepCursor } = await import('../src/screens');
    type S = import('../src/screens').Screen;
    const list: S[] = [];
    let c = pushScreen(list, -1, { kind: 'controls' });
    c = pushScreen(list, c, { kind: 'browser', url: 'b' });
    c = pushScreen(list, c, { kind: 'browser', url: 'b', lat: 1, lon: 2 }); // the same page again is not a new screen
    c = pushScreen(list, c, { kind: 'search', plan: null });
    c = pushScreen(list, c, { kind: 'search', plan: 'x.txt' }); // another plan is another screen
    expect(list.map((s) => s.kind)).toEqual(['controls', 'browser', 'search', 'search']);
    expect(c).toBe(3);
    c = stepCursor(list.length, c, -1);
    c = stepCursor(list.length, c, -1);
    expect(c).toBe(1);
    expect(stepCursor(list.length, 0, -1)).toBe(0);
    c = pushScreen(list, c, { kind: 'controls' });
    expect(list.map((s) => s.kind)).toEqual(['controls', 'browser', 'controls']);
    expect(stepCursor(list.length, c, 1)).toBe(c);
  });
});
