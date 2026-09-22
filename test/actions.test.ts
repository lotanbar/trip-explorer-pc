import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { placeFromAddress, searchUrl } from '../src/actions';

describe('search actions', () => {
  it('builds a DuckDuckGo search', () => {
    expect(searchUrl('Portara Naxos Greece')).toBe('https://duckduckgo.com/?q=Portara%20Naxos%20Greece');
  });

  it('picks the town and country from a Nominatim address', () => {
    expect(placeFromAddress({ town: 'Naxos', country: 'Greece' })).toBe('Naxos Greece');
    expect(placeFromAddress({ village: 'Filoti', county: 'Naxos', country: 'Greece' })).toBe('Filoti Greece');
    expect(placeFromAddress({ country: 'Greece' })).toBe('Greece');
    expect(placeFromAddress({})).toBe('');
  });
});
