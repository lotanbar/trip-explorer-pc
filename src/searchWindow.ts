/**
 * The search/plan window: shown in the side panel in place of its controls when the search bar
 * (always at the bottom of the panel) is used, a plan is picked from the Plans menu or a POI is
 * right-clicked. Top to bottom: the search results, the plan's stops (draggable) with
 * GPX import/export, the search bar with the Plans menu. Right-click adds a result to the plan or
 * removes a stop; a click flies to it.
 *
 * There is one temp plan, kept in the settings until it is saved. A saved plan can be shown in its
 * place; its edits stay in memory until Save, and leaving it with unsaved edits asks first.
 */

import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { listPlans, readText, savePlan, writeText } from './backend';
import { refitBrowser } from './browser';
import { ask } from './dialog';
import { gpxToStops, planToGpx } from './gpx';
import { checkName } from './names';
import { LiveSearch, matchMyPois, resultKey, type MyPoi, type SearchResult } from './photon';
import { EMPTY_PLAN, moveStop, parsePlanFile, planFileText, toggleStop, type PlanStop } from './plan';
import { saveSettings, settings } from './settings';

export interface SearchWindowCallbacks {
  /** The map centre, to bias the search. */
  near: () => { lat: number; lon: number } | null;
  /** All my POIs, searched by name alongside Photon. */
  myPois: () => readonly MyPoi[];
  flyTo: (lat: number, lon: number) => void;
  /** A plan entry was pressed: the web search a click on the POI would open. */
  openStop: (stop: PlanStop) => void;
  /** The results changed: draw them on the map (empty when the window closes). */
  onResults: (results: SearchResult[]) => void;
  onPlanChanged: () => void;
  /** The window opened or closed, or shows another plan (for the screen history). */
  onScreenChanged: () => void;
  /** A plan file was written (the Plans section re-reads the plans). */
  onPlanSaved: () => void;
  /** The window must be seen now (it may have been open already): hide whatever covers the panel. */
  reveal: () => void;
  setStatus: (message: string | null) => void;
}

/** A saved plan shown instead of the temp plan. `saved` is what its file holds. */
interface ShownPlan {
  file: string;
  name: string;
  stops: PlanStop[];
  saved: { name: string; stops: PlanStop[] };
  dirty: boolean;
}

const GPX_FILTER = [{ name: 'GPX', extensions: ['gpx'] }];

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
/** Arrow into a tray / arrow out of a tray. */
const ICON_IMPORT = svg('<path d="M12 3v12M7 10l5 5 5-5M4 17v3h16v-3"/>');
const ICON_EXPORT = svg('<path d="M12 15V3M7 8l5-5 5 5M4 17v3h16v-3"/>');

function baseName(path: string): string {
  return path.replace(/^.*[\\/]/, '');
}

export function resultStop(r: SearchResult): PlanStop {
  return r.mine
    ? { key: resultKey(r), lat: r.lat, lon: r.lon, name: r.name }
    : { key: resultKey(r), lat: r.lat, lon: r.lon, name: r.name, searchName: r.name };
}

export class SearchWindow {
  private readonly win: HTMLElement;
  private readonly planList: HTMLElement;
  private readonly resultList: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly nameInput: HTMLInputElement;
  private readonly plansMenu: HTMLElement;
  private results: SearchResult[] = [];
  private readonly live: LiveSearch;
  /** The saved plan shown, or null for the temp plan. */
  private shown: ShownPlan | null = null;

