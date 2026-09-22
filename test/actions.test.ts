import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { placeFromAddress, poiSearchQuery, searchUrl } from '../src/actions';

describe('search actions', () => {
  it('builds an English Google search in the agreed shape', () => {
    expect(poiSearchQuery('Κούρος Φαράγγι', 'Naxos')).toBe('Κούρος Φαράγγι Naxos info english');
    expect(poiSearchQuery('Portara', '')).toBe('Portara info english');
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
