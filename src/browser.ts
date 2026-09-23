/**
 * The embedded browser: a child webview the backend lays over the side panel. Clicking an empty
 * spot on the map (or pressing Escape) hides it and the panel is back. Each page opened here is a
 * screen in the panel's history (see screens.ts); inside the browser, Alt+Left / Alt+Right are its
 * own back and forward.
 */

import { invoke } from '@tauri-apps/api/core';
import { openPanel, panelWidth } from './panel';

export interface Page {
  url: string;
  /** Where the page is about, when known. */
  lat?: number;
  lon?: number;
}

let open = false;
let page: Page | null = null;
let onChange: () => void = () => undefined;

/** Called whenever the browser is shown with a new page or hidden. */
export function onBrowserChange(listener: () => void): void {
  onChange = listener;
}

/** The page shown, or null while the browser is hidden. */
export function browserPage(): Page | null {
  return open ? page : null;
}

export function isBrowserOpen(): boolean {
  return open;
}

/** How much of the window bottom the browser leaves free: the search bar (and the status line under it). */
export function browserBottomInset(): number {
  const bar = document.getElementById('search-bar');
  return bar ? Math.max(0, window.innerHeight - bar.getBoundingClientRect().top) : 0;
}

/**
 * Shows `url` over the side panel (opening the panel first if it was closed). `focus`: the browser
 * takes the keyboard; false when a screen comes back from the history, so the keys keep walking it.
 */
export async function openInBrowser(url: string, at?: { lat: number; lon: number }, focus = true): Promise<void> {
  openPanel();
  await invoke('browser_open', { url, width: panelWidth(), bottomInset: browserBottomInset(), focus });
  open = true;
  page = { url, ...at };
  onChange();
}

export async function closeBrowser(): Promise<void> {
  if (!open) return;
  open = false;
  onChange();
  await invoke('browser_close');
}
