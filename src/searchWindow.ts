/**
 * The search/plan window: shown in the side panel in place of its controls when the search bar is
 * pressed. Top to bottom: the plan's stops (numbered, draggable), the search results, the search
 * bar. Right-click adds a result to the plan or removes a stop; a click flies to it.
 */

import { listPlans, readText, savePlan } from './backend';
import { checkName } from './names';
import { LiveSearch, type SearchResult } from './photon';
import { EMPTY_PLAN, moveStop, parsePlanFile, planFileText, toggleStop, type PlanStop } from './plan';
import { saveSettings, settings } from './settings';

export interface SearchWindowCallbacks {
  /** The map centre, to bias the search. */
  near: () => { lat: number; lon: number } | null;
  flyTo: (lat: number, lon: number) => void;
  /** A plan entry was pressed: the web search a click on the POI would open. */
  openStop: (stop: PlanStop) => void;
  /** The results changed: draw them on the map (empty when the window closes). */
  onResults: (results: SearchResult[]) => void;
  onPlanChanged: () => void;
  onOpenChanged: (open: boolean) => void;
  setStatus: (message: string | null) => void;
}

function baseName(path: string): string {
  return path.replace(/^.*[\\/]/, '');
}

export function resultStop(r: SearchResult): PlanStop {
  return { key: `search:${r.id}`, lat: r.lat, lon: r.lon, name: r.name, searchName: r.name };
}

export class SearchWindow {
  private readonly bar: HTMLElement;
  private readonly win: HTMLElement;
  private readonly planList: HTMLElement;
  private readonly resultList: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly nameInput: HTMLInputElement;
  private readonly plansMenu: HTMLElement;
  private results: SearchResult[] = [];
  private readonly live: LiveSearch;

