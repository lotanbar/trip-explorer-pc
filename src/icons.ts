/**
 * Bundled SVG icons (Maki, Temaki or hand-drawn) and the marker / line-pattern images built from
 * them for MapLibre. Markers follow the reference app's pin: round head, pointed tail, group color
 * fill, white icon, thin outline (amber for my POIs, white for OSM POIs).
 */

const svgFiles = import.meta.glob('./icons/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const svgByName = new Map<string, string>();
for (const [path, svg] of Object.entries(svgFiles)) {
  const name = path.replace(/^.*\//, '').replace(/\.svg$/, '');
  svgByName.set(name, svg);
}

export function iconSvg(name: string): string | null {
  return svgByName.get(name) ?? null;
}

const PIXEL_RATIO = 2;

/** Marker size in CSS pixels, as on the reference desktop map. */
export const MARKER_WIDTH = 30;
export const MARKER_HEIGHT = 39;

export const MY_POI_OUTLINE = '#FFC107';
export const OSM_POI_OUTLINE = '#FFFFFF';
export const TRAIL_COLOR = '#BDBDBD';
/** Icons along trail lines are brighter than the line so they stand out. */
export const TRAIL_ICON_COLOR = '#E0E0E0';

function svgToImage(svg: string, fill: string): Promise<HTMLImageElement> {
  const styled = svg.replace(
    /<svg\b/,
    `<svg style="fill:${fill}"`,
  ).replace(/<\/svg>\s*$/, `<style>path,circle,ellipse,rect,polygon,polyline{fill:${fill} !important}</style></svg>`);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not render icon'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(styled)}`;
  });
}

export interface MarkerImage {
  data: ImageData;
  pixelRatio: number;
}

/** A pin in `color` with `icon` (white) in the head, or a white dot for the "marker" icon. */
export async function buildMarker(icon: string, color: string, outline: string): Promise<MarkerImage> {
  const w = MARKER_WIDTH * PIXEL_RATIO;
  const h = MARKER_HEIGHT * PIXEL_RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const stroke = 1.5 * PIXEL_RATIO;

  ctx.fillStyle = color;
  ctx.strokeStyle = withAlpha(outline, 230 / 255);
  ctx.lineWidth = stroke;
  ctx.lineJoin = 'round';

  // Tail
  ctx.beginPath();
  ctx.moveTo(w * 0.22, w * 0.64);
  ctx.lineTo(w / 2, h - stroke);
  ctx.lineTo(w * 0.78, w * 0.64);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Head
  const cx = w / 2;
  const cy = w / 2;
  const r = w / 2 - stroke;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  const svg = icon === 'marker' ? null : iconSvg(icon);
  if (!svg) {
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const img = await svgToImage(svg, '#FFFFFF');
    const size = w * 0.55;
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
  }
  return { data: ctx.getImageData(0, 0, w, h), pixelRatio: PIXEL_RATIO };
}

/** A small grey icon placed along trail lines. */
export async function buildLineIcon(icon: string, cssSize = 16): Promise<MarkerImage> {
  const s = cssSize * PIXEL_RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const svg = iconSvg(icon);
  if (svg) {
    // Dark halo so the icon reads over the map, then the icon itself.
    const halo = await svgToImage(svg, '#000000');
    ctx.globalAlpha = 0.6;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) ctx.drawImage(halo, dx * PIXEL_RATIO, dy * PIXEL_RATIO, s, s);
    ctx.globalAlpha = 1;
    const img = await svgToImage(svg, TRAIL_ICON_COLOR);
    ctx.drawImage(img, 0, 0, s, s);
  }
  return { data: ctx.getImageData(0, 0, s, s), pixelRatio: PIXEL_RATIO };
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}
