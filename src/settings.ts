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
  /** Group ids whose markers are hidden. */
  groupsHidden: string[];
  osmPois: boolean;
  trails: boolean;
  /** Trail category ids that are hidden. */
  trailsHidden: string[];
  camera: Camera | null;
  /** Side panel: shown or closed, and its width in CSS px (null = the minimum). */
  panelOpen: boolean;
  panelWidth: number | null;
}

const DEFAULTS: Settings = {
  root: null,
  checked: [],
  groupsHidden: [],
  osmPois: true,
  trails: true,
  trailsHidden: [],
  camera: null,
  panelOpen: true,
  panelWidth: null,
};

export let settings: Settings = { ...DEFAULTS };

export async function loadSettings(): Promise<Settings> {
  try {
    const json = await loadSettingsJson();
    if (json) settings = { ...DEFAULTS, ...JSON.parse(json) };
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