  constructor(private readonly panel: HTMLElement, private readonly cb: SearchWindowCallbacks) {
    // Both sit above the status line, which stays visible (with the credit) under the embedded browser too.
    panel.querySelector('#status')!.insertAdjacentHTML('beforebegin', `
      <div id="search-bar" class="search-bar">
        <input id="search-open" type="search" placeholder="Search places…" autocomplete="off" spellcheck="false">
      </div>
      <div id="search-window" class="search-window" hidden>
        <div class="section-head">
          <h2>Plan</h2>
          <div class="actions">
            <input id="plan-name" class="plan-name" type="text" placeholder="Plan name" autocomplete="off" spellcheck="false">
            <button id="plan-save" title="Write trips/plans/&lt;name&gt;.txt">Save</button>
            <div class="plans-menu-wrap">
              <button id="plans-button" title="Load a saved plan">Plans ▾</button>
              <div id="plans-menu" class="plans-menu" hidden></div>
            </div>
            <button id="search-close" class="icon-button" title="Close, back to the controls" aria-label="Close">×</button>
          </div>
        </div>
        <ol id="plan-list" class="plan-list"></ol>
        <div class="results-head"><h2>Results</h2><span id="results-note" class="muted"></span></div>
        <div id="result-list" class="result-list"></div>
        <div class="search-bar">
          <input id="search-input" type="search" placeholder="Search places…" autocomplete="off" spellcheck="false">
        </div>
      </div>
    `);
    this.bar = panel.querySelector('#search-bar')!;
    this.win = panel.querySelector('#search-window')!;
    this.planList = panel.querySelector('#plan-list')!;
    this.resultList = panel.querySelector('#result-list')!;
    this.input = panel.querySelector('#search-input')!;
    this.nameInput = panel.querySelector('#plan-name')!;
    this.plansMenu = panel.querySelector('#plans-menu')!;

    const opener = panel.querySelector<HTMLInputElement>('#search-open')!;
    opener.addEventListener('focus', () => this.open(opener.value));
    opener.addEventListener('input', () => this.open(opener.value));
    panel.querySelector('#search-close')!.addEventListener('click', () => this.close());
    this.input.addEventListener('input', () => this.live.update(this.input.value, cb.near));
    this.nameInput.addEventListener('input', () => {
      settings.plan.name = this.nameInput.value;
      saveSettings();
    });
    panel.querySelector('#plan-save')!.addEventListener('click', () => void this.save());
    panel.querySelector('#plans-button')!.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.togglePlansMenu();
    });
    document.addEventListener('click', () => { this.plansMenu.hidden = true; });

    this.live = new LiveSearch((query, results) => {
      if (results instanceof Error) {
        cb.setStatus(`Search failed: ${results.message}`);
        return;
      }
      cb.setStatus(null);
      this.setResults(results, query ? (results.length ? null : 'Nothing found') : null);
    });

    this.nameInput.value = settings.plan.name;
    this.renderPlan();
    if (settings.searchOpen) this.open('');
  }

  get isOpen(): boolean {
    return !this.win.hidden;
  }

  open(query: string): void {
    if (!this.win.hidden) return;
    this.bar.hidden = true;
    this.win.hidden = false;
    this.panel.classList.add('search-open');
    settings.searchOpen = true;
    saveSettings();
    this.input.value = query;
    this.input.focus();
    if (query) this.live.update(query, this.cb.near);
    this.cb.onOpenChanged(true);
    this.cb.onResults(this.results);
  }

  close(): void {
    if (this.win.hidden) return;
    this.live.cancel();
    this.win.hidden = true;
    this.bar.hidden = false;
    this.panel.querySelector<HTMLInputElement>('#search-open')!.value = '';
    this.panel.classList.remove('search-open');
    settings.searchOpen = false;
    saveSettings();
    this.cb.onOpenChanged(false);
    this.cb.onResults([]);
  }

  // ── Results ──

  private setResults(results: SearchResult[], note: string | null): void {
    this.results = results;
    this.panel.querySelector('#results-note')!.textContent = note ?? '';
    this.resultList.innerHTML = '';
    for (const r of results) {
      const row = document.createElement('div');
      row.className = 'result';
      row.dataset.key = `search:${r.id}`;
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
    return this.results.find((r) => `search:${r.id}` === key);
  }

  // ── Plan ──

  get stops(): readonly PlanStop[] {
    return settings.plan.stops;
  }

  inPlan(key: string): boolean {
    return settings.plan.stops.some((s) => s.key === key);
  }

  /** Adds the stop to the end of the plan, or removes it when it is already there. */
  toggle(stop: PlanStop): void {
    settings.plan.stops = toggleStop(settings.plan.stops, stop);
    this.planChanged();
  }

  private planChanged(): void {
    saveSettings();
    this.renderPlan();
    this.markInPlan();
    this.cb.onPlanChanged();
  }

  private renderPlan(): void {
    this.planList.innerHTML = '';
    const stops = settings.plan.stops;
    if (stops.length === 0) {
      this.planList.innerHTML = '<li class="muted empty">Right-click a POI or a result to add it</li>';
      return;
    }
    stops.forEach((stop, i) => {
      const li = document.createElement('li');
      li.className = 'stop';
      li.draggable = true;
      li.dataset.index = String(i);
      li.title = 'Click: go there and search · Right-click: remove · Drag: reorder';
      li.innerHTML = `<span class="num"></span><span class="name"></span>`;
      li.querySelector('.num')!.textContent = String(i + 1);
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
        if (Number.isInteger(from) && from !== i) {
          settings.plan.stops = moveStop(settings.plan.stops, from, i);
          this.planChanged();
        }
      });
      this.planList.appendChild(li);
    });
  }

  private markInPlan(): void {
    for (const row of this.resultList.querySelectorAll<HTMLElement>('.result')) {
      row.classList.toggle('in-plan', this.inPlan(row.dataset.key!));
    }
  }

  private async save(): Promise<void> {
    const root = settings.root;
    if (!root) {
      this.cb.setStatus('Choose the trips folder first');
      return;
    }
    const name = this.nameInput.value.trim();
    const plan = settings.plan;
    if (plan.stops.length === 0) {
      this.cb.setStatus('The plan is empty');
      return;
    }
    // A name already used is refused, unless the plan was loaded from that very file.
    let taken: string[] = [];
    try {
      taken = (await listPlans(root)).filter((p) => p.path !== plan.file).map((p) => p.name);
    } catch (e) {
      this.cb.setStatus(String(e));
      return;
    }
    const problem = checkName(name, taken);
    if (problem) {
      this.cb.setStatus(problem);
      return;
    }
    try {
      // Same name as the loaded file: overwrite it. A new name writes a new file (refused above if taken).
      const overwrite = plan.file !== null && baseName(plan.file).toLowerCase() === `${name.toLowerCase()}.txt`;
      const path = await savePlan(root, name, planFileText(plan.stops), overwrite);
      this.cb.setStatus(`Saved ${path}`);
      settings.plan = { ...EMPTY_PLAN, stops: [] };
      this.nameInput.value = '';
      this.planChanged();
    } catch (e) {
      this.cb.setStatus(String(e));
    }
  }

  private async togglePlansMenu(): Promise<void> {
    if (!this.plansMenu.hidden) {
      this.plansMenu.hidden = true;
      return;
    }
    const root = settings.root;
    if (!root) {
      this.cb.setStatus('Choose the trips folder first');
      return;
    }
    let plans;
    try {
      plans = await listPlans(root);
    } catch (e) {
      this.cb.setStatus(String(e));
      return;
    }
    this.plansMenu.innerHTML = '';
    if (plans.length === 0) this.plansMenu.innerHTML = '<div class="muted item">No saved plans</div>';
    for (const p of plans) {
      const item = document.createElement('button');
      item.className = 'item';
      item.textContent = p.name;
      item.title = p.path;
      item.addEventListener('click', () => void this.load(p.name, p.path));
      this.plansMenu.appendChild(item);
    }
    this.plansMenu.hidden = false;
  }

  private async load(name: string, path: string): Promise<void> {
    this.plansMenu.hidden = true;
    try {
      const stops = parsePlanFile(await readText(path));
      settings.plan = { file: path, name, stops };
      this.nameInput.value = name;
      this.planChanged();
      this.cb.setStatus(`Loaded ${name} (${stops.length} stops)`);
    } catch (e) {
      this.cb.setStatus(String(e));
    }
  }
}
