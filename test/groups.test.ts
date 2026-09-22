import { describe, expect, it } from 'vitest';
import { groupForFile, groupForOsmTags, isTrailObject, NO_GROUP } from '../src/groups';

describe('my POI groups', () => {
  it('reads the group from the file name, unknown or missing means No group', () => {
    expect(groupForFile('water').id).toBe('water');
    expect(groupForFile('Caves').id).toBe('caves');
    expect(groupForFile('zoos')).toBe(NO_GROUP); // OSM-only
    expect(groupForFile('nonsense')).toBe(NO_GROUP);
    expect(groupForFile(null)).toBe(NO_GROUP);
  });
});

describe('OSM tag mapping', () => {
  const g = (tags: Record<string, string>) => groupForOsmTags(tags);

  it('maps single tags', () => {
    expect(g({ natural: 'spring' })).toMatchObject({ group: { id: 'water' }, type: 'Spring' });
    expect(g({ natural: 'cave_entrance' })).toMatchObject({ group: { id: 'caves' }, type: 'Cave entrance' });
    expect(g({ geological: 'outcrop' })).toMatchObject({ group: { id: 'geology' }, type: 'Outcrop' });
    expect(g({ tourism: 'viewpoint' })).toMatchObject({ group: { id: 'viewpoints' } });
    expect(g({ tourism: 'aquarium' })).toMatchObject({ group: { id: 'zoos' } });
    expect(g({ leisure: 'garden', 'garden:type': 'botanical' })).toMatchObject({ group: { id: 'gardens' } });
    expect(g({ leisure: 'garden' })).toBeNull();
    expect(g({ man_made: 'tower', 'tower:type': 'observation' })).toMatchObject({ group: { id: 'structures' } });
    expect(g({ man_made: 'tower', 'tower:type': 'communication' })).toBeNull();
  });

  it('names the archaeological site type', () => {
    expect(g({ historic: 'archaeological_site', site_type: 'tumulus' })?.type).toBe('Archaeological site (tumulus)');
  });

  it('excludes synagogues', () => {
    expect(g({ amenity: 'place_of_worship', religion: 'jewish' })).toBeNull();
    expect(g({ amenity: 'place_of_worship', building: 'synagogue' })).toBeNull();
    expect(g({ amenity: 'place_of_worship', religion: 'christian' })?.group.id).toBe('religion');
  });

  it('applies the priority order for objects with several matching tags', () => {
    expect(g({ historic: 'castle', tourism: 'viewpoint' })?.group.id).toBe('fortifications');
    expect(g({ historic: 'castle', ruins: 'yes' })?.group.id).toBe('abandoned');
    expect(g({ historic: 'ruins', natural: 'spring' })?.group.id).toBe('archaeology');
  });

  it('maps abandoned and disused keys', () => {
    expect(g({ 'abandoned:place': 'village' })).toMatchObject({ group: { id: 'abandoned' }, type: 'Abandoned village' });
    expect(g({ 'disused:landuse': 'quarry' })?.type).toBe('Disused quarry');
    expect(g({ landuse: 'quarry', disused: 'yes' })?.type).toBe('Disused quarry');
    expect(g({ abandoned: 'yes', building: 'church' })?.type).toBe('Abandoned (church)');
  });

  it('leaves trail objects to the trails feature', () => {
    expect(isTrailObject({ 'abandoned:railway': 'rail' })).toBe(true);
    expect(isTrailObject({ 'disused:waterway': 'canal' })).toBe(true);
    expect(isTrailObject({ 'disused:shop': 'yes' })).toBe(false);
  });
});
