/**
 * Batch map matcher: hidden Markov model over road candidates, solved with Viterbi
 * (Newson & Krumm, 2009), with one addition — an explicit OFF-ROAD state.
 *
 * For every GPS point the hidden state is either "on this road segment, here" (one state per
 * nearby road candidate) or "not on any road, exactly where the GPS says". Viterbi then picks the
 * most probable sequence over the whole track. Because the off-road state is a real competitor
 * with a fixed cost, a stretch of points that consistently sits farther from every road than
 * [offRoadDistanceM] comes out off-road, while a stretch that follows a road's shape closely comes
 * out snapped — regardless of speed. Switching between the two costs [switchPenalty], so single
 * noisy points do not flip the state.
 *
 * All scores are natural-log probabilities (higher is better); constant terms that do not affect
 * the arg-max are dropped.
 */

import { RoadGraph, type Candidate } from './roadGraph';
import { bearingPerpendicularity, haversineMeters } from './geo';

export interface Observation {
  timeMs: number;
  lat: number;
  lon: number;
  accuracyM: number;
  /** Direction of travel; null when unknown. */
  bearingDeg: number | null;
  speedMps: number;
}

export interface MatchedPoint {
  timeMs: number;
  lat: number;
  lon: number;
  onRoad: boolean;
}

export interface MatcherOptions {
  /**
   * The off-road state competes as if it were a road this far away (metres). Points steadily
   * farther than this from every road end up off-road; points closer end up snapped.
   */
  offRoadDistanceM: number;
  /** Log-cost of switching between on-road and off-road (each way). */
  switchPenalty: number;
  /** GPS noise σ floor (metres) at highway speed, where GPS is at its most accurate. */
  minSigmaHighwayM: number;
  /** GPS noise σ floor (metres) in slow/city driving and walking. */
  minSigmaCityM: number;
  /** GPS noise σ ceiling (metres). */
  maxSigmaM: number;
  /** Speed (m/s) at or above which the highway σ floor applies. */
  highwaySpeedMps: number;
  /** Transition scale β (metres): tolerance of |straight-line − on-road| distance. */
  betaM: number;
  /** Weight on the transition term so route plausibility competes with snap distance. */
  transitionWeight: number;
  /** Penalty distance (metres) used when no on-road path is found between two candidates. */
  degradedDiffM: number;
  /** Bearing-prior weight (log units) at full trust. */
  bearingWeight: number;
  /**
   * Below this speed (m/s) the bearing is too noisy to use. The heading is derived from
   * consecutive Kalman-smoothed points, which is reliable at a slow walk already, so the ramp
   * starts low; this is what keeps a walk across a road from being snapped along it.
   */
  bearingMinSpeedMps: number;
  /** At or above this speed (m/s) the bearing prior is fully trusted. */
  bearingFullSpeedMps: number;
  /** Candidate search radius bounds (metres). */
  minRadiusM: number;
  maxRadiusM: number;
  /** Max road candidates kept per point. */
  maxCandidates: number;
  /** Prune states whose score trails the best by more than this. */
  beamMargin: number;
  /** Time gap (ms) above which the track is matched as separate runs. */
  segmentBreakMs: number;
}

export const DEFAULT_MATCHER_OPTIONS: MatcherOptions = {
  offRoadDistanceM: 20,
  switchPenalty: 5.0,
  minSigmaHighwayM: 5,
  minSigmaCityM: 8,
  maxSigmaM: 25,
  highwaySpeedMps: 20,
  betaM: 30,
  transitionWeight: 1.5,
  degradedDiffM: 80,
  bearingWeight: 4.0,
  bearingMinSpeedMps: 0.3,
  bearingFullSpeedMps: 1.5,
  minRadiusM: 30,
  maxRadiusM: 80,
  maxCandidates: 6,
  beamMargin: 12,
  segmentBreakMs: 20_000,
};

export class MapMatcher {
  private readonly opt: MatcherOptions;

  constructor(private readonly graph: RoadGraph, options: Partial<MatcherOptions> = {}) {
    this.opt = { ...DEFAULT_MATCHER_OPTIONS, ...options };
  }

  match(observations: Observation[]): MatchedPoint[] {
    const out: MatchedPoint[] = [];
    if (observations.length === 0) return out;
    let start = 0;
    for (let i = 1; i <= observations.length; i++) {
      const gap = i < observations.length && observations[i].timeMs - observations[i - 1].timeMs > this.opt.segmentBreakMs;
      if (i === observations.length || gap) {
        this.viterbi(observations, start, i, out);
        start = i;
      }
    }
    return out;
  }

  // ── Model ─────────────────────────────────────────────────────────────────────────────────

  sigmaFor(accuracyM: number, speedMps: number): number {
    const floor = speedMps >= this.opt.highwaySpeedMps ? this.opt.minSigmaHighwayM : this.opt.minSigmaCityM;
    const a = Number.isFinite(accuracyM) ? accuracyM : 2 * this.opt.minSigmaCityM;
    return Math.min(this.opt.maxSigmaM, Math.max(floor, a / 2));
  }

  radiusFor(accuracyM: number): number {
    return Math.min(this.opt.maxRadiusM, Math.max(this.opt.minRadiusM, 4 * this.sigmaFor(accuracyM, 0)));
  }

