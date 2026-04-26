/**
 * Recurrence math sanity. We deliberately keep this self-contained - adding
 * the client-side equivalent later should keep these expectations stable.
 */
import { describe, expect, it } from 'vitest';
import { addInterval, currentYearMonth, monthRange, previousYearMonth } from '@/lib/time.js';

describe('addInterval', () => {
  it('adds whole hours', () => {
    const out = addInterval(new Date('2026-04-25T12:00:00.000Z'), { preset: 'hourly', unit: 'hours', interval: 3 });
    expect(out.toISOString()).toBe('2026-04-25T15:00:00.000Z');
  });
  it('adds calendar months and clamps day-of-month', () => {
    const out = addInterval(new Date('2026-01-31T00:00:00.000Z'), { preset: 'monthly', unit: 'months', interval: 1 });
    expect(out.toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });
});

describe('monthRange', () => {
  it('returns UTC bounds for YYYY-MM', () => {
    const { start, end } = monthRange('2026-04');
    expect(start.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('previous/current month', () => {
  it('renders YYYY-MM', () => {
    expect(/^\d{4}-\d{2}$/.test(currentYearMonth(new Date('2026-04-26T00:00:00Z')))).toBe(true);
    expect(previousYearMonth(new Date('2026-01-15T00:00:00Z'))).toBe('2025-12');
  });
});
