import { describe, expect, it } from 'vitest';
import { recordingDateRange, tripColor } from '../src/recordings';

describe('recording names', () => {
  it('formats same-day, cross-midnight and unfinished names', () => {
    expect(recordingDateRange('2026-09-14 08-10-05 - 17-45-30.gpx')).toBe('2026-09-14 08:10 – 17:45');
    expect(recordingDateRange('2026-09-14 22-10-12 - 2026-09-15 01-30-48.gpx')).toBe('2026-09-14 22:10 – 2026-09-15 01:30');
    expect(recordingDateRange('2026-09-15 09-02-40 - recording.gpx')).toBe('2026-09-15 09:02 – (incomplete)');
    expect(recordingDateRange('something else.gpx')).toBe('something else');
  });
});

describe('trip colours', () => {
  it('is stable per name and never the trail grey', () => {
    expect(tripColor('Greece 2026')).toBe(tripColor('Greece 2026'));
    expect(tripColor('Greece 2026')).not.toBe(tripColor('Italy 2025'));
    expect(tripColor('x')).toMatch(/^hsl\(\d+, 80%, 58%\)$/);
  });
});
