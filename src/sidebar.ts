/**
 * The side panel: the trips folder picker, the Drive row and the folder tree with checkboxes (it
 * scrolls inside its section). Every tick is written straight into `settings` and reported through
 * a callback.
 */

import { open } from '@tauri-apps/plugin-dialog';
import { type SyncStatus, type TripInfo } from './backend';
import { categoryByKey } from './categories';
import { iconSvg } from './icons';
import { settings, saveSettings } from './settings';
import { tripColor, recordingDateRange } from './recordings';

export interface SidebarCallbacks {
  onRootChanged: (root: string) => void;
  onRefresh: () => void;
  /** The Drive button: sign in / pick the Drive folder. */
  onDrive: () => void;
  /** The Sync button: one pass, both ways. */
  onSync: () => void;
  /** The Drive line was clicked: what the last sync did. */
  onSyncDetails: () => void;
  onCheckedChanged: () => void;
  /** The × in the panel's head. */
  onClose: () => void;
}

export class Sidebar {
  private readonly treeEl: HTMLElement;
  private readonly rootLabel: HTMLElement;
  private readonly statusEl: HTMLElement;
  private trips: TripInfo[] = [];
  private checkboxes: HTMLInputElement[] = [];

  constructor(private readonly root: HTMLElement, private readonly cb: SidebarCallbacks) {
    root.innerHTML = `
      <section class="panel-section trips-section">
        <div class="section-head">
          <h2>Trips</h2>
          <div class="actions">
            <button id="pick-root" title="Choose the trips folder">Folder…</button>
            <button id="refresh" title="Re-scan the folders">Refresh</button>
            <button id="panel-close" class="icon-button" title="Close the panel" aria-label="Close the panel"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
          </div>
        </div>
        <div id="root-label" class="root-label muted">No folder chosen</div>
        <div class="drive-row">
          <span id="drive-label" class="drive-label muted" title="What the last sync did">Google Drive: off</span>
          <button id="sync-button" class="primary" title="Sync with Google Drive: your changes go up, Drive's come down">Sync</button>
          <button id="drive-button" title="Google Drive: sign in and pick the Drive folder">Drive…</button>
        </div>
        <div id="drive-progress" class="drive-progress" hidden><div></div></div>
        <div id="drive-current" class="drive-current muted" hidden></div>
        <div id="tree" class="tree"></div>
      </section>
      <div id="status" class="status" hidden></div>
    `;
    this.treeEl = root.querySelector('#tree')!;
    this.rootLabel = root.querySelector('#root-label')!;
    this.statusEl = root.querySelector('#status')!;

    root.querySelector('#pick-root')!.addEventListener('click', () => this.pickRoot());
    root.querySelector('#refresh')!.addEventListener('click', () => cb.onRefresh());
    root.querySelector('#drive-button')!.addEventListener('click', () => cb.onDrive());
    root.querySelector('#sync-button')!.addEventListener('click', () => cb.onSync());
    root.querySelector('#drive-label')!.addEventListener('click', () => cb.onSyncDetails());
    root.querySelector('#panel-close')!.addEventListener('click', () => cb.onClose());

    this.setRootLabel(settings.root);
  }

  setStatus(message: string | null): void {
    this.statusEl.textContent = message ?? '';
    this.statusEl.hidden = !message;
  }

