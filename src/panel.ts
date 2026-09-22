/**
 * The side panel's geometry: a drag handle on its right edge resizes it from the minimum width up
 * to the whole window; the × closes it and the menu button (bottom left of the map) opens it again.
 * The embedded browser, when shown, follows the panel's width.
 */

import { invoke } from '@tauri-apps/api/core';
import { isBrowserOpen } from './browser';
import { saveSettings, settings } from './settings';

export const PANEL_MIN_WIDTH = 340;

const app = () => document.getElementById('app')!;

export function panelWidth(): number {
  return Math.max(PANEL_MIN_WIDTH, Math.min(window.innerWidth, settings.panelWidth ?? PANEL_MIN_WIDTH));
}

function apply(): void {
  const open = settings.panelOpen;
  app().classList.toggle('panel-closed', !open);
  app().style.setProperty('--panel', `${open ? panelWidth() : 0}px`);
  if (isBrowserOpen()) invoke('browser_resize', { width: open ? panelWidth() : 0 }).catch(() => undefined);
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
      settings.panelWidth = Math.round(Math.max(PANEL_MIN_WIDTH, Math.min(window.innerWidth, ev.clientX)));
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
