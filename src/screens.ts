/**
 * The side panel's screen history: what the panel showed, in order — the controls, the search/plan
 * window (with the temp plan or a saved one) or a page in the embedded browser. Alt+Left / Alt+Right
 * (with the map or the panel focused) step back and forth through it. When the embedded browser has
 * the keyboard, the same keys are the browser's own back/forward instead (see the backend).
 * The history lives in memory only, so it starts empty each time the app starts.
 */

export type Screen =
  | { kind: 'controls' }
  /** `plan`: the saved plan's file, or null for the temp plan. */
  | { kind: 'search'; plan: string | null }
  /** `lat` / `lon`: where the page is about, when known; the map flies there when stepping to it. */
  | { kind: 'browser'; url: string; lat?: number; lon?: number };

export function sameScreen(a: Screen | undefined, b: Screen): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'search') return a.plan === (b as typeof a).plan;
  if (a.kind === 'browser') return a.url === (b as typeof a).url;
  return true;
}

/** Records a screen after the cursor, dropping any forward ones; returns the new cursor. */
export function pushScreen(list: Screen[], cursor: number, screen: Screen): number {
  if (sameScreen(list[cursor], screen)) return cursor;
  list.splice(cursor + 1, list.length - cursor - 1, screen);
  return list.length - 1;
}

/** Moves the cursor by `delta` (-1 = back, +1 = forward) within the list; unchanged at either end. */
export function stepCursor(length: number, cursor: number, delta: number): number {
  const next = cursor + delta;
  return next >= 0 && next < length ? next : cursor;
}

export class ScreenHistory {
  private readonly list: Screen[] = [];
  private cursor = -1;
  /** Set while a screen is being restored, so the changes that makes are not recorded. */
  private restoring = false;

  record(screen: Screen): void {
    if (!this.restoring) this.cursor = pushScreen(this.list, this.cursor, screen);
  }

  /**
   * Steps back (-1) or forward (+1) and hands the screen to `show`. The cursor moves only when
   * `show` succeeds (it can be refused, e.g. when leaving a plan with unsaved edits is cancelled).
   */
  async step(delta: number, show: (screen: Screen) => Promise<boolean>): Promise<void> {
    const next = stepCursor(this.list.length, this.cursor, delta);
    if (next === this.cursor || this.restoring) return;
    this.restoring = true;
    try {
      if (await show(this.list[next])) this.cursor = next;
    } finally {
      // The screen's own changes are reported asynchronously; let them pass before recording again.
      window.setTimeout(() => { this.restoring = false; }, 50);
    }
  }
}
