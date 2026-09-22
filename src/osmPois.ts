/**
 * OSM POIs: one Overpass query for all groups, split into groups on the PC.
 */

import type { FeatureCollection, Point } from 'geojson';
import { displayName, groupForOsmTags, isTrailObject, localName, type Tags } from './groups';
import { StripStore } from './overpass';

export interface OsmPoi {
  id: string;
  lat: number;
  lon: number;
  /** Shown on the map: English when available. */
  name: string | null;
  /** Used for web searches. */
  searchName: string | null;
  groupId: string;
  type: string;
  tags: Tags;
}

export const OSM_POI_MIN_ZOOM = 11;

function buildQuery(bbox: string): string {
  return `[out:json][timeout:25];
(
  nwr["natural"~"^(cave_entrance|sinkhole|spring|hot_spring|geyser|fumarole|blowhole|crater|arch|stone|rock|volcano|waterfall)$"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["geological"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["waterway"~"^(waterfall|dam|weir)$"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["historic"~"^(archaeological_site|ruins|tomb|rune_stone|ogham_stone|stone|boundary_stone|milestone|high_cross|pa|castle|fort|city_gate|tower|bunker|cannon|battlefield|bomb_crater|monastery|church|wayside_shrine|wayside_cross|bridge|manor|mine|mine_shaft|charcoal_pile|lime_kiln|ice_house|gallows|pillory|highwater_mark|optical_telegraph|wreck|cistern)$"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["military"~"^(bunker|trench)$"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["man_made"~"^(adit|mineshaft|cellar_entrance|water_well|cistern|kiln|dovecote|watermill|windmill|lighthouse|cairn|observatory|cross)$"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["man_made"="tower"]["tower:type"~"^(observation|watchtower|bell_tower|defensive)$"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["amenity"="place_of_worship"]["religion"!="jewish"]["building"!="synagogue"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["amenity"~"^(monastery|grave_yard)$"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["amenity"="public_bath"]["bath:type"="hot_spring"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["landuse"="cemetery"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["landuse"="quarry"]["disused"="yes"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["tourism"~"^(viewpoint|zoo|aquarium|alpine_hut|wilderness_hut)$"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["leisure"="garden"]["garden:type"="botanical"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr[~"^(abandoned|disused):"~"."]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["abandoned"="yes"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
  nwr["ruins"="yes"]["name"](if: t["wikidata"] != "" || t["wikipedia"] != "" || t["heritage"] != "" || t["website"] != "" || t["image"] != "" || t["wikimedia_commons"] != "" || t["description"] != "" || t["name:en"] != "")(${bbox});
);
out center tags;`;
}

interface Element {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Tags;
}

function parse(json: { elements?: unknown[] }): OsmPoi[] {
  const out: OsmPoi[] = [];
  for (const raw of json.elements ?? []) {
    const el = raw as Element;
    const tags = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    if (isTrailObject(tags)) continue;
    const match = groupForOsmTags(tags);
    if (!match) continue;
    const name = displayName(tags);
    const poi = { id: `${el.type[0]}${el.id}`, lat, lon, name, searchName: localName(tags), groupId: match.group.id, type: match.type, tags };
    if (isShown(poi)) out.push(poi);
  }
  return out;
}

/** Tags that mark an object as worth a marker: someone wrote more than a name about it. */
export const NOTABLE_TAGS = ['wikidata', 'wikipedia', 'heritage', 'website', 'image', 'wikimedia_commons', 'description', 'name:en'];

/**
 * Only named, notable objects are shown. The query already asks Overpass for exactly that;
 * this guards data from older caches.
 */
export function isShown(poi: OsmPoi): boolean {
  return poi.name !== null && NOTABLE_TAGS.some((t) => !!poi.tags[t]);
}

export const osmPoiStore = new StripStore<OsmPoi>({
  namespace: 'osm-pois-v6', // v6: notable = wikidata / wikipedia / heritage / website / image / commons / description / name:en
  buildQuery,
  parse,
  keyOf: (p) => p.id,
});

export function osmPoiHover(poi: OsmPoi): string {
  return poi.name ?? `${poi.type} (unnamed)`;
}

export function osmPoisGeoJson(visibleGroups: Set<string>, zoom: number): FeatureCollection<Point> {
  const features: FeatureCollection<Point>['features'] = [];
  for (const poi of osmPoiStore.items.values()) {
    if (!visibleGroups.has(poi.groupId) || !isShown(poi)) continue;
    if (zoom < OSM_POI_MIN_ZOOM) continue;
    features.push({
      type: 'Feature',
      id: undefined,
      geometry: { type: 'Point', coordinates: [poi.lon, poi.lat] },
      properties: {
        id: poi.id,
        icon: `osm|${poi.groupId}`,
        hover: osmPoiHover(poi),
        name: poi.name,
        searchName: poi.searchName ?? poi.name,
        type: poi.type,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}
