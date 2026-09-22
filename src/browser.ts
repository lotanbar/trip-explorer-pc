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

/** Shows `url` over the side panel (opening the panel first if it was closed). */
export async function openInBrowser(url: string): Promise<void> {
  openPanel();
  await invoke('browser_open', { url, width: panelWidth() });
  open = true;
}

export async function closeBrowser(): Promise<void> {
  if (!open) return;
  open = false;
  await invoke('browser_close');
}
