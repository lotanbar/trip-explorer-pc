/**
 * Bundled SVG icons (Maki or hand-drawn, the same shapes as the phone's) and the marker images built
 * from them for MapLibre. A marker is a pin: squircle head, pointed tail, category color fill,
 * white icon, thin white outline.
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

export const POI_OUTLINE = '#FFFFFF';

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
  // Superellipse |x|^n + |y|^n = r^n with n = 4: rounder than a rounded square, squarer than a circle.
  const n = 4;
  const steps = 96;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const sn = Math.sin(t);
    const x = cx + Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * r;
    const y = cy + Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
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

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}
