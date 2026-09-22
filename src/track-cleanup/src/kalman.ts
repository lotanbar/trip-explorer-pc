/**
 * 2-D constant-velocity Kalman filter for GPS positions.
 *
 * Two independent 1-D filters (latitude and longitude), each with state [position, velocity].
 * Measurement noise comes from the location service's accuracy estimate, so a shakier fix is
 * trusted less. Process noise grows with speed: tight and smooth when walking, looser at driving
 * speed so the filter follows the road instead of cutting corners.
 *
 * Internally the filter works in metres east/north of the first fix (a local flat frame), which
 * keeps every constant in physical units and is accurate to millimetres over a day's travel.
 */

export interface KalmanOptions {
  /**
   * Process noise as an acceleration σ (m/s²) at walking speed. Higher values follow the
   * measurements more closely; lower values smooth more but lag on turns.
   */
  accelSigmaMps2?: number;
  /** Speed (m/s) above which the acceleration σ starts scaling up. */
  noiseScaleReferenceSpeedMps?: number;
  /** Cap on the process-noise multiplier. */
  maxNoiseScale?: number;
}

const DEFAULTS: Required<KalmanOptions> = {
  accelSigmaMps2: 0.5,
  noiseScaleReferenceSpeedMps: 3.0,
  maxNoiseScale: 16.0,
};

/** Metres per degree of latitude. */
const M_PER_DEG = 111_320;
const DEG = Math.PI / 180;

export class GpsKalmanFilter {
  private readonly opt: Required<KalmanOptions>;
  private north = new Axis(); // metres north of origin
  private east = new Axis();  // metres east of origin
  private originLat = 0;
  private originLon = 0;
  private mPerDegLon = M_PER_DEG;
  private lastTimeMs = 0;
  private initialized = false;

  constructor(options: KalmanOptions = {}) {
    this.opt = { ...DEFAULTS, ...options };
  }

  reset(): void {
    this.north = new Axis();
    this.east = new Axis();
    this.initialized = false;
  }

  /**
   * Feeds one fix and returns the smoothed position.
   * @param speedMps  Current speed estimate; drives the adaptive process noise.
   */
  process(lat: number, lon: number, accuracyM: number, timeMs: number, speedMps: number): { lat: number; lon: number } {
    // Accuracy is a radius in metres; use it as 1σ per axis (a fix with none gets 20 m).
    const sigma = Number.isFinite(accuracyM) ? Math.max(accuracyM, 1) : 20;
    const r = sigma * sigma;

    if (!this.initialized) {
      this.originLat = lat;
      this.originLon = lon;
      this.mPerDegLon = M_PER_DEG * Math.cos(lat * DEG);
      this.north.init(0, r);
      this.east.init(0, r);
      this.lastTimeMs = timeMs;
      this.initialized = true;
      return { lat, lon };
    }

    const dt = Math.max(0, (timeMs - this.lastTimeMs) / 1000);
    this.lastTimeMs = timeMs;

    const ref = this.opt.noiseScaleReferenceSpeedMps;
    const scale = speedMps <= ref ? 1 : Math.min(this.opt.maxNoiseScale, speedMps / ref);
    const qa = this.opt.accelSigmaMps2 * scale;

    const zN = (lat - this.originLat) * M_PER_DEG;
    const zE = (lon - this.originLon) * this.mPerDegLon;
    this.north.predict(dt, qa);
    this.east.predict(dt, qa);
    this.north.update(zN, r);
    this.east.update(zE, r);
    return { lat: this.originLat + this.north.x[0] / M_PER_DEG, lon: this.originLon + this.east.x[0] / this.mPerDegLon };
  }

  /** Current velocity estimate in m/s. */
  get speedMps(): number {
    return Math.hypot(this.north.x[1], this.east.x[1]);
  }
}

/** One axis: state x = [pos, vel], covariance P (2×2). */
class Axis {
  x = [0, 0];
  p = [[1, 0], [0, 1]];

  init(pos: number, r: number): void {
    this.x = [pos, 0];
    this.p = [[r, 0], [0, 100]]; // velocity unknown: σ = 10 m/s
  }

  /** Constant-velocity prediction with white-acceleration process noise of σ = [qa] m/s². */
  predict(dt: number, qa: number): void {
    const [p00, p01] = this.p[0];
    const [p10, p11] = this.p[1];
    this.x[0] += this.x[1] * dt;
    // P = F P Fᵀ + Q with F = [[1, dt], [0, 1]] and Q = qa² [[dt⁴/4, dt³/2], [dt³/2, dt²]]
    const q = qa * qa;
    const dt2 = dt * dt, dt3 = dt2 * dt, dt4 = dt3 * dt;
    this.p = [
      [p00 + dt * (p01 + p10) + dt2 * p11 + q * dt4 / 4, p01 + dt * p11 + q * dt3 / 2],
      [p10 + dt * p11 + q * dt3 / 2, p11 + q * dt2],
    ];
  }

  update(z: number, r: number): void {
    const [p00, p01] = this.p[0];
    const [p10, p11] = this.p[1];
    const s = p00 + r;
    const k0 = p00 / s;
    const k1 = p10 / s;
    const y = z - this.x[0];
    this.x[0] += k0 * y;
    this.x[1] += k1 * y;
    this.p = [
      [(1 - k0) * p00, (1 - k0) * p01],
      [p10 - k1 * p00, p11 - k1 * p01],
    ];
  }
}
