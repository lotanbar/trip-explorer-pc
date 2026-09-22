/**
 * Greek → Latin romanization (ELOT 743 / ISO 843 style), used when OSM has no English name.
 * "Πορτάρα" → "Portara", "Κούρος Φαράγγι" → "Kouros Farangi". Accents are dropped.
 */

const SINGLE: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm',
  ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};

const VOWELS = new Set('αεηιουω');
/** After these, "αυ"/"ευ" sound as "av"/"ev"; before the rest, "af"/"ef". */
const VOICED = new Set('αβγδεζηιλμνορυωΑΒΓΔΕΖΗΙΛΜΝΟΡΥΩ');

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

/** True when `text` contains Greek letters. */
export function isGreek(text: string): boolean {
  return /[Ͱ-Ͽἀ-῿]/.test(text);
}

export function romanizeGreek(text: string): string {
  const src = stripAccents(text);
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const lower = ch.toLowerCase();
    const upper = ch !== lower;
    const next = (src[i + 1] ?? '').toLowerCase();
    const prev = (src[i - 1] ?? '').toLowerCase();
    let latin: string | null = null;
    let used = 1;

    if (lower === 'ο' && next === 'υ') { latin = 'ou'; used = 2; }
    else if ((lower === 'α' || lower === 'ε') && next === 'υ') {
      const after = src[i + 2] ?? '';
      latin = `${SINGLE[lower]}${after && VOICED.has(after) ? 'v' : 'f'}`;
      used = 2;
    }
    else if (lower === 'γ' && (next === 'γ' || next === 'κ' || next === 'ξ' || next === 'χ')) {
      // γγ → ng, γκ → gk (word start) / nk, γξ → nx, γχ → nch
      latin = next === 'κ' ? (i === 0 || !/[Ͱ-Ͽ]/.test(prev) ? 'gk' : 'nk') : `n${SINGLE[next]}`;
      used = 2;
    }
    else if (lower === 'μ' && next === 'π') { latin = i === 0 || !/[Ͱ-Ͽ]/.test(prev) ? 'b' : 'mp'; used = 2; }
    else if (lower === 'ν' && next === 'τ') { latin = i === 0 || !/[Ͱ-Ͽ]/.test(prev) ? 'd' : 'nt'; used = 2; }
    else if (lower === 'υ' && VOWELS.has(prev) && prev !== 'ο') { latin = 'y'; }
    else if (SINGLE[lower] !== undefined) { latin = SINGLE[lower]; }

    if (latin === null) {
      out += ch;
      i += 1;
      continue;
    }
    if (upper) {
      const wholeWordUpper = used > 1 && src[i + 1] === src[i + 1].toUpperCase();
      latin = wholeWordUpper ? latin.toUpperCase() : latin[0].toUpperCase() + latin.slice(1);
    }
    out += latin;
    i += used;
  }
  return out;
}
