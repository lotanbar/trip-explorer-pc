import { describe, expect, it } from 'vitest';
import { isGreek, romanizeGreek } from '../src/romanize';

describe('Greek romanization', () => {
  it('romanizes common place names', () => {
    expect(romanizeGreek('Πορτάρα')).toBe('Portara');
    expect(romanizeGreek('Κούρος Φαράγγι')).toBe('Kouros Farangi');
    expect(romanizeGreek('Άγιος Γεώργιος')).toBe('Agios Georgios');
    expect(romanizeGreek('Μύλος του Πασπαλίτη')).toBe('Mylos tou Paspaliti');
    expect(romanizeGreek('Ευαγγελίστρια')).toBe('Evangelistria');
    expect(romanizeGreek('Νάξος')).toBe('Naxos');
    expect(romanizeGreek('Μπάρμπα')).toBe('Barmpa');
  });

  it('leaves Latin text alone and detects Greek', () => {
    expect(romanizeGreek('Portara 2')).toBe('Portara 2');
    expect(isGreek('Πορτάρα')).toBe(true);
    expect(isGreek('Portara')).toBe(false);
  });
});
