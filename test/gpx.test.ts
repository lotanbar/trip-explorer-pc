import { describe, expect, it } from 'vitest';

import { gpxToStops, planToGpx } from '../src/gpx';
import type { PlanStop } from '../src/plan';

const a: PlanStop = { key: 'osm:n1', lat: 37.1063, lon: 25.3727, name: 'Portara & "Temple" <Apollo>' };
const b: PlanStop = { key: 'search:w2', lat: 37.0, lon: 25.4, name: 'Chalki' };

describe('gpx', () => {
  it('writes waypoints in plan order and reads them back', () => {
    const text = planToGpx('Naxos', [a, b]);
    expect(text).toContain('<metadata><name>Naxos</name></metadata>');
    expect(text).toContain('&amp; &quot;Temple&quot; &lt;Apollo&gt;');
    const stops = gpxToStops(text);
    expect(stops.map((s) => [s.lat, s.lon, s.name])).toEqual([
      [37.1063, 25.3727, a.name],
      [37, 25.4, 'Chalki'],
    ]);
    expect(gpxToStops(planToGpx('', stops)).map((s) => s.key)).toEqual(stops.map((s) => s.key));
  });

  it('reads other writers: attribute order, CDATA, no name, route points only, skips tracks and junk', () => {
    const text = `<gpx><wpt lon='25.1' lat='37.2'><ele>5</ele><name><![CDATA[Café]]></name></wpt>
      <wpt lat="37.3" lon="25.2"/><wpt lat="99" lon="25"><name>bad</name></wpt>
      <trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`;
    expect(gpxToStops(text).map((s) => [s.lat, s.lon, s.name])).toEqual([
      [37.2, 25.1, 'Café'],
      [37.3, 25.2, '37.3, 25.2'],
    ]);
    expect(gpxToStops('<gpx><rte><rtept lat="1" lon="2"><name>R&#233;</name></rtept></rte></gpx>').map((s) => s.name)).toEqual(['Ré']);
    expect(gpxToStops('<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>')).toEqual([]);
  });
});
