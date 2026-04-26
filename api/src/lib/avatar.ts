/**
 * Avatar = a single grapheme cluster, max 16 UTF-16 code units (spec §6.3).
 * `Intl.Segmenter` is the only correct way to count user-perceived characters.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function isSingleGrapheme(value: string): boolean {
  if (value.length === 0 || value.length > 16) return false;
  let count = 0;
  for (const _ of segmenter.segment(value)) {
    count += 1;
    if (count > 1) return false;
  }
  return count === 1;
}
