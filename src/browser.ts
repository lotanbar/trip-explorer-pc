/**
 * The embedded browser: a child webview the backend lays over the side panel. Clicking an empty
 * spot on the map (or pressing Escape) hides it and the panel is back.
 *
 * Every page opened here (a POI's search, a trail's website ...) is a visit in the history; Alt+Left /
 * Alt+Right step back and forth through it, reopening the page and flying to its point. The history
 * lives in memory only, so it starts empty each time the app starts.
 */

import { invoke } from '@tauri-apps/api/core';
import { openPanel, panelWidth } from './panel';

export interface Visit {
  url: string;
  /** Where the page is about, when known: the map flies there when stepping to this visit. */
  lat?: number;
  lon?: number;
}

let open = false;
const visits: Visit[] = [];
/** The visit shown now (-1: nothing opened yet). Opening a new page after stepping back drops the visits after it. */
let cursor = -1;

export function isBrowserOpen(): boolean {
  return open;
}

/** How much of the window bottom the browser leaves free: the search bar (and the status line under it). */
export function browserBottomInset(): number {
  const bar = document.getElementById('search-bar');
  return bar ? Math.max(0, window.innerHeight - bar.getBoundingClientRect().top) : 0;
}

async function show(url: string): Promise<void> {
  openPanel();
  await invoke('browser_open', { url, width: panelWidth(), bottomInset: browserBottomInset() });
  open = true;
}

/** Shows `url` over the side panel (opening the panel first if it was closed) as a new visit. */
export async function openInBrowser(url: string, at?: { lat: number; lon: number }): Promise<void> {
  cursor = pushVisit(visits, cursor, { url, ...at });
  await show(url);
}

/** Records a visit after the cursor, dropping any forward ones; returns the new cursor. */
export function pushVisit(list: Visit[], cursor: number, visit: Visit): number {
  const current = list[cursor];
  if (current && current.url === visit.url) return cursor;
  list.splice(cursor + 1, list.length - cursor - 1, visit);
  return list.length - 1;
}

/** Moves the cursor by `delta` (-1 = back, +1 = forward) within the list; unchanged at either end. */
export function stepCursor(length: number, cursor: number, delta: number): number {
  const next = cursor + delta;
  return next >= 0 && next < length ? next : cursor;
}

/** Steps through the history and reopens that visit; returns it, or null when there is nowhere to go. */
export async function stepHistory(delta: number): Promise<Visit | null> {
  const next = stepCursor(visits.length, cursor, delta);
  if (next === cursor) return null;
  cursor = next;
  const visit = visits[cursor];
  await show(visit.url);
  return visit;
}

export async function closeBrowser(): Promise<void> {
  if (!open) return;
  open = false;
  await invoke('browser_close');
}
