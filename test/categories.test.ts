import { describe, expect, it } from 'vitest';
import { CATEGORIES, categoryByKey, NONE } from '../src/categories';

describe('categories', () => {
  it('has the phone six, in grid order', () => {
    expect(CATEGORIES.map((c) => c.key)).toEqual(['viewpoints', 'religion', 'food', 'history', 'oddity', 'none']);
  });

  it('reads a key from data.txt; missing or unknown is None', () => {
    expect(categoryByKey('food').name).toBe('Food');
    expect(categoryByKey(' Viewpoints ').key).toBe('viewpoints');
    expect(categoryByKey('caves')).toBe(NONE);
    expect(categoryByKey(null)).toBe(NONE);
  });
});
