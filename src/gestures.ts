/**
 * Touchpad gestures on the map. WebView2 delivers a pinch as ctrl+wheel and a two-finger drag as a
 * plain wheel with small, continuous deltas; a mouse wheel arrives as large notches. MapLibre would
 * zoom on all of them, so its scroll zoom is off and this decides: pinch zooms around the pointer,
 * two fingers pan the map like a drag, a mouse wheel zooms by half a level per notch.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

/** Zoom levels per pinch delta unit; ~15 units per pinch event, so about a quarter level each. */
const PINCH_ZOOM_PER_UNIT = 1 / 60;
const WHEEL_NOTCH_ZOOM = 0.5;

/** A mouse wheel notch: one axis only, a large integer delta (Chromium sends 100 or 120 per notch). */
function isMouseWheel(e: WheelEvent): boolean {
  return e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY);
}

export function installMapGestures(map: MapLibreMap, mapEl: HTMLElement): void {
  map.scrollZoom.disable();
  mapEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = mapEl.getBoundingClientRect();
    const point: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
    const dy = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 40 : e.deltaY;
    if (e.ctrlKey) {
      map.zoomTo(map.getZoom() - dy * PINCH_ZOOM_PER_UNIT, { around: map.unproject(point), animate: false });
    } else if (isMouseWheel(e)) {
      map.zoomTo(map.getZoom() - Math.sign(dy) * WHEEL_NOTCH_ZOOM, { around: map.unproject(point), duration: 200 });
    } else {
      // Content follows the fingers, as when dragging with the mouse (Windows reports the finger
      // movement as a scroll in the opposite direction, hence no sign flip here).
      map.panBy([e.deltaX, dy], { animate: false });
    }
  }, { passive: false });
}
