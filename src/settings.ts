/** Everything remembered between sessions, saved as one JSON file by the backend. */

import { loadSettingsJson, saveSettingsJson } from './backend';

export interface Camera {
  lng: number;
  lat: number;
  zoom: number;
}

export interface Settings {
  root: string | null;
  /** Checked recordings and POIs, by folder / file path. */
  checked: string[];
  camera: Camera | null;
  /** Side panel: shown or closed, and its width in CSS px (null = the minimum). */
  panelOpen: boolean;
  panelWidth: number | null;
}

const DEFAULTS: Settings = {
  root: null,
  checked: [],
  camera: null,
  panelOpen: true,
  panelWidth: null,
};

export let settings: Settings = { ...DEFAULTS };

export async function loadSettings(): Promise<Settings> {
  try {
    const json = await loadSettingsJson();
    if (json) {
      // Only the known keys: settings of removed features (plans, OSM POIs, trails…) are dropped.
      const saved = JSON.parse(json) as Record<string, unknown>;
      settings = { ...DEFAULTS };
      for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
        if (key in saved) (settings as unknown as Record<string, unknown>)[key] = saved[key];
      }
    }
  } catch (e) {
    console.warn('Settings could not be read, starting fresh', e);
  }
  return settings;
}

let saveTimer: number | undefined;

export function saveSettings(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveSettingsJson(JSON.stringify(settings, null, 2)).catch((e) => console.warn('Settings not saved', e));
  }, 300);
}
