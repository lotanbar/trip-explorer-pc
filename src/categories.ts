/**
 * The fixed category list, shared with the phone app by copy (data/Categories.kt there).
 * Adding a category means adding it here and in the phone app.
 */

export interface Category {
  /** The key written to a POI's data.txt (category: <key>). */
  key: string;
  name: string;
  icon: string;
  color: string;
}

export const NONE: Category = { key: 'none', name: 'None', icon: 'marker', color: '#BDBDBD' };

/** In the phone's grid order. */
export const CATEGORIES: Category[] = [
  { key: 'viewpoints', name: 'Viewpoints', icon: 'viewpoint', color: '#7DA981' },
  { key: 'religion', name: 'Religion', icon: 'place-of-worship', color: '#90A4AE' },
  { key: 'food', name: 'Food', icon: 'food', color: '#D1A54B' },
  { key: 'history', name: 'History', icon: 'monument', color: '#A97BB0' },
  { key: 'oddity', name: 'Oddity', icon: 'question', color: '#5FB3AE' },
  NONE,
];

/** The category of a key from data.txt; missing or unknown reads as None. */
export function categoryByKey(key: string | null | undefined): Category {
  const wanted = key?.trim().toLowerCase();
  return CATEGORIES.find((c) => c.key === wanted) ?? NONE;
}