  private bearingWeightFor(speedMps: number): number {
    const { bearingMinSpeedMps: lo, bearingFullSpeedMps: hi, bearingWeight } = this.opt;
    if (speedMps <= lo) return 0;
    if (speedMps >= hi) return bearingWeight;
    return bearingWeight * (speedMps - lo) / (hi - lo);
  }

  /** On-road emission: Gaussian on snap distance plus a soft heading prior. */
  emissionRoad(obs: Observation, cand: Candidate): number {
    const sigma = this.sigmaFor(obs.accuracyM, obs.speedMps);
    const z = cand.distMeters / sigma;
    let log = -0.5 * z * z;
    if (obs.bearingDeg !== null) {
      const w = this.bearingWeightFor(obs.speedMps);
      if (w > 0) log -= w * bearingPerpendicularity(obs.bearingDeg, cand.segBearing) / 90;
    }
    return log;
  }

  /** Off-road emission: as if the nearest road were [offRoadDistanceM] away. */
  emissionOff(obs: Observation): number {
    const z = this.opt.offRoadDistanceM / this.sigmaFor(obs.accuracyM, obs.speedMps);
    return -0.5 * z * z;
  }

  /** Road→road transition: penalises detours (on-road distance ≠ straight-line distance). */
  transitionRoad(prev: Candidate, next: Candidate, straightM: number): number {
    const maxDist = Math.min(2_000, straightM + Math.max(60, straightM * 0.5));
    const nd = this.graph.networkDistance(prev, next, maxDist);
    const diff = nd === null ? this.opt.degradedDiffM : Math.abs(straightM - nd);
    return -this.opt.transitionWeight * diff / this.opt.betaM;
  }

  // ── Viterbi over one run [start, end) ─────────────────────────────────────────────────────

  private viterbi(obs: Observation[], start: number, end: number, out: MatchedPoint[]): void {
    const n = end - start;
    // Per column: road candidates, followed by the OFF state at index cands.length.
    const cands: Candidate[][] = [];
    for (let t = 0; t < n; t++) {
      const o = obs[start + t];
      cands.push(this.graph.candidates(o.lat, o.lon, this.radiusFor(o.accuracyM), this.opt.maxCandidates));
    }
    const score: Float64Array[] = [];
    const back: Int32Array[] = [];

    // Column 0.
    {
      const o = obs[start];
      const c = cands[0];
      const s = new Float64Array(c.length + 1);
      for (let j = 0; j < c.length; j++) s[j] = this.emissionRoad(o, c[j]);
      s[c.length] = this.emissionOff(o);
      score.push(s);
      back.push(new Int32Array(c.length + 1).fill(-1));
    }

    for (let t = 1; t < n; t++) {
      const oPrev = obs[start + t - 1], oCur = obs[start + t];
      const cPrev = cands[t - 1], cCur = cands[t];
      const sPrev = score[t - 1];
      const offPrev = cPrev.length, offCur = cCur.length;
      const straightM = haversineMeters(oPrev.lat, oPrev.lon, oCur.lat, oCur.lon);
      let bestPrev = -Infinity;
      for (const v of sPrev) if (v > bestPrev) bestPrev = v;
      const beam = bestPrev - this.opt.beamMargin;

      const sCur = new Float64Array(cCur.length + 1);
      const bCur = new Int32Array(cCur.length + 1);

      // Road states.
      for (let j = 0; j < cCur.length; j++) {
        let best = -Infinity, bi = offPrev;
        for (let i = 0; i < cPrev.length; i++) {
          if (sPrev[i] < beam) continue;
          const s = sPrev[i] + this.transitionRoad(cPrev[i], cCur[j], straightM);
          if (s > best) { best = s; bi = i; }
        }
        const fromOff = sPrev[offPrev] - this.opt.switchPenalty;
        if (fromOff > best) { best = fromOff; bi = offPrev; }
        sCur[j] = best + this.emissionRoad(oCur, cCur[j]);
        bCur[j] = bi;
      }

      // Off-road state.
      {
        let best = sPrev[offPrev], bi = offPrev;
        for (let i = 0; i < cPrev.length; i++) {
          const s = sPrev[i] - this.opt.switchPenalty;
          if (s > best) { best = s; bi = i; }
        }
        sCur[offCur] = best + this.emissionOff(oCur);
        bCur[offCur] = bi;
      }

      score.push(sCur);
      back.push(bCur);
    }

    // Backtrace.
    let k = argMax(score[n - 1]);
    const picked: MatchedPoint[] = new Array(n);
    for (let t = n - 1; t >= 0; t--) {
      const o = obs[start + t];
      const c = cands[t];
      picked[t] = k < c.length
        ? { timeMs: o.timeMs, lat: c[k].lat, lon: c[k].lon, onRoad: true }
        : { timeMs: o.timeMs, lat: o.lat, lon: o.lon, onRoad: false };
      k = back[t][k];
    }
    for (const p of picked) out.push(p);
  }
}

function argMax(a: Float64Array): number {
  let bi = 0, bv = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] > bv) { bv = a[i]; bi = i; }
  return bi;
}
