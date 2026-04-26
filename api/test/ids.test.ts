import { describe, expect, it } from 'vitest';
import { binToUuid, isUuid, newUuid, uuidToBin } from '@/lib/ids.js';

describe('uuid round-trip', () => {
  it('newUuid is a v7 string', () => {
    const u = newUuid();
    expect(isUuid(u)).toBe(true);
    expect(u[14]).toBe('7');
  });
  it('uuidToBin / binToUuid are inverses', () => {
    const u = newUuid();
    expect(binToUuid(uuidToBin(u))).toBe(u);
  });
  it('rejects malformed input', () => {
    expect(() => uuidToBin('not-a-uuid')).toThrow();
  });
});
