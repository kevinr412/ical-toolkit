import {
  IcsParseError,
  findComponents,
  getProperty,
  getPropertyValue,
  parseDateTimeProperty,
  unescapeText,
  zonedTimeToUtc,
} from './ics.js';
import type { IcsComponent, IcsDateTime } from './ics.js';

// RRULE expansion for the common cases: DAILY, WEEKLY, MONTHLY and YEARLY
// with INTERVAL, COUNT, UNTIL, WKST, BYDAY (with ordinals for MONTHLY and
// YEARLY), BYMONTHDAY and BYMONTH. Anything outside that is rejected with an
// error instead of being silently ignored, because a wrong expansion looks
// just like a right one.

type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

interface DaySpec {
  day: number; // 0 = Sunday, matching Date#getUTCDay
  n?: number; // ordinal, e.g. 2 for "2MO", -1 for "-1FR"
}

interface Rule {
  freq: Freq;
  interval: number;
  count?: number;
  until?: Date;
  byDay: DaySpec[];
  byMonthDay: number[];
  byMonth: number[];
  wkst: number;
}

export interface Occurrence {
  uid?: string;
  summary?: string;
  start: Date;
}

const DAY_MS = 86_400_000;
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const BYDAY_RE = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/;
// Guards against rules that never produce a candidate (e.g. BYMONTHDAY=31
// with BYMONTH=2), which would otherwise loop forever.
const MAX_PERIODS = 50_000;

function parseInteger(name: string, text: string): number {
  if (!/^[+-]?\d+$/.test(text)) throw new IcsParseError(`invalid ${name} in RRULE: ${text}`);
  return Number(text);
}

function parseIntegerList(name: string, text: string, min: number, max: number): number[] {
  return text.split(',').map((item) => {
    const n = parseInteger(name, item);
    if (n === 0 || n < min || n > max) throw new IcsParseError(`${name} out of range in RRULE: ${item}`);
    return n;
  });
}

function parseRule(rrule: string): Rule {
  const rule: Rule = { freq: 'DAILY', interval: 1, byDay: [], byMonthDay: [], byMonth: [], wkst: 1 };
  let sawFreq = false;

  for (const part of rrule.split(';')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq === -1) throw new IcsParseError(`invalid RRULE part: ${part}`);
    const key = part.slice(0, eq).toUpperCase();
    const value = part.slice(eq + 1).toUpperCase();

    switch (key) {
      case 'FREQ':
        if (value !== 'DAILY' && value !== 'WEEKLY' && value !== 'MONTHLY' && value !== 'YEARLY') {
          throw new IcsParseError(`unsupported RRULE FREQ: ${value}`);
        }
        rule.freq = value;
        sawFreq = true;
        break;
      case 'INTERVAL':
        rule.interval = parseInteger(key, value);
        if (rule.interval < 1) throw new IcsParseError(`INTERVAL must be positive in RRULE: ${value}`);
        break;
      case 'COUNT':
        rule.count = parseInteger(key, value);
        if (rule.count < 1) throw new IcsParseError(`COUNT must be positive in RRULE: ${value}`);
        break;
      case 'UNTIL': {
        const dateOnly = /^\d{8}$/.test(value);
        const parsed = parseDateTimeProperty({ name: 'UNTIL', params: dateOnly ? { VALUE: 'DATE' } : {}, value });
        // A date-only UNTIL includes that whole day.
        rule.until = new Date(parsed.date.getTime() + (dateOnly ? DAY_MS - 1 : 0));
        break;
      }
      case 'BYDAY':
        rule.byDay = value.split(',').map((item) => {
          const m = BYDAY_RE.exec(item);
          if (!m) throw new IcsParseError(`invalid BYDAY in RRULE: ${item}`);
          return { day: DAY_CODES.indexOf(m[2]), n: m[1] === undefined ? undefined : Number(m[1]) };
        });
        break;
      case 'BYMONTHDAY':
        rule.byMonthDay = parseIntegerList(key, value, -31, 31);
        break;
      case 'BYMONTH':
        rule.byMonth = parseIntegerList(key, value, 1, 12);
        break;
      case 'WKST': {
        const day = DAY_CODES.indexOf(value);
        if (day === -1) throw new IcsParseError(`invalid WKST in RRULE: ${value}`);
        rule.wkst = day;
        break;
      }
      default:
        throw new IcsParseError(`unsupported RRULE part: ${key}`);
    }
  }

  if (!sawFreq) throw new IcsParseError('RRULE has no FREQ');
  if (rule.freq === 'YEARLY' && rule.byDay.length > 0 && rule.byMonth.length === 0) {
    throw new IcsParseError('YEARLY RRULE with BYDAY requires BYMONTH');
  }
  return rule;
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function matchesMonthDay(rule: Rule, day: number, total: number): boolean {
  return rule.byMonthDay.some((n) => (n > 0 ? n === day : total + 1 + n === day));
}

// Days of one month (1-based) selected by BYMONTHDAY / BYDAY, falling back to
// `defaultDay` when the rule names neither. When both are present a day has to
// satisfy both.
function monthDays(rule: Rule, year: number, month0: number, defaultDay: number): number[] {
  const total = daysInMonth(year, month0);
  if (rule.byMonthDay.length === 0 && rule.byDay.length === 0) {
    return defaultDay <= total ? [defaultDay] : [];
  }

  const days: number[] = [];
  for (let day = 1; day <= total; day++) {
    if (rule.byMonthDay.length > 0 && !matchesMonthDay(rule, day, total)) continue;
    if (rule.byDay.length > 0) {
      const dow = new Date(Date.UTC(year, month0, day)).getUTCDay();
      const fromStart = Math.floor((day - 1) / 7) + 1;
      const fromEnd = -(Math.floor((total - day) / 7) + 1);
      const hit = rule.byDay.some((spec) => spec.day === dow && (spec.n === undefined || spec.n === fromStart || spec.n === fromEnd));
      if (!hit) continue;
    }
    days.push(day);
  }
  return days;
}

