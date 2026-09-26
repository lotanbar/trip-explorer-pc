/**
 * Generic names: a mapper who types the object's type as its name ("Source" on a spring, "Πηγή" in
 * Greek) names nothing, and a web search for it finds nothing. The type names come from OSM's own
 * translated preset list (scripts/generic-names.mjs builds genericNames.json from it).
 */

import GENERIC from './genericNames.json';
import type { Tags } from './groups';

/** Case, accents and spacing don't matter: "Πηγή" = "πηγη", "Source " = "source". */
export function normalizeName(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ').replace(/\s+/g, ' ').trim();
}

interface GenericEntry {
  tags: Record<string, string>;
  names: string[];
}

const ENTRIES = (GENERIC as unknown as GenericEntry[]).map((e) => ({ tags: Object.entries(e.tags), names: new Set(e.names) }));

/** The type names, in every language, of every type the object's tags match. */
function typeNames(tags: Tags): Set<string>[] {
  return ENTRIES.filter((e) => e.tags.every(([k, v]) => (v === '*' ? !!tags[k] : tags[k] === v))).map((e) => e.names);
}

/** True when each name the object has (name, name:en, int_name) is only a name of its own type. */
export function hasGenericName(tags: Tags): boolean {
  const own = [tags.name, tags['name:en'], tags.int_name].filter((n): n is string => !!n);
  if (own.length === 0) return false;
  const sets = typeNames(tags);
  return own.every((n) => {
    const key = normalizeName(n);
    return sets.some((s) => s.has(key));
  });
}
