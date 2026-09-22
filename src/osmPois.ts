/**
 * OSM POIs: one Overpass query for all groups, split into groups on the PC.
 */

import type { FeatureCollection, Point } from 'geojson';
import { groupById, groupForOsmTags, isTrailObject, type Tags } from './groups';
import { StripStore } from './overpass';

export interface OsmPoi {
  id: string;
  lat: number;
  lon: number;
  name: string | null;
  groupId: string;
  type: string;
  tags: Tags;
}

export const OSM_POI_MIN_ZOOM = 11;

function buildQuery(bbox: string): string {
  return `[out:json][timeout:25];
(
  nwr["natural"~"^(cave_entrance|sinkhole|spring|hot_spring|geyser|fumarole|blowhole|crater|arch|stone|rock|volcano|waterfall)$"]["name"](${bbox});
  nwr["geological"]["name"](${bbox});
  nwr["waterway"~"^(waterfall|dam|weir)$"]["name"](${bbox});
  nwr["historic"~"^(archaeological_site|ruins|tomb|rune_stone|ogham_stone|stone|boundary_stone|milestone|high_cross|pa|castle|fort|city_gate|tower|bunker|cannon|battlefield|bomb_crater|monastery|church|wayside_shrine|wayside_cross|bridge|manor|mine|mine_shaft|charcoal_pile|lime_kiln|ice_house|gallows|pillory|highwater_mark|optical_telegraph|wreck|cistern)$"]["name"](${bbox});
  nwr["military"~"^(bunker|trench)$"]["name"](${bbox});
  nwr["man_made"~"^(adit|mineshaft|cellar_entrance|water_well|cistern|kiln|dovecote|watermill|windmill|lighthouse|cairn|observatory|cross)$"]["name"](${bbox});
  nwr["man_made"="tower"]["tower:type"~"^(observation|watchtower|bell_tower|defensive)$"]["name"](${bbox});
  nwr["amenity"="place_of_worship"]["religion"!="jewish"]["building"!="synagogue"]["name"](${bbox});
  nwr["amenity"~"^(monastery|grave_yard)$"]["name"](${bbox});
  nwr["amenity"="public_bath"]["bath:type"="hot_spring"]["name"](${bbox});
  nwr["landuse"="cemetery"]["name"](${bbox});
  nwr["landuse"="quarry"]["disused"="yes"]["name"](${bbox});
  nwr["tourism"~"^(viewpoint|zoo|aquarium|alpine_hut|wilderness_hut)$"]["name"](${bbox});
  nwr["leisure"="garden"]["garden:type"="botanical"]["name"](${bbox});
  nwr[~"^(abandoned|disused):"~"."]["name"](${bbox});
  nwr["abandoned"="yes"]["name"](${bbox});
  nwr["ruins"="yes"]["name"](${bbox});
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
    const name = tags.name || tags['name:en'] || null;
    const poi = { id: `${el.type[0]}${el.id}`, lat, lon, name, groupId: match.group.id, type: match.type, tags };
    if (isShown(poi)) out.push(poi);
  }
  return out;
}

/** Only named objects are shown (the query already asks for a name; this guards cached data). */
export function isShown(poi: OsmPoi): boolean {
  return poi.name !== null;
}

export const osmPoiStore = new StripStore<OsmPoi>({
  namespace: 'osm-pois-v3', // v3: only named objects are fetched and stored
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
    if (zoom < (groupById(poi.groupId).osmMinZoom ?? OSM_POI_MIN_ZOOM)) continue;
    features.push({
      type: 'Feature',
      id: undefined,
      geometry: { type: 'Point', coordinates: [poi.lon, poi.lat] },
      properties: {
        id: poi.id,
        icon: `osm|${poi.groupId}`,
        hover: osmPoiHover(poi),
        name: poi.name,
        type: poi.type,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}