  constructor(private readonly panel: HTMLElement, private readonly cb: SearchWindowCallbacks) {
    // Both sit above the status line. The bar is one element, always shown, with the Plans menu in it:
    // last in the panel when the window is closed, under the window when open; it stays visible under
    // the embedded browser too.
    panel.querySelector('#status')!.insertAdjacentHTML('beforebegin', `
      <div id="search-window" class="search-window" hidden>
        <div class="results-head">
          <h2>Results</h2><span id="results-note" class="muted"></span>
          <button id="search-close" class="icon-button" title="Close, back to the controls" aria-label="Close">×</button>
        </div>
        <div id="result-list" class="result-list"></div>
        <div class="plan-section">
          <div class="section-head">
            <h2 id="plan-title">Plan</h2>
            <div class="actions">
              <input id="plan-name" class="plan-name" type="text" placeholder="Plan name" autocomplete="off" spellcheck="false">
              <button id="plan-save" title="Write trips/plans/&lt;name&gt;.txt">Save</button>
              <button id="plan-import" class="icon-button" title="Import GPX: add a file's waypoints to this plan" aria-label="Import GPX">${ICON_IMPORT}</button>
              <button id="plan-export" class="icon-button" title="Export GPX: write this plan as a GPX file" aria-label="Export GPX">${ICON_EXPORT}</button>
            </div>
          </div>
          <ol id="plan-list" class="plan-list"></ol>
        </div>
      </div>
      <div id="search-bar" class="search-bar">
        <button id="panel-nav" class="icon-button"></button>
        <input id="search-input" type="search" placeholder="Search places…" autocomplete="off" spellcheck="false">
        <div class="plans-menu-wrap">
          <button id="plans-button" title="New plan, the current plan or a saved one">Plans ▴</button>
          <div id="plans-menu" class="plans-menu" hidden></div>
        </div>
      </div>
    `);
    this.win = panel.querySelector('#search-window')!;
    this.planList = panel.querySelector('#plan-list')!;
    this.resultList = panel.querySelector('#result-list')!;
    this.input = panel.querySelector('#search-input')!;
    this.nameInput = panel.querySelector('#plan-name')!;
    this.plansMenu = panel.querySelector('#plans-menu')!;

    this.input.addEventListener('focus', () => this.open(this.input.value));
    this.input.addEventListener('input', () => {
      this.open(this.input.value);
      this.live.update(this.input.value, cb.near);
    });
    panel.querySelector('#search-close')!.addEventListener('click', () => void this.requestClose());
    this.nameInput.addEventListener('input', () => {
      if (this.shown) {
        this.shown.name = this.nameInput.value;
        this.markDirty();
      } else {
        settings.plan.name = this.nameInput.value;
        saveSettings();
      }
    });
    panel.querySelector('#plan-save')!.addEventListener('click', () => void this.save());
    panel.querySelector('#plan-import')!.addEventListener('click', () => void this.importGpx());
    panel.querySelector('#plan-export')!.addEventListener('click', () => void this.exportGpx());
    panel.querySelector('#plans-button')!.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.togglePlansMenu();
    });
    document.addEventListener('click', () => { this.plansMenu.hidden = true; });
    // The embedded browser sits above the page: it steps back while the menu is open, so the menu shows whole.
    new MutationObserver(() => refitBrowser()).observe(this.plansMenu, { attributes: true, attributeFilter: ['hidden'] });

    this.live = new LiveSearch((query, results) => {
      const mine = matchMyPois(query, cb.myPois());
      if (results instanceof Error) {
        cb.setStatus(`Search failed: ${results.message}`);
        this.setResults(mine, null);
        return;
      }
      cb.setStatus(null);
      const all = [...mine, ...results];
      this.setResults(all, query ? (all.length ? null : 'Nothing found') : null);
    });

    this.renderPlan();
  }

  get isOpen(): boolean {
    return !this.win.hidden;
  }

  /** Shows the window. `focus` is false when it opens from a right-click, so the map keeps the keyboard. */
  open(query: string, focus = true): void {
    this.cb.reveal();
    if (!this.win.hidden) return;
    this.win.hidden = false;
    this.panel.classList.add('search-open');
    if (this.input.value !== query) {
      this.input.value = query;
      if (query) this.live.update(query, this.cb.near);
    }
    if (focus) this.input.focus();
    this.cb.onScreenChanged();
    this.cb.onResults(this.results);
  }

  close(): void {
    if (this.win.hidden) return;
    this.live.cancel();
    this.win.hidden = true;
    this.input.value = '';
    this.input.blur();
    this.setResults([], null);
    this.panel.classList.remove('search-open');
    this.cb.onScreenChanged();
  }

  /** The ×, a click on empty map: closes, unless a saved plan with unsaved edits is shown and the question is cancelled. */
  async requestClose(): Promise<boolean> {
    if (!this.isOpen) return true;
    if (!(await this.leaveShown())) return false;
    this.close();
    return true;
  }

  /** The saved plan shown (its file), or null for the temp plan. */
  get shownFile(): string | null {
    return this.shown?.file ?? null;
  }

  /** Opens the window on the temp plan (null) or a saved plan's file; false when that was refused or failed. */
  async showPlan(file: string | null): Promise<boolean> {
    if (file === this.shownFile) {
      this.open('', false);
      return true;
    }
    return file === null ? this.continueTemp() : this.load(baseName(file).replace(/\.txt$/i, ''), file);
  }

  // ── Results ──

  private setResults(results: SearchResult[], note: string | null): void {
    this.results = results;
    this.panel.querySelector('#results-note')!.textContent = note ?? '';
    this.resultList.innerHTML = '';
    for (const r of results) {
      const row = document.createElement('div');
      row.className = r.mine ? 'result mine' : 'result';
      row.dataset.key = resultKey(r);
      row.title = 'Click: go there · Right-click: add to / remove from the plan';
      row.innerHTML = `<span class="pin"></span><span class="text"><span class="name"></span><span class="sub muted"></span></span>`;
      row.querySelector('.name')!.textContent = r.name;
      row.querySelector('.sub')!.textContent = [r.kind, r.place].filter(Boolean).join(' · ');
      row.addEventListener('click', () => this.cb.flyTo(r.lat, r.lon));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.toggle(resultStop(r));
      });
      this.resultList.appendChild(row);
    }
    this.markInPlan();
    this.cb.onResults(results);
  }

  /** The search result with this key, if it is in the current result list. */
  resultByKey(key: string): SearchResult | undefined {
    return this.results.find((r) => resultKey(r) === key);
  }

  // ── Plan ──

  /** The stops of the plan shown: the temp plan or a saved one. */
  get stops(): readonly PlanStop[] {
    return this.shown ? this.shown.stops : settings.plan.stops;
  }

  private setStops(stops: PlanStop[]): void {
    if (this.shown) {
      this.shown.stops = stops;
      this.markDirty();
    } else {
      settings.plan.stops = stops;
      saveSettings();
    }
    this.planChanged();
  }

  private markDirty(): void {
    const s = this.shown!;
    s.dirty = s.name !== s.saved.name || s.stops.length !== s.saved.stops.length || s.stops.some((x, i) => x.key !== s.saved.stops[i].key);
    this.renderTitle();
  }

  /**
   * A stop of a saved plan was ticked visited in the Plans section (its file is already written). If
   * that plan is shown here, its stop follows (found by place and name: the order here may differ
   * from the file's), so a Save keeps the tick; it is not an unsaved edit.
   */
  setVisited(file: string, stop: PlanStop, visited: boolean): void {
    const s = this.shown;
    if (!s || s.file !== file) return;
    const same = (x: PlanStop) => x.lat.toFixed(5) === stop.lat.toFixed(5) && x.lon.toFixed(5) === stop.lon.toFixed(5) && x.name === stop.name;
    for (const x of [...s.stops, ...s.saved.stops]) if (same(x)) x.visited = visited;
  }

  inPlan(key: string): boolean {
    return this.stops.some((s) => s.key === key);
  }

  /** Adds the stop to the end of the plan shown, or removes it when it is already there. */
  toggle(stop: PlanStop): void {
    this.setStops(toggleStop(this.stops, stop));
    this.open('', false);
  }

  private planChanged(): void {
    this.renderPlan();
    this.markInPlan();
    this.cb.onPlanChanged();
  }

  private renderTitle(): void {
    const title = this.panel.querySelector('#plan-title')!;
    title.textContent = this.shown ? (this.shown.dirty ? 'Saved plan •' : 'Saved plan') : 'Temp plan';
    (title as HTMLElement).title = this.shown ? (this.shown.dirty ? `${this.shown.file} (unsaved changes)` : this.shown.file) : 'Not saved yet: kept until Save or New plan';
    // Save stands out while there is something unsaved: an edited saved plan, or a temp plan with stops.
    const unsaved = this.shown ? this.shown.dirty : settings.plan.stops.length > 0;
    this.panel.querySelector('#plan-save')!.classList.toggle('primary', unsaved);
  }

  /** The list grows with the stops (up to about half the window) and is not shown at all while the plan is empty. */
  private renderPlan(): void {
    this.renderTitle();
    this.nameInput.value = this.shown ? this.shown.name : settings.plan.name;
    this.panel.querySelector<HTMLButtonElement>('#plan-export')!.disabled = this.stops.length === 0;
    this.planList.innerHTML = '';
    const stops = this.stops;
    this.planList.hidden = stops.length === 0;
    if (stops.length === 0) return;
    stops.forEach((stop, i) => {
      const li = document.createElement('li');
      li.className = 'stop';
      li.draggable = true;
      li.dataset.index = String(i);
      li.title = 'Click: go there and search · Right-click: remove · Drag: reorder';
      li.innerHTML = `<span class="num"></span><span class="name"></span>`;
      li.querySelector('.name')!.textContent = stop.name;
      li.addEventListener('click', () => this.cb.openStop(stop));
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.toggle(stop);
      });
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', String(i));
        e.dataTransfer!.effectAllowed = 'move';
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
        li.classList.add('drop-target');
      });
      li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('drop-target');
        const from = Number(e.dataTransfer?.getData('text/plain'));
        if (Number.isInteger(from) && from !== i) this.setStops(moveStop(this.stops, from, i));
      });
      this.planList.appendChild(li);
    });
    // Keep the newest stop in view.
    this.planList.scrollTop = this.planList.scrollHeight;
  }

  private markInPlan(): void {
    for (const row of this.resultList.querySelectorAll<HTMLElement>('.result')) {
      row.classList.toggle('in-plan', this.inPlan(row.dataset.key!));
    }
  }

  /** Saves the plan shown. The temp plan becomes a saved plan (and a new, empty temp plan starts). */
  private async save(): Promise<boolean> {
    const root = settings.root;
    if (!root) {
      this.cb.setStatus('Choose the trips folder first');
      return false;
    }
    const name = this.nameInput.value.trim();
    const stops = [...this.stops];
    if (stops.length === 0) {
      this.cb.setStatus('The plan is empty');
      return false;
    }
    // A name already used is refused, unless it is the shown plan's own file.
    const file = this.shown?.file ?? null;
    let taken: string[] = [];
    try {
      taken = (await listPlans(root)).filter((p) => p.path !== file).map((p) => p.name);
    } catch (e) {
      this.cb.setStatus(String(e));
      return false;
    }
    const problem = checkName(name, taken);
    if (problem) {
      this.cb.setStatus(problem);
      return false;
    }
    try {
      // Same name as the shown file: overwrite it. A new name writes a new file (refused above if taken);
      // the old file stays.
      const overwrite = file !== null && baseName(file).toLowerCase() === `${name.toLowerCase()}.txt`;
      const path = await savePlan(root, name, planFileText(stops), overwrite);
      this.cb.setStatus(`Saved ${path}`);
      if (!this.shown) {
        settings.plan = { ...EMPTY_PLAN, stops: [] };
        saveSettings();
      }
      this.shown = { file: path, name, stops, saved: { name, stops }, dirty: false };
      this.planChanged();
      this.cb.onScreenChanged();
      this.cb.onPlanSaved();
      return true;
    } catch (e) {
      this.cb.setStatus(String(e));
      return false;
    }
  }

  /**
   * Before the shown saved plan is left: asks what to do with unsaved edits. False when the user
   * cancels (or Save fails), so nothing changes.
   */
  private async leaveShown(): Promise<boolean> {
    const s = this.shown;
    if (!s || !s.dirty) return true;
    const choice = await ask(
      `"${s.saved.name}" has changes that are not saved.`,
      [
        { label: 'Save', value: 'save' as const, primary: true },
        { label: 'Discard changes', value: 'discard' as const },
        { label: 'Cancel', value: 'cancel' as const },
      ],
      'cancel' as const,
    );
    if (choice === 'cancel') return false;
    if (choice === 'save') return this.save();
    s.name = s.saved.name;
    s.stops = [...s.saved.stops];
    s.dirty = false;
    this.planChanged();
    return true;
  }

  // ── Plans menu ──

  private async togglePlansMenu(): Promise<void> {
    if (!this.plansMenu.hidden) {
      this.plansMenu.hidden = true;
      return;
    }
    const root = settings.root;
    let plans: { name: string; path: string }[] = [];
    if (root) {
      try {
        plans = await listPlans(root);
      } catch (e) {
        this.cb.setStatus(String(e));
      }
    }
    const menu = this.plansMenu;
    menu.innerHTML = '';
    const item = (label: string, action: () => void, current = false, title = '') => {
      const b = document.createElement('button');
      b.className = current ? 'item current' : 'item';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', () => {
        menu.hidden = true;
        action();
      });
      menu.appendChild(b);
    };
    item('New plan', () => void this.newPlan());
    const temp = settings.plan;
    if (temp.stops.length > 0) {
      const label = `Continue current plan (${temp.stops.length} stop${temp.stops.length === 1 ? '' : 's'})`;
      item(label, () => void this.continueTemp(), !this.shown, temp.name ? `Temp plan "${temp.name}"` : 'Temp plan');
    }
    menu.insertAdjacentHTML('beforeend', '<div class="divider"></div>');
    if (!root) menu.insertAdjacentHTML('beforeend', '<div class="muted item">Choose the trips folder first</div>');
    else if (plans.length === 0) menu.insertAdjacentHTML('beforeend', '<div class="muted item">No saved plans</div>');
    for (const p of plans) item(p.name, () => void this.load(p.name, p.path), this.shown?.file === p.path, p.path);
    menu.hidden = false;
  }

  /** Starts an empty temp plan. Throwing away a temp plan with stops asks first, with a 5 s delay. */
  private async newPlan(): Promise<void> {
    if (!(await this.leaveShown())) return;
    const temp = settings.plan;
    if (temp.stops.length > 0) {
      const n = temp.stops.length;
      const ok = await ask(
        `Start a new plan? The current plan${temp.name ? ` "${temp.name}"` : ''} (${n} stop${n === 1 ? '' : 's'}) is not saved and will be lost.`,
        [
          { label: 'Cancel', value: false },
          { label: 'Discard and start new', value: true, primary: true, delay: 5 },
        ],
        false,
      );
      if (!ok) return;
    }
    settings.plan = { ...EMPTY_PLAN, stops: [] };
    saveSettings();
    this.shown = null;
    this.planChanged();
    this.open('', false);
    this.cb.onScreenChanged();
  }

  private async continueTemp(): Promise<boolean> {
    if (!(await this.leaveShown())) return false;
    this.shown = null;
    this.planChanged();
    this.open('', false);
    this.cb.onScreenChanged();
    return true;
  }

  /** Shows a saved plan. The temp plan is kept as it is. */
  private async load(name: string, path: string): Promise<boolean> {
    if (!(await this.leaveShown())) return false;
    try {
      const stops = parsePlanFile(await readText(path));
      this.shown = { file: path, name, stops, saved: { name, stops: [...stops] }, dirty: false };
      this.planChanged();
      this.open('', false);
      this.cb.onScreenChanged();
      this.cb.setStatus(`Loaded ${name} (${stops.length} stop${stops.length === 1 ? '' : 's'})`);
      return true;
    } catch (e) {
      this.cb.setStatus(String(e));
      return false;
    }
  }

  // ── GPX ──

  /** Adds a GPX file's waypoints to the end of the plan shown, skipping ones already in it. */
  private async importGpx(): Promise<void> {
    const path = await openDialog({ multiple: false, directory: false, filters: GPX_FILTER, title: 'Import a GPX file into the plan' });
    if (typeof path !== 'string') return;
    try {
      const found = gpxToStops(await readText(path));
      if (found.length === 0) {
        this.cb.setStatus(`No waypoints in ${baseName(path)}`);
        return;
      }
      const have = new Set(this.stops.map((s) => s.key));
      const added = found.filter((s) => !have.has(s.key) && have.add(s.key));
      if (!this.nameInput.value.trim()) {
        this.nameInput.value = baseName(path).replace(/\.gpx$/i, '');
        this.nameInput.dispatchEvent(new Event('input'));
      }
      this.setStops([...this.stops, ...added]);
      this.cb.setStatus(`Imported ${added.length} stop${added.length === 1 ? '' : 's'} from ${baseName(path)}${added.length < found.length ? ` (${found.length - added.length} already in the plan)` : ''}`);
    } catch (e) {
      this.cb.setStatus(String(e));
    }
  }

  private async exportGpx(): Promise<void> {
    if (this.stops.length === 0) return;
    const name = this.nameInput.value.trim();
    const path = await saveDialog({ defaultPath: `${name || 'plan'}.gpx`, filters: GPX_FILTER, title: 'Export the plan as GPX' });
    if (!path) return;
    try {
      await writeText(path, planToGpx(name, this.stops));
      this.cb.setStatus(`Exported ${path}`);
    } catch (e) {
      this.cb.setStatus(String(e));
    }
  }
}
