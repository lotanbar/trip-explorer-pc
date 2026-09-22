/**
 * The embedded browser: a child webview the backend lays over the side panel. Clicking an empty
 * spot on the map (or pressing Escape) hides it and the panel is back.
 */

import { invoke } from '@tauri-apps/api/core';
import { openPanel, panelWidth } from './panel';

let open = false;

export function isBrowserOpen(): boolean {
  return open;
}

/** How much of the window bottom the browser leaves free: the panel's status and credit strip. */
export function browserBottomInset(): number {
  const status = document.getElementById('status');
  return status ? Math.max(0, window.innerHeight - status.getBoundingClientRect().top) : 0;
}

/** Shows `url` over the side panel (opening the panel first if it was closed). */
export async function openInBrowser(url: string): Promise<void> {
  openPanel();
  await invoke('browser_open', { url, width: panelWidth(), bottomInset: browserBottomInset() });
  open = true;
}

export async function closeBrowser(): Promise<void> {
  if (!open) return;
  open = false;
  await invoke('browser_close');
}