  /** The Drive line under the folder: where it syncs, how far along, or what went wrong. */
  setSync(s: SyncStatus): void {
    const label = this.root.querySelector<HTMLElement>('#drive-label')!;
    const bar = this.root.querySelector<HTMLElement>('#drive-progress')!;
    const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let text: string;
    if (!s.configured) text = 'Google Drive: not in this build';
    else if (!s.signed_in) text = s.error ?? 'Google Drive: not signed in';
    else if (!s.folder) text = 'Google Drive: no folder picked';
    else if (s.error) text = `Drive: ${s.error}`;
    else if (s.busy && s.total > 0) text = `Syncing ${s.done} of ${s.total}`;
    else if (s.busy) text = 'Syncing…';
    else if (s.last_sync) {
      const up = s.last_changes.filter((l) => l.startsWith('↑')).length;
      const down = s.last_changes.filter((l) => l.startsWith('↓')).length;
      text = `Synced ${time(s.last_sync)}${up || down ? ` · ↑${up} ↓${down}` : ' · no changes'}`;
    } else text = `Drive “${s.folder}”: not synced yet`;
    label.textContent = text;
    label.title = [s.email, text].filter(Boolean).join('\n');
    label.classList.toggle('muted', !s.folder || !s.signed_in);
    label.classList.toggle('error', !!s.error);
    bar.hidden = !(s.busy && s.total > 0);
    const part = s.bytes_total > 0 ? s.bytes_done / s.bytes_total : s.total > 0 ? s.done / s.total : 0;
    bar.querySelector<HTMLElement>('div')!.style.width = `${Math.round(Math.min(1, part) * 100)}%`;
    // While syncing: the item on its way, how much is done and roughly how long is left.
    const cur = this.root.querySelector<HTMLElement>('#drive-current')!;
    const mb = (b: number) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);
    const left = (sec: number) => (sec < 60 ? `${sec} s` : `${Math.round(sec / 60)} min`);
    const parts = [
      s.current ?? '',
      s.bytes_total > 0 ? `${mb(s.bytes_done)} of ${mb(s.bytes_total)} MB` : '',
      s.eta_s != null ? `~${left(s.eta_s)} left` : '',
    ].filter(Boolean);
    cur.hidden = !s.busy || parts.length === 0;
    cur.textContent = parts.join(' · ');
    cur.title = cur.textContent;
    const syncButton = this.root.querySelector<HTMLButtonElement>('#sync-button')!;
    syncButton.disabled = s.busy || !s.signed_in || !s.folder;
  }

  private setRootLabel(root: string | null): void {
    this.rootLabel.textContent = root ?? 'No folder chosen';
    this.rootLabel.title = root ?? '';
    this.rootLabel.classList.toggle('muted', !root);
  }

  private async pickRoot(): Promise<void> {
    const chosen = await open({ directory: true, multiple: false, title: 'Choose the trips folder' });
    if (typeof chosen !== 'string') return;
    settings.root = chosen;
    saveSettings();
    this.setRootLabel(chosen);
    this.cb.onRootChanged(chosen);
  }

  // ── Folder tree ──

  setTrips(trips: TripInfo[]): void {
    this.trips = trips;
    this.checkboxes = [];
    this.treeEl.innerHTML = '';
    if (trips.length === 0) {
      this.treeEl.innerHTML = `<div class="muted">${settings.root ? 'No trip folders found' : 'Choose the trips folder to begin'}</div>`;
      return;
    }
    const checked = new Set(settings.checked);
    for (const trip of trips) {
      const leaves: string[] = [...trip.recordings.map((r) => r.path), ...trip.pois.map((p) => p.path)];
      const recordingLeaves = trip.recordings.map((r) => r.path);

      const tripNode = this.node('trip', trip.name, leaves, checked, `<span class="swatch" style="background:${tripColor(trip.name)}"></span>`);
      const children = document.createElement('div');
      children.className = 'children';

      if (trip.recordings.length > 0) {
        const recNode = this.node('folder', 'recordings', recordingLeaves, checked);
        const recChildren = document.createElement('div');
        recChildren.className = 'children';
        for (const rec of trip.recordings) {
          const label = recordingDateRange(rec.name);
          recChildren.appendChild(this.node('recording', label, [rec.path], checked, '', rec.incomplete ? 'incomplete' : ''));
        }
        recNode.appendChild(recChildren);
        children.appendChild(recNode);
      }
      for (const poi of trip.pois) {
        const cat = categoryByKey(poi.category);
        const icon = `<span class="poi-icon" style="background:${cat.color}">${iconSvg(cat.icon) ?? ''}</span>`;
        children.appendChild(this.node('poi', poi.name, [poi.path], checked, icon, '', `${cat.name} · ${poi.datetime}`));
      }
      tripNode.appendChild(children);
      this.treeEl.appendChild(tripNode);
    }
    this.syncParents();
  }

  /** One tree row. `leaves` are the paths the checkbox controls (one for a leaf, many for a folder). */
  private node(kind: string, label: string, leaves: string[], checked: Set<string>, prefixHtml = '', badge = '', title = ''): HTMLElement {
    const el = document.createElement('div');
    el.className = `node node-${kind}`;
    const row = document.createElement('label');
    row.className = 'row';
    row.title = title || label;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.leaves = JSON.stringify(leaves);
    box.checked = leaves.length > 0 && leaves.every((l) => checked.has(l));
    box.addEventListener('change', () => {
      const set = new Set(settings.checked);
      for (const leaf of leaves) box.checked ? set.add(leaf) : set.delete(leaf);
      settings.checked = [...set];
      saveSettings();
      this.syncParents();
      this.cb.onCheckedChanged();
    });
    this.checkboxes.push(box);
    row.appendChild(box);
    const text = document.createElement('span');
    text.className = 'label';
    text.innerHTML = `${prefixHtml}<span class="name"></span>${badge ? `<span class="badge">${badge}</span>` : ''}`;
    text.querySelector('.name')!.textContent = label;
    row.appendChild(text);
    el.appendChild(row);
    return el;
  }

  /** Folder checkboxes reflect their leaves: all → checked, some → indeterminate. */
  private syncParents(): void {
    const checked = new Set(settings.checked);
    for (const box of this.checkboxes) {
      const leaves = JSON.parse(box.dataset.leaves!) as string[];
      const n = leaves.filter((l) => checked.has(l)).length;
      box.checked = n > 0 && n === leaves.length;
      box.indeterminate = n > 0 && n < leaves.length;
    }
  }

  get currentTrips(): TripInfo[] {
    return this.trips;
  }
}
