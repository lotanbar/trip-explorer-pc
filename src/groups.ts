/**
 * The fixed group list (shared with the phone app by copy) and the OSM tag → group mapping.
 * Adding a group means adding it here and in the phone app.
 */

export interface Group {
  id: string;
  name: string;
  /** Marker file inside a POI folder; null for the OSM-only groups. */
  file: string | null;
  icon: string;
  color: string;
  osmOnly: boolean;
  /** OSM POIs of this group are shown only from this zoom (11 is the general gate). */
  osmMinZoom?: number;
}

export const GROUPS: Group[] = [
  { id: 'caves', name: 'Caves', file: 'caves', icon: 'cave', color: '#7E57C2', osmOnly: false },
  { id: 'water', name: 'Water', file: 'water', icon: 'waterfall', color: '#29B6F6', osmOnly: false },
  { id: 'geology', name: 'Geology', file: 'geology', icon: 'volcano', color: '#FF7043', osmOnly: false },
  { id: 'archaeology', name: 'Archaeology', file: 'archaeology', icon: 'column', color: '#D4A017', osmOnly: false },
  { id: 'fortifications', name: 'Fortifications', file: 'fortifications', icon: 'shield', color: '#E53935', osmOnly: false },
  { id: 'religion', name: 'Religion', file: 'religion', icon: 'place-of-worship', color: '#FDD835', osmOnly: false, osmMinZoom: 13 },
  { id: 'structures', name: 'Structures', file: 'structures', icon: 'archway', color: '#8D6E63', osmOnly: false },
  { id: 'abandoned', name: 'Abandoned', file: 'abandoned', icon: 'ghost', color: '#9E9E9E', osmOnly: false },
  { id: 'viewpoints', name: 'Viewpoints', file: 'viewpoints', icon: 'viewpoint', color: '#66BB6A', osmOnly: false },
  { id: 'zoos', name: 'Zoos', file: null, icon: 'paw', color: '#EC407A', osmOnly: true },
  { id: 'gardens', name: 'Gardens', file: null, icon: 'flower', color: '#9CCC65', osmOnly: true },
];

export const NO_GROUP: Group = { id: 'none', name: 'No group', file: null, icon: 'marker', color: '#BDBDBD', osmOnly: false };

/** All groups a marker can have, including "No group". */
export const ALL_GROUPS: Group[] = [...GROUPS, NO_GROUP];

const byId = new Map(ALL_GROUPS.map((g) => [g.id, g]));

export function groupById(id: string | null | undefined): Group {
  return (id && byId.get(id)) || NO_GROUP;
}

/** Group of one of my POIs from the name in its group-<name>.txt file. Unknown or missing = No group. */
export function groupForFile(fileName: string | null): Group {
  if (!fileName) return NO_GROUP;
  const wanted = fileName.toLowerCase();
  return GROUPS.find((g) => g.file === wanted) ?? NO_GROUP;
}

// ── OSM tags → group ─────────────────────────────────────────────────────────────────────────

export type Tags = Record<string, string>;

export interface OsmMatch {
  group: Group;
  /** Human-readable type for the hover, e.g. "Spring", "Archaeological site (tumulus)". */
  type: string;
}

