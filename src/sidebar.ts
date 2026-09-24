/**
 * The side panel: root folder picker, the folder tree with checkboxes, the saved plans with
 * checkboxes (a whole plan or single stops), the group toggles and the trail toggles. The trips and
 * plans scroll inside their own sections. Every choice is written straight into `settings` and
 * reported through callbacks.
 */

import { open } from '@tauri-apps/plugin-dialog';
import type { SyncStatus, TripInfo } from './backend';
import { GROUPS, groupForFile, groupById, NO_GROUP } from './groups';
import { planStopKey, type SavedPlan } from './plan';
import { iconSvg } from './icons';
import { settings, saveSettings } from './settings';
import { TRAIL_CATEGORIES } from './trails';
import { tripColor, recordingDateRange } from './recordings';

export interface SidebarCallbacks {
  onClose: () => void;
  onRootChanged: (root: string) => void;
  onRefresh: () => void;
  /** The Drive button: sign in / pick the Drive folder. */
  onDrive: () => void;
  onCheckedChanged: () => void;
  onGroupsChanged: () => void;
  onTrailsChanged: () => void;
  /** A plan stop's "visited" box was ticked or cleared (`index`: its place in the plan file). */
  onVisitedChanged: (planPath: string, index: number, visited: boolean) => void;
}

export class Sidebar {
  private readonly treeEl: HTMLElement;
  private readonly planTreeEl: HTMLElement;
  private readonly rootLabel: HTMLElement;
  private readonly statusEl: HTMLElement;
  private trips: TripInfo[] = [];
  private checkboxes: HTMLInputElement[] = [];
  private planBoxes: HTMLInputElement[] = [];
  /** Plans whose stops are listed (by file); the rest show as one row. Not remembered. */
  private readonly expanded = new Set<string>();

