/** Thin wrappers around the Rust commands. */

import { invoke } from '@tauri-apps/api/core';

export interface RecordingInfo {
  name: string;
  path: string;
  incomplete: boolean;
}

export interface PoiInfo {
  name: string;
  path: string;
  lat: number;
  lon: number;
  datetime: string;
  description: string;
  group: string | null;
  media: string[];
}

export interface TripInfo {
  name: string;
  path: string;
  recordings_path: string;
  recordings: RecordingInfo[];
  pois: PoiInfo[];
}

export const scanTrips = (root: string) => invoke<TripInfo[]>('scan_trips', { root });
export const readText = (path: string) => invoke<string>('read_text', { path });
export const loadSettingsJson = () => invoke<string | null>('load_settings');
export const saveSettingsJson = (json: string) => invoke<void>('save_settings', { json });

export interface CacheEntry {
  key: string;
  meta: string;
}

export const cacheIndex = (namespace: string, maxAgeMs: number) =>
  invoke<CacheEntry[]>('cache_index', { namespace, maxAgeMs });
export const cacheGet = (namespace: string, key: string, maxAgeMs: number) =>
  invoke<string | null>('cache_get', { namespace, key, maxAgeMs });
export const cachePut = (namespace: string, key: string, meta: string, data: string) =>
  invoke<void>('cache_put', { namespace, key, meta, data });
export const cacheEvict = (namespace: string, maxAgeMs: number) =>
  invoke<number>('cache_evict', { namespace, maxAgeMs });

export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
