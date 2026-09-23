/**
 * The side panel's geometry: a drag handle on its right edge resizes it from the minimum width up
 * to the whole window; the × closes it and the menu button (bottom left of the map) opens it again.
 * When the window shrinks, the panel gives way first (down to its minimum width, the map keeping
 * its width); after that the map shrinks, all the way to nothing. The embedded browser, when
 * shown, follows the panel's width.
 */

import { invoke } from '@tauri-apps/api/core';
import { browserBottomInset, isBrowserOpen } from './browser';
import { saveSettings, settings } from './settings';

export const PANEL_MIN_WIDTH = 357;
/** The drag handle's width; the panel stops short of the window edge by this much so it stays grabbable. */
const HANDLE_WIDTH = 6;

const app = () => document.getElementById('app')!;

/**
 * The map's width the user last settled on (by dragging the handle); kept when the window shrinks.
 * Null until the window has a real size: the web view starts before the window is laid out.
 */
let mapWidth: number | null = null;

const maxPanel = () => Math.max(0, window.innerWidth - HANDLE_WIDTH);

export function panelWidth(): number {
  if (mapWidth === null) {
    if (maxPanel() < PANEL_MIN_WIDTH) return maxPanel();
    mapWidth = maxPanel() - Math.min(Math.max(PANEL_MIN_WIDTH, settings.panelWidth ?? PANEL_MIN_WIDTH), maxPanel());
  }
  const wanted = Math.min(settings.panelWidth ?? PANEL_MIN_WIDTH, maxPanel() - mapWidth);
  return Math.min(Math.max(PANEL_MIN_WIDTH, wanted), maxPanel());
}

function apply(): void {
  const open = settings.panelOpen;
  app().classList.toggle('panel-closed', !open);
  app().style.setProperty('--panel', `${open ? panelWidth() : 0}px`);
  if (isBrowserOpen()) invoke('browser_resize', { width: open ? panelWidth() : 0, bottomInset: browserBottomInset() }).catch(() => undefined);
}

export function openPanel(): void {
  settings.panelOpen = true;
  saveSettings();
  apply();
}

export function closePanel(): void {
  settings.panelOpen = false;
  saveSettings();
  apply();
}

export function initPanel(): void {
  apply();
  window.addEventListener('resize', apply);
  document.getElementById('menu-button')!.addEventListener('click', openPanel);

  const handle = document.getElementById('panel-handle')!;
  handle.addEventListener('pointerdown', (e) => {
    if (!settings.panelOpen) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    app().classList.add('resizing');
    const move = (ev: PointerEvent) => {
      settings.panelWidth = Math.round(Math.min(Math.max(PANEL_MIN_WIDTH, ev.clientX), maxPanel()));
      mapWidth = maxPanel() - settings.panelWidth;
      apply();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      app().classList.remove('resizing');
      saveSettings();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}
