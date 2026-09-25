# track-cleanup

Track cleanup for the Trip Explorer PC app: turns a raw 1 Hz GPX recording into a clean line
for the map. **Display only** — the GPX file is never modified.

This is a new, standalone TypeScript module written for the new PC app (Tauri + MapLibre). It has
no dependency on the rest of this repository.

## What it does

```
raw points (per GPX <trkseg>)
  → accuracy filter      drop fixes the phone rated worse than 50 m
  → stationary filter    drop fixes that moved < 5 m since the last kept one (no cloud when standing)
  → Kalman filter        remove jitter, trusting each fix by its accuracy; looser at driving speed
  → jump guard           drop a fix that lands impossibly far from the previous one
  → derive heading/speed from neighbouring smoothed points (the GPX has neither)
  → map matcher          snap to roads/paths where the track follows them, leave the rest alone
  → smoother             light de-jitter of the off-road stretches only
```

### The matcher

Hidden Markov model over road candidates solved with Viterbi (Newson & Krumm, 2009 — the same
method as OSRM, Valhalla and GraphHopper), with a heading prior, one-way penalties, real on-road
distances between consecutive points, and one addition:

**An explicit off-road state.** For every point the hidden state is either "on this road, here"
(one state per nearby road) or "not on any road, where the GPS says". The off-road state costs as
much as a road 20 m away (`offRoadDistanceM`); switching between on- and off-road costs
`switchPenalty`. Viterbi picks the best sequence over the whole track, so:

- driving, at any speed, follows the road's shape closely → snapped;
- walking 40 m beside a road, crossing a road, a parking lot, a field → left where it is;
- walking on a trail → snapped to the trail; leaving it → not.

No speed rule anywhere. Footpaths, tracks and steps are included in the road set on purpose.

## Usage

```ts
import { parseGpx, fetchRoadsForTrack, cleanTrack } from './track-cleanup/src';

const segments = parseGpx(gpxText);                       // half-written last point is ignored
const roads = await fetchRoadsForTrack(segments.flat(), { cache: myDiskCache });
const cleaned = cleanTrack(segments, roads);              // MatchedPoint[][] — one array per <trkseg>
// each point: { timeMs, lat, lon, onRoad }
```

`fetchRoadsForTrack` uses the three public Overpass endpoints with cooldown on 429/5xx and a
pluggable per-tile cache (`RoadCache`: `get`/`set` by tile key). The app should share the cache
with the OSM POI fetcher and expire entries after 30 days.

## Files

| File | Purpose |
| --- | --- |
| `src/gpx.ts` | Reads the recording format (segments, time, accuracy); ignores a half-written point |
| `src/pipeline.ts` | `cleanTrack` — the pipeline above; all filters and their defaults |
| `src/kalman.ts` | 2-D constant-velocity Kalman filter in a local metre frame |
| `src/matcher.ts` | The HMM matcher with the off-road state; all tuning constants |
| `src/roadGraph.ts` | Road network: candidate lookup (grid) and on-road distances (Dijkstra) |
| `src/overpass.ts` | Road fetching from Overpass in ~1 km tiles, cache, endpoint fail-over |
| `src/smoother.ts` | 3-point smoother for off-road stretches with gap and curvature guards |
| `src/geo.ts` | Haversine, bearings, point-to-segment projection |
| `test/` | Synthetic-road tests: slow driving snaps, walking beside/across a road does not, junctions, gaps, filters, Overpass parsing and cache |

## Tuning

Everything is in `DEFAULT_MATCHER_OPTIONS` (`src/matcher.ts`), `DEFAULT_CLEANUP_OPTIONS`
(`src/pipeline.ts`) and `DEFAULT_SMOOTHER_OPTIONS`. Each constant has a comment saying what it
does. The ones most likely to need a nudge after looking at real tracks:

| Constant | Default | Effect |
| --- | --- | --- |
| `offRoadDistanceM` | 20 | Farther than this from every road, for a stretch → off-road |
| `switchPenalty` | 5 | Higher = longer stretches needed before switching on/off road |
| `bearingMinSpeedMps` / `bearingFullSpeedMps` | 0.3 / 1.5 | How early the heading is trusted; keeps crossings off-road |
| `minMovementM` | 5 | Stationary jitter suppression |
| `maxAccuracyM` | 50 | Fixes worse than this are dropped |

## Running the tests

```
cd track-cleanup
npm install
npm test
```

40 000 points on a 20 km road grid clean in about 0.3 s.
