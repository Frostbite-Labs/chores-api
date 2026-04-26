/**
 * Recurrence math + month-window helpers. Spec §8.7 - `next_due_at` advances
 * to `addInterval(completedAt, recurrence)` after each completion. The
 * arithmetic mirrors the client `completeTaskForMember` semantics described
 * there; we re-derive it here so the server is self-contained.
 */
import type { RecurrenceRule } from '@/types/task.js';

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;
const MS_WEEK = 7 * MS_DAY;

/**
 * Add one recurrence interval to the supplied instant.
 *
 * Months are calendar months (variable length); other units are constant ms,
 * which matches the client's intuition that "every 2 weeks" means a fixed
 * 14-day stride rather than a calendar-aware offset.
 */
export function addInterval(from: Date, rule: RecurrenceRule): Date {
  const n = rule.interval;
  const d = new Date(from.getTime());
  switch (rule.unit) {
    case 'hours':
      return new Date(d.getTime() + n * MS_HOUR);
    case 'days':
      return new Date(d.getTime() + n * MS_DAY);
    case 'weeks':
      return new Date(d.getTime() + n * MS_WEEK);
    case 'months': {
      // Clamp to last day of target month to avoid Feb-30 surprises.
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth() + n;
      const dayOfMonth = d.getUTCDate();
      const endOfMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      return new Date(
        Date.UTC(y, m, Math.min(dayOfMonth, endOfMonth), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()),
      );
    }
    default: {
      // Exhaustive - the type guard tells us all four are handled.
      const _never: never = rule.unit;
      return _never;
    }
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}

/**
 * UTC month boundaries (`[start, end)`) for `YYYY-MM`. If `tz` is supplied the
 * boundaries are interpreted in that timezone and converted back to UTC, which
 * matches the spec note about `?tz=` overriding leaderboard month edges.
 */
export function monthRange(yearMonth: string, tz?: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!m) throw new TypeError(`invalid YYYY-MM: ${yearMonth}`);
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;

  if (!tz) {
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }
  // Round-trip through Intl: build "wall clock midnight" in tz, then offset.
  const wallStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const wallEnd = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  return {
    start: new Date(wallStart.getTime() - tzOffsetMs(wallStart, tz)),
    end: new Date(wallEnd.getTime() - tzOffsetMs(wallEnd, tz)),
  };
}

function tzOffsetMs(at: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']) % 24,
    Number(parts['minute']),
    Number(parts['second']),
  );
  return asUtc - at.getTime();
}

/** Returns the previous calendar month in `YYYY-MM` form (UTC). */
export function previousYearMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Returns the current calendar month in `YYYY-MM` form (UTC). */
export function currentYearMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
