/**
 * Plans as GPX: export writes one waypoint per stop, in plan order; import reads the waypoints
 * (or, in a file without any, the route points). Track points are not stops and are ignored.
 */

import type { PlanStop } from './plan';

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function unescapeXml(s: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  if (cdata) return cdata[1];
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function planToGpx(name: string, stops: readonly PlanStop[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Trip Explorer" xmlns="http://www.topografix.com/GPX/1/1">',
  ];
  if (name.trim()) lines.push(`  <metadata><name>${escapeXml(name.trim())}</name></metadata>`);
  for (const s of stops) {
    lines.push(`  <wpt lat="${s.lat.toFixed(6)}" lon="${s.lon.toFixed(6)}"><name>${escapeXml(s.name.replace(/[\r\n]+/g, ' ').trim())}</name></wpt>`);
  }
  lines.push('</gpx>', '');
  return lines.join('\n');
}

function points(text: string, tag: string): PlanStop[] {
  const stops: PlanStop[] = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}\\s*>)`, 'g');
  for (const m of text.matchAll(re)) {
    const attr = (a: string) => new RegExp(`\\b${a}\\s*=\\s*["']([^"']*)["']`).exec(m[1])?.[1];
    const lat = Number(attr('lat'));
    const lon = Number(attr('lon'));
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) || attr('lat') === undefined || attr('lon') === undefined) continue;
    const raw = /<name>([\s\S]*?)<\/name>/.exec(m[2] ?? '')?.[1];
    const name = (raw ? unescapeXml(raw) : '').replace(/\s+/g, ' ').trim() || `${lat}, ${lon}`;
    stops.push({ key: `gpx:${lat.toFixed(5)},${lon.toFixed(5)}`, lat, lon, name });
  }
  return stops;
}

export function gpxToStops(text: string): PlanStop[] {
  const wpts = points(text, 'wpt');
  return wpts.length ? wpts : points(text, 'rtept');
}
