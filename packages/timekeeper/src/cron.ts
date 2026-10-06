export type ZonedTimeParts = {
  year?: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

/** Minimal 5-field cron: star, comma, range, or star-slash-n on each field. */
export function cronMatches(schedule: string, dateOrParts: Date | ZonedTimeParts = new Date()): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, day, month, weekday] = parts;
  const time = 'minute' in dateOrParts && 'hour' in dateOrParts
    ? dateOrParts
    : {
        minute: dateOrParts.getMinutes(),
        hour: dateOrParts.getHours(),
        day: dateOrParts.getDate(),
        month: dateOrParts.getMonth() + 1,
        weekday: dateOrParts.getDay(),
      };
  return (
    fieldMatches(minute, time.minute) &&
    fieldMatches(hour, time.hour) &&
    fieldMatches(day, time.day) &&
    fieldMatches(month, time.month) &&
    (fieldMatches(weekday, time.weekday) || (weekday === '7' && time.weekday === 0))
  );
}

function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.includes(',')) {
    return field.split(',').some((f) => fieldMatches(f.trim(), value));
  }
  if (field.includes('-')) {
    const [start, end] = field.split('-').map(Number);
    return value >= start && value <= end;
  }
  if (field.startsWith('*/')) {
    const n = Number(field.slice(2));
    return n > 0 && value % n === 0;
  }
  return Number(field) === value;
}

export const DEFAULT_TIMEZONE = 'America/Los_Angeles';

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function getZonedTimeParts(date = new Date(), timeZone = 'America/Los_Angeles'): ZonedTimeParts {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    const parts = formatter.formatToParts(date);
    const map: Record<string, string> = {};
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = p.value;
    }
    return {
      year: parseInt(map.year, 10),
      month: parseInt(map.month, 10),
      day: parseInt(map.day, 10),
      hour: parseInt(map.hour, 10),
      minute: parseInt(map.minute, 10),
      weekday: WEEKDAYS[map.weekday] ?? 0,
    };
  } catch {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay(),
    };
  }
}

const CRON_FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

/**
 * Checks a 5-field cron against exactly what the scheduler evaluates (`cronMatches`): on each field `*`, a number,
 * a range `a-b`, a step `* /n` (without the space), or a comma list of those, within the field's bounds. Returns the
 * reason it is refused, or `null` when it is valid. Anything the scheduler would silently never match is refused.
 */
export function cronIssue(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === '') return 'cron must have 5 fields: minute hour day-of-month month day-of-week';
  for (let i = 0; i < 5; i++) {
    const { name, min, max } = CRON_FIELDS[i];
    for (const item of parts[i].split(',')) {
      const num = (v: string) => /^\d{1,2}$/.test(v) && Number(v) >= min && Number(v) <= max;
      if (item === '*') continue;
      const step = item.match(/^\*\/(\d{1,2})$/);
      if (step) {
        if (Number(step[1]) < 1 || Number(step[1]) > max) return `${name}: step "${item}" is out of range`;
        continue;
      }
      const range = item.match(/^(\d{1,2})-(\d{1,2})$/);
      if (range) {
        if (!num(range[1]) || !num(range[2]) || Number(range[1]) > Number(range[2])) {
          return `${name}: range "${item}" must be within ${min}-${max}, low to high`;
        }
        continue;
      }
      if (!num(item)) return `${name}: "${item}" is not a value in ${min}-${max}, *, a range a-b or a step */n`;
    }
  }
  return null;
}

/** True when the runtime knows this IANA time zone. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