  constructor(private readonly root: HTMLElement, private readonly cb: SidebarCallbacks) {
    root.innerHTML = `
      <section class="panel-section trips-section">
        <div class="section-head">
          <h2>Trips</h2>
          <div class="actions">
            <button id="pick-root" title="Choose the trips folder">Folder…</button>
            <button id="refresh" title="Re-scan the folders">Refresh</button>
            <button id="panel-close" class="icon-button" title="Close the panel" aria-label="Close the panel">×</button>
          </div>
        </div>
        <div id="root-label" class="root-label muted">No folder chosen</div>
        <div class="drive-row">
          <span id="drive-label" class="drive-label muted">Google Drive: off</span>
          <button id="drive-button" title="Google Drive sync: sign in and pick the Drive folder">Drive…</button>
        </div>
        <div id="drive-progress" class="drive-progress" hidden><div></div></div>
        <div id="tree" class="tree"></div>
      </section>
      <section class="panel-section plans-section">
        <div class="section-head"><h2>Plans</h2></div>
        <div id="plan-tree" class="tree"></div>
      </section>
      <section class="panel-section">
        <div class="section-head">
          <h2>Groups</h2>
          <label class="master"><input type="checkbox" id="osm-master"> OSM POIs</label>
        </div>
        <div id="groups" class="toggle-list"></div>
      </section>
      <section class="panel-section">
        <div class="section-head">
          <h2>Trails</h2>
          <label class="master"><input type="checkbox" id="trails-master"> Trails</label>
        </div>
        <div id="trails" class="toggle-list"></div>
      </section>
      <div id="status" class="status" hidden></div>
    `;
    this.treeEl = root.querySelector('#tree')!;
    this.planTreeEl = root.querySelector('#plan-tree')!;
    this.rootLabel = root.querySelector('#root-label')!;
    this.statusEl = root.querySelector('#status')!;

    root.querySelector('#pick-root')!.addEventListener('click', () => this.pickRoot());
    root.querySelector('#refresh')!.addEventListener('click', () => cb.onRefresh());
    root.querySelector('#drive-button')!.addEventListener('click', () => cb.onDrive());
    root.querySelector('#panel-close')!.addEventListener('click', () => cb.onClose());

    this.buildGroupToggles();
    this.buildTrailToggles();
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
    else if (s.busy && s.total > 0) text = `Drive “${s.folder}”: syncing ${s.done} of ${s.total}`;
    else if (s.busy) text = `Drive “${s.folder}”: checking…`;
    else text = `Drive “${s.folder}”: ${s.last_sync ? `synced ${time(s.last_sync)}` : 'waiting'}`;
    label.textContent = text;
    label.title = [s.email, text].filter(Boolean).join('\n');
    label.classList.toggle('muted', !s.folder || !s.signed_in);
    label.classList.toggle('error', !!s.error);
    bar.hidden = !(s.busy && s.total > 0);
    const part = s.bytes_total > 0 ? s.bytes_done / s.bytes_total : s.total > 0 ? s.done / s.total : 0;
    bar.querySelector<HTMLElement>('div')!.style.width = `${Math.round(Math.min(1, part) * 100)}%`;
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
        const group = groupForFile(poi.group);
        const icon = `<span class="poi-icon" style="background:${group.color}">${iconSvg(group.icon) ?? ''}</span>`;
        children.appendChild(this.node('poi', poi.name, [poi.path], checked, icon, '', `${poi.datetime}${poi.group ? ` · ${groupById(groupForFile(poi.group).id).name}` : ''}`));
      }
      tripNode.appendChild(children);
      this.treeEl.appendChild(tripNode);
    }
    this.syncParents();
  }

  // ── Plans ──

  /** The saved plans: a row per plan (ticks all its stops) with its stops under it when expanded. */
  setPlans(plans: SavedPlan[]): void {
    this.planBoxes = [];
    this.planTreeEl.innerHTML = '';
    if (plans.length === 0) {
      this.planTreeEl.innerHTML = '<div class="muted">No saved plans</div>';
      return;
    }
    const checked = new Set(settings.checked);
    for (const plan of plans) {
      const leaves = plan.stops.map((_, i) => planStopKey(plan.path, i));
      const color = tripColor(plan.name); // from the name, like a trip's; the map uses the same
      const swatch = `<span class="swatch" style="background:${color}"></span>`;
      const planNode = this.node('plan', plan.name, leaves, checked, swatch, '', plan.path, this.planBoxes);
      const children = document.createElement('div');
      children.className = 'children';
      children.hidden = !this.expanded.has(plan.path);
      plan.stops.forEach((stop, i) => {
        const stopNode = this.node('stop', stop.name, [leaves[i]], checked, `<span class="stop-dot" style="background:${color}"></span>`, '', stop.name, this.planBoxes);
        // The second box, at the row's end: visited (the name gets struck through). Saved in the plan file.
        const visited = document.createElement('input');
        visited.type = 'checkbox';
        visited.className = 'visited-box';
        visited.title = 'Visited';
        visited.checked = !!stop.visited;
        stopNode.classList.toggle('visited', visited.checked);
        visited.addEventListener('change', () => {
          stopNode.classList.toggle('visited', visited.checked);
          this.cb.onVisitedChanged(plan.path, i, visited.checked);
        });
        stopNode.querySelector('.row')!.appendChild(visited);
        children.appendChild(stopNode);
      });
      // A span, not a button: a button inside the row's label would take the label's clicks from the checkbox.
      const caret = document.createElement('span');
      caret.className = 'caret';
      caret.setAttribute('role', 'button');
      caret.title = 'Show / hide the stops';
      caret.textContent = children.hidden ? '▸' : '▾';
      caret.addEventListener('click', (e) => {
        e.preventDefault(); // not a click on the label: the checkbox stays as it is
        children.hidden = !children.hidden;
        caret.textContent = children.hidden ? '▸' : '▾';
        children.hidden ? this.expanded.delete(plan.path) : this.expanded.add(plan.path);
      });
      planNode.querySelector('.row')!.prepend(caret);
      planNode.appendChild(children);
      this.planTreeEl.appendChild(planNode);
    }
    this.syncParents();
  }

  /** One tree row. `leaves` are the paths the checkbox controls (one for a leaf, many for a folder). */
  private node(kind: string, label: string, leaves: string[], checked: Set<string>, prefixHtml = '', badge = '', title = '', boxes = this.checkboxes): HTMLElement {
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
    boxes.push(box);
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
    for (const box of [...this.checkboxes, ...this.planBoxes]) {
      const leaves = JSON.parse(box.dataset.leaves!) as string[];
      const n = leaves.filter((l) => checked.has(l)).length;
      box.checked = n > 0 && n === leaves.length;
      box.indeterminate = n > 0 && n < leaves.length;
    }
  }

  get currentTrips(): TripInfo[] {
    return this.trips;
  }

  // ── Groups ──

  private buildGroupToggles(): void {
    const master = this.root.querySelector<HTMLInputElement>('#osm-master')!;
    master.checked = settings.osmPois;
    master.addEventListener('change', () => {
      settings.osmPois = master.checked;
      saveSettings();
      this.cb.onGroupsChanged();
    });
    const list = this.root.querySelector('#groups')!;
    const hidden = new Set(settings.groupsHidden);
    for (const group of [...GROUPS, NO_GROUP]) {
      const row = document.createElement('label');
      row.className = 'toggle';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !hidden.has(group.id);
      box.addEventListener('change', () => {
        const set = new Set(settings.groupsHidden);
        box.checked ? set.delete(group.id) : set.add(group.id);
        settings.groupsHidden = [...set];
        saveSettings();
        this.cb.onGroupsChanged();
      });
      row.appendChild(box);
      const icon = document.createElement('span');
      icon.className = 'poi-icon';
      icon.style.background = group.color;
      icon.innerHTML = iconSvg(group.icon) ?? '';
      row.appendChild(icon);
      const name = document.createElement('span');
      name.textContent = group.name;
      if (group.osmOnly) name.insertAdjacentHTML('beforeend', '<span class="osm-only" title="Only OSM POIs can have this group">OSM</span>');
      row.appendChild(name);
      list.appendChild(row);
    }
  }

  // ── Trails ──

  private buildTrailToggles(): void {
    const master = this.root.querySelector<HTMLInputElement>('#trails-master')!;
    master.checked = settings.trails;
    master.addEventListener('change', () => {
      settings.trails = master.checked;
      saveSettings();
      this.cb.onTrailsChanged();
    });
    const list = this.root.querySelector('#trails')!;
    const hidden = new Set(settings.trailsHidden);
    for (const cat of TRAIL_CATEGORIES) {
      const row = document.createElement('label');
      row.className = 'toggle';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !hidden.has(cat.id);
      box.addEventListener('change', () => {
        const set = new Set(settings.trailsHidden);
        box.checked ? set.delete(cat.id) : set.add(cat.id);
        settings.trailsHidden = [...set];
        saveSettings();
        this.cb.onTrailsChanged();
      });
      row.appendChild(box);
      const icon = document.createElement('span');
      icon.className = 'trail-icon';
      icon.innerHTML = iconSvg(cat.icon) ?? '';
      row.appendChild(icon);
      const name = document.createElement('span');
      name.textContent = cat.name;
      row.appendChild(name);
      list.appendChild(row);
    }
  }
}
