/**
 * Builds src/genericNames.json: the name of each OSM object type we show, in every language iD is
 * translated to (from @openstreetmap/id-tagging-schema). A POI whose name is only its own type's
 * name ("Source", "Πηγή" on a spring) names nothing and is not shown.
 *
 * Run after updating the schema package: node scripts/generic-names.mjs
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const SCHEMA = 'node_modules/@openstreetmap/id-tagging-schema/dist';
/** Keys our Overpass query asks for; a wildcard preset on one of them ("Historic Site") counts too. */
const WILDCARD_KEYS = new Set(['natural', 'historic', 'man_made', 'waterway', 'tourism', 'amenity', 'landuse', 'military', 'leisure', 'geological']);

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { groupForOsmTags } = await vite.ssrLoadModule('/src/groups.ts');
const { normalizeName } = await vite.ssrLoadModule('/src/genericName.ts');
await vite.close();

const presets = JSON.parse(readFileSync(`${SCHEMA}/presets.json`, 'utf8'));
const ours = Object.entries(presets).filter(([, p]) => {
  const entries = Object.entries(p.tags);
  if (entries.length === 0) return false;
  if (entries.some(([, v]) => v === '*')) return entries.length === 1 && WILDCARD_KEYS.has(entries[0][0]);
  return groupForOsmTags(p.tags) !== null;
});

const names = new Map(ours.map(([id]) => [id, new Set()]));
for (const file of readdirSync(`${SCHEMA}/translations`).filter((f) => f.endsWith('.json') && !f.endsWith('.min.json'))) {
  const json = JSON.parse(readFileSync(`${SCHEMA}/translations/${file}`, 'utf8'));
  const translated = Object.values(json)[0]?.presets?.presets ?? {};
  for (const [id, set] of names) {
    const t = translated[id];
    if (!t) continue;
    const aliases = Array.isArray(t.aliases) ? t.aliases : typeof t.aliases === 'string' ? t.aliases.split('\n') : [];
    for (const n of [t.name, ...aliases]) if (n) set.add(normalizeName(n));
  }
}

const out = ours
  .map(([id, p]) => ({ tags: p.tags, names: [...names.get(id)].filter(Boolean).sort() }))
  .filter((e) => e.names.length > 0);
writeFileSync('src/genericNames.json', JSON.stringify(out) + '\n');
console.log(`${out.length} types, ${out.reduce((n, e) => n + e.names.length, 0)} names`);
