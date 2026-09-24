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
/** Writes a file the user picked (GPX export). */
export const writeText = (path: string, text: string) => invoke<void>('write_text', { path, text });

export interface PlanFile {
  name: string;
  path: string;
}

export const listPlans = (root: string) => invoke<PlanFile[]>('list_plans', { root });
/** Writes trips/plans/<name>.txt; refuses an existing file unless `overwrite`. Returns the file path. */
export const savePlan = (root: string, name: string, text: string, overwrite: boolean) =>
  invoke<string>('save_plan', { root, name, text, overwrite });
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

// ── Google Drive sync ──

export interface SyncStatus {
  configured: boolean;
  signed_in: boolean;
  email: string | null;
  folder: string | null;
  busy: boolean;
  done: number;
  total: number;
  bytes_done: number;
  bytes_total: number;
  /** Changes made here that are not on Drive yet. */
  pending_up: number;
  error: string | null;
  last_sync: number | null;
}

export interface DriveFolder {
  id: string;
  name: string;
}

export const driveStatus = () => invoke<SyncStatus>('drive_status');
export const driveSetRoot = (root: string | null) => invoke<void>('drive_set_root', { root });
/** Opens Google's sign-in page in the browser; resolves with the account's email once done. */
export const driveSignIn = () => invoke<string>('drive_sign_in');
export const driveSignOut = () => invoke<void>('drive_sign_out');
/** Subfolders of a Drive folder; `root` is My Drive. */
export const driveListFolders = (parent: string) => invoke<DriveFolder[]>('drive_list_folders', { parent });
export const driveCreateFolder = (parent: string, name: string) => invoke<DriveFolder>('drive_create_folder', { parent, name });
export const drivePickFolder = (id: string, name: string) => invoke<void>('drive_pick_folder', { id, name });
/** Quits even though changes are still going up to Drive. */
export const appClose = () => invoke<void>('app_close');