function humanize(value: string): string {
  const s = value.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const NATURAL_WATER = new Set(['spring', 'hot_spring', 'geyser', 'fumarole', 'blowhole', 'crater', 'waterfall']);
const NATURAL_GEOLOGY = new Set(['arch', 'stone', 'rock', 'volcano']);
const HISTORIC_ARCHAEOLOGY = new Set([
  'archaeological_site', 'ruins', 'tomb', 'rune_stone', 'ogham_stone', 'stone', 'boundary_stone',
  'milestone', 'high_cross', 'pa',
]);
const HISTORIC_FORT = new Set(['castle', 'fort', 'city_gate', 'tower', 'bunker', 'cannon', 'battlefield', 'bomb_crater']);
const HISTORIC_RELIGION = new Set(['monastery', 'church', 'wayside_shrine', 'wayside_cross']);
const HISTORIC_STRUCTURES = new Set([
  'bridge', 'manor', 'mine', 'mine_shaft', 'charcoal_pile', 'lime_kiln', 'ice_house', 'gallows',
  'pillory', 'highwater_mark', 'optical_telegraph', 'wreck',
]);
const MAN_MADE_STRUCTURES = new Set([
  'adit', 'mineshaft', 'kiln', 'dovecote', 'watermill', 'windmill', 'lighthouse', 'cairn', 'observatory',
]);
const TOWER_TYPES = new Set(['observation', 'watchtower', 'bell_tower', 'defensive']);

/** Objects that the trails feature draws as lines; never shown as Abandoned markers. */
export function isTrailObject(tags: Tags): boolean {
  return 'abandoned:railway' in tags || tags['abandoned:waterway'] === 'canal' || tags['disused:waterway'] === 'canal';
}

function matchAbandoned(tags: Tags): string | null {
  for (const [key, value] of Object.entries(tags)) {
    const m = /^(abandoned|disused):(.+)$/.exec(key);
    if (m && value) {
      if (m[2] === 'landuse' && value === 'quarry') return `${humanize(m[1])} quarry`;
      return `${humanize(m[1])} ${value === 'yes' ? m[2].replace(/_/g, ' ') : value.replace(/_/g, ' ')}`;
    }
  }
  if (tags.landuse === 'quarry' && tags.disused === 'yes') return 'Disused quarry';
  if (tags.abandoned === 'yes') return `Abandoned${primaryType(tags)}`;
  if (tags.ruins === 'yes') return `Ruins${primaryType(tags)}`;
  return null;
}

function primaryType(tags: Tags): string {
  for (const key of ['building', 'amenity', 'man_made', 'historic', 'place', 'landuse', 'railway', 'shop', 'tourism']) {
    const v = tags[key];
    if (v && v !== 'yes') return ` (${v.replace(/_/g, ' ')})`;
  }
  return '';
}

function matchArchaeology(tags: Tags): string | null {
  const h = tags.historic;
  if (!h || !HISTORIC_ARCHAEOLOGY.has(h)) return null;
  if (h === 'archaeological_site' && tags.site_type) return `Archaeological site (${tags.site_type.replace(/_/g, ' ')})`;
  return humanize(h);
}

function matchFortifications(tags: Tags): string | null {
  if (tags.historic && HISTORIC_FORT.has(tags.historic)) return humanize(tags.historic);
  if (tags.military === 'bunker' || tags.military === 'trench') return humanize(tags.military);
  return null;
}

function matchCaves(tags: Tags): string | null {
  if (tags.natural === 'cave_entrance') return 'Cave entrance';
  if (tags.natural === 'sinkhole') return 'Sinkhole';
  if (tags.man_made === 'cellar_entrance') return 'Cellar entrance';
  return null;
}

function matchWater(tags: Tags): string | null {
  if (tags.natural && NATURAL_WATER.has(tags.natural)) return humanize(tags.natural);
  if (tags.waterway === 'waterfall' || tags.waterway === 'dam' || tags.waterway === 'weir') return humanize(tags.waterway);
  if (tags.amenity === 'public_bath' && tags['bath:type'] === 'hot_spring') return 'Hot spring bath';
  if (tags.man_made === 'water_well') return 'Water well';
  if (tags.man_made === 'cistern' || tags.historic === 'cistern') return 'Cistern';
  return null;
}

function matchGeology(tags: Tags): string | null {
  if (tags.natural && NATURAL_GEOLOGY.has(tags.natural)) return humanize(tags.natural);
  if (tags.geological) return humanize(tags.geological);
  return null;
}

function matchReligion(tags: Tags): string | null {
  if (tags.amenity === 'place_of_worship') {
    if (tags.religion === 'jewish' || tags.building === 'synagogue') return null;
    return tags.religion ? `Place of worship (${tags.religion})` : 'Place of worship';
  }
  if (tags.amenity === 'monastery') return 'Monastery';
  if (tags.historic && HISTORIC_RELIGION.has(tags.historic)) return humanize(tags.historic);
  if (tags.man_made === 'cross') return 'Cross';
  if (tags.amenity === 'grave_yard') return 'Graveyard';
  if (tags.landuse === 'cemetery') return 'Cemetery';
  return null;
}

function matchStructures(tags: Tags): string | null {
  if (tags.historic && HISTORIC_STRUCTURES.has(tags.historic)) return humanize(tags.historic);
  if (tags.man_made && MAN_MADE_STRUCTURES.has(tags.man_made)) return humanize(tags.man_made);
  if (tags.man_made === 'tower' && tags['tower:type'] && TOWER_TYPES.has(tags['tower:type'])) {
    return tags['tower:type'] === 'bell_tower' ? 'Bell tower' : humanize(`${tags['tower:type']} tower`).replace('tower tower', 'tower');
  }
  if (tags.tourism === 'alpine_hut' || tags.tourism === 'wilderness_hut') return humanize(tags.tourism);
  return null;
}

/**
 * Resolves the group of an OSM object, in the spec's priority order: Abandoned, Archaeology,
 * Fortifications, Caves, Water, Geology, Religion, Structures, Viewpoints, Zoos, Gardens.
 */
export function groupForOsmTags(tags: Tags): OsmMatch | null {
  const order: [string, (t: Tags) => string | null][] = [
    ['abandoned', matchAbandoned],
    ['archaeology', matchArchaeology],
    ['fortifications', matchFortifications],
    ['caves', matchCaves],
    ['water', matchWater],
    ['geology', matchGeology],
    ['religion', matchReligion],
    ['structures', matchStructures],
    ['viewpoints', (t) => (t.tourism === 'viewpoint' ? 'Viewpoint' : null)],
    ['zoos', (t) => (t.tourism === 'zoo' ? 'Zoo' : t.tourism === 'aquarium' ? 'Aquarium' : null)],
    ['gardens', (t) => (t.leisure === 'garden' && t['garden:type'] === 'botanical' ? 'Botanical garden' : null)],
  ];
  for (const [id, fn] of order) {
    const type = fn(tags);
    if (type) return { group: groupById(id), type };
  }
  return null;
}
