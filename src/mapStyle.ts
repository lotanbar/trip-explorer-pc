/**
 * Base map: OpenFreeMap vector tiles with its dark style, plus hillshading from the open
 * Mapzen/Tilezen terrain tiles on AWS (Terrarium encoding) with the reference app's settings,
 * inserted below the first label layer.
 */

import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';

export const BASE_STYLE_URL = 'https://tiles.openfreemap.org/styles/fiord';

const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export const HILLSHADE_LAYER_ID = 'terrain-hillshade';

/** Text colour for place labels (cities, towns, villages, islands ...): near white for legibility. */
const PLACE_LABEL_COLOR = '#F4F6F8';
const PLACE_LABEL_HALO = 'rgba(12, 16, 32, 0.85)';

/** Ids of the base style's place-label layers (the ones the user can click). */
export function placeLabelLayerIds(style: StyleSpecification): string[] {
  return style.layers.filter((l) => l.type === 'symbol' && l['source-layer'] === 'place').map((l) => l.id);
}

export async function loadMapStyle(): Promise<StyleSpecification> {
  const res = await fetch(BASE_STYLE_URL);
  if (!res.ok) throw new Error(`Map style: HTTP ${res.status}`);
  const style = (await res.json()) as StyleSpecification;

  style.sources['terrain-dem'] = {
    type: 'raster-dem',
    tiles: [TERRAIN_TILES],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 15,
    attribution: 'Terrain: Mapzen/Tilezen on AWS',
  };

  const hillshade: LayerSpecification = {
    id: HILLSHADE_LAYER_ID,
    type: 'hillshade',
    source: 'terrain-dem',
    paint: {
      'hillshade-illumination-direction': 315,
      'hillshade-exaggeration': 0.5,
      'hillshade-shadow-color': 'rgba(0, 0, 0, 0.5)',
      'hillshade-highlight-color': 'rgba(255, 255, 255, 0.15)',
      'hillshade-accent-color': 'rgba(100, 100, 100, 0.2)',
    },
  };

  // The style asks for a couple of sprite images its sprite sheet does not contain (e.g. a wood
  // pattern); dropping the pattern lets the layer fall back to its plain fill colour.
  for (const layer of style.layers) {
    const paint = (layer as { paint?: Record<string, unknown> }).paint;
    if (paint && 'fill-pattern' in paint) delete paint['fill-pattern'];
  }

  for (const id of placeLabelLayerIds(style)) {
    const layer = style.layers.find((l) => l.id === id) as { paint?: Record<string, unknown> };
    layer.paint = { ...layer.paint, 'text-color': PLACE_LABEL_COLOR, 'text-halo-color': PLACE_LABEL_HALO, 'text-halo-width': 1.4 };
    if (id !== 'place_continent') layer.paint['text-opacity'] = 1;
  }

  const firstSymbol = style.layers.findIndex((l) => l.type === 'symbol');
  if (firstSymbol >= 0) style.layers.splice(firstSymbol, 0, hillshade);
  else style.layers.push(hillshade);
  return style;
}
