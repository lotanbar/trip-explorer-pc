/**
 * Name rules from the spec, the same ones the phone app applies to trip and POI names: a name must
 * copy to Windows unchanged, so anything Windows can't use is refused with a message. Plan names
 * follow the same rules.
 */

const FORBIDDEN = '\\/:*?"<>|';
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((i) => [`COM${i}`, `LPT${i}`])]);

/** Returns null when `name` is allowed, otherwise the message to show. `taken` is compared case-insensitively. */
export function checkName(name: string, taken: readonly string[] = [], what = 'plan'): string | null {
  if (name === '') return 'A name is required.';
  const bad = [...name].find((c) => FORBIDDEN.includes(c));
  if (bad) return `${bad} isn't allowed — Windows can't use it in file names.`;
  if ([...name].some((c) => c < ' ')) return "Control characters aren't allowed in file names.";
  if (name.endsWith('.')) return "A name can't end with a dot — Windows drops it.";
  if (name.endsWith(' ')) return "A name can't end with a space — Windows drops it.";
  if (name.startsWith(' ')) return "A name can't start with a space.";
  if (RESERVED.has(name.toUpperCase())) return `${name} is a reserved name on Windows.`;
  if (taken.some((t) => t.toLowerCase() === name.toLowerCase())) return `A ${what} named "${name}" already exists.`;
  return null;
}