// Expands `rrule` against `start`, returning occurrence instants in order
// (the first is the one at or after `start` that matches the rule). The
// expansion runs on wall-clock fields and converts each result back to an
// instant, so a 9:00 New York event stays at 9:00 across a DST change rather
// than drifting by an hour. `limit` caps the result for rules with neither
// COUNT nor UNTIL.
export function expandRecurrence(start: IcsDateTime, rrule: string, limit = 1000): Date[] {
  const rule = parseRule(rrule);
  const maxResults = Math.min(rule.count ?? Infinity, limit);

  const wall = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/.exec(start.raw);
  if (!wall) throw new IcsParseError(`invalid start value: ${start.raw}`);
  const [startYear, startMonth0, startDay] = [Number(wall[1]), Number(wall[2]) - 1, Number(wall[3])];
  const [hour, minute, second] = [Number(wall[4] ?? 0), Number(wall[5] ?? 0), Number(wall[6] ?? 0)];
  const startDayMs = Date.UTC(startYear, startMonth0, startDay);
  const startDow = new Date(startDayMs).getUTCDay();

  const toInstant = (dayMs: number): Date => {
    if (start.isDate) return new Date(dayMs);
    const d = new Date(dayMs);
    const [y, mo, day] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
    if (start.isFloating) return new Date(y, mo, day, hour, minute, second);
    if (start.tzid) return zonedTimeToUtc(y, mo + 1, day, hour, minute, second, start.tzid);
    return new Date(Date.UTC(y, mo, day, hour, minute, second));
  };

  const inSelectedMonth = (dayMs: number): boolean =>
    rule.byMonth.length === 0 || rule.byMonth.includes(new Date(dayMs).getUTCMonth() + 1);

  const periodDays = (k: number): number[] => {
    switch (rule.freq) {
      case 'DAILY': {
        const dayMs = startDayMs + k * rule.interval * DAY_MS;
        const d = new Date(dayMs);
        if (!inSelectedMonth(dayMs)) return [];
        if (rule.byMonthDay.length > 0 && !matchesMonthDay(rule, d.getUTCDate(), daysInMonth(d.getUTCFullYear(), d.getUTCMonth()))) {
          return [];
        }
        if (rule.byDay.length > 0 && !rule.byDay.some((spec) => spec.day === d.getUTCDay())) return [];
        return [dayMs];
      }
      case 'WEEKLY': {
        const weekStart = startDayMs - ((startDow - rule.wkst + 7) % 7) * DAY_MS + k * rule.interval * 7 * DAY_MS;
        const weekdays = rule.byDay.length > 0 ? [...new Set(rule.byDay.map((spec) => spec.day))] : [startDow];
        return weekdays
          .map((dow) => weekStart + ((dow - rule.wkst + 7) % 7) * DAY_MS)
          .sort((a, b) => a - b)
          .filter(inSelectedMonth);
      }
      case 'MONTHLY': {
        const index = startYear * 12 + startMonth0 + k * rule.interval;
        const year = Math.floor(index / 12);
        const month0 = index % 12;
        if (rule.byMonth.length > 0 && !rule.byMonth.includes(month0 + 1)) return [];
        return monthDays(rule, year, month0, startDay).map((day) => Date.UTC(year, month0, day));
      }
      case 'YEARLY': {
        const year = startYear + k * rule.interval;
        const months = rule.byMonth.length > 0 ? [...rule.byMonth].sort((a, b) => a - b) : [startMonth0 + 1];
        return months.flatMap((month) => monthDays(rule, year, month - 1, startDay).map((day) => Date.UTC(year, month - 1, day)));
      }
    }
  };

  const out: Date[] = [];
  for (let k = 0; k < MAX_PERIODS; k++) {
    for (const dayMs of periodDays(k)) {
      if (dayMs < startDayMs) continue;
      const instant = toInstant(dayMs);
      if (rule.until && instant.getTime() > rule.until.getTime()) return out;
      out.push(instant);
      if (out.length >= maxResults) return out;
    }
  }
  return out;
}

// Flattens every VEVENT in `calendar` into start instants, expanding those
// with an RRULE, sorted by start time. At most `limit` occurrences come from
// any single event.
export function listOccurrences(calendar: IcsComponent, limit = 1000): Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (const vevent of findComponents(calendar, 'VEVENT')) {
    const startProp = getProperty(vevent, 'DTSTART');
    if (!startProp) continue;
    const start = parseDateTimeProperty(startProp);
    const uid = getPropertyValue(vevent, 'UID');
    const summary = getPropertyValue(vevent, 'SUMMARY');
    const rrule = getPropertyValue(vevent, 'RRULE');
    const starts = rrule === undefined ? [start.date] : expandRecurrence(start, rrule, limit);
    for (const date of starts) {
      occurrences.push({ uid, summary: summary === undefined ? undefined : unescapeText(summary), start: date });
    }
  }
  return occurrences.sort((a, b) => a.start.getTime() - b.start.getTime());
}
