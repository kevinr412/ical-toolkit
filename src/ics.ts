// Minimal RFC 5545 parser: enough structure to read VEVENTs out of real-world
// .ics files without pulling in a dependency for what is, at its core, a
// line-oriented text format with one annoying wrinkle (folded lines).

export class IcsParseError extends Error {}

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsComponent {
  name: string;
  properties: IcsProperty[];
  components: IcsComponent[];
}

// A parsed DTSTART/DTEND value. `date` is always a real instant in time
// (UTC internally, however you choose to display it). `isDate` marks a
// VALUE=DATE property (whole-day, no time-of-day component). `isFloating`
// marks a time with no UTC suffix and no resolvable TZID, meaning the ICS
// spec leaves its meaning up to the consumer.
export interface IcsDateTime {
  raw: string;
  date: Date;
  isDate: boolean;
  isFloating: boolean;
  tzid?: string;
}

export interface CalendarEvent {
  uid?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: IcsDateTime;
  end?: IcsDateTime;
}

// Lines can be split across multiple physical lines: a continuation line
// starts with a single space or tab, which must be stripped before the value
// is usable. This has to run before anything else touches the text.
function unfoldLines(text: string): string[] {
  const rawLines = text.split(/\r\n|\r|\n/);
  const lines: string[] = [];
  for (const raw of rawLines) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
    } else if (raw.length > 0) {
      lines.push(raw);
    }
  }
  return lines;
}

// Splits on `delim` but ignores delimiters that fall inside a "quoted"
// span, since parameter values (e.g. TZID) are allowed to contain them.
function splitRespectingQuotes(str: string, delim: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of str) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === delim && !inQuotes) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function splitPropertyLine(line: string): { head: string; value: string } {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      return { head: line.slice(0, i), value: line.slice(i + 1) };
    }
  }
  throw new IcsParseError(`property line has no value: ${line}`);
}

function parseParams(paramParts: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    let value = part.slice(eq + 1);
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    params[key] = value;
  }
  return params;
}

// Undoes TEXT-value escaping (RFC 5545 section 3.3.11): backslash before
// n/N, comma, semicolon or another backslash. Done in one pass so a literal
// "\\n" (backslash then n) can't be mistaken for an already-decoded newline.
export function unescapeText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === 'n' || next === 'N') {
        out += '\n';
        i++;
        continue;
      }
      if (next === ',' || next === ';' || next === '\\') {
        out += next;
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

export function parseIcs(text: string): IcsComponent {
  const lines = unfoldLines(text);
  const stack: IcsComponent[] = [];
  let root: IcsComponent | undefined;

  for (const line of lines) {
    const { head, value } = splitPropertyLine(line);
    const headParts = splitRespectingQuotes(head, ';');
    const name = headParts[0].toUpperCase();

    if (name === 'BEGIN') {
      const component: IcsComponent = { name: value.toUpperCase(), properties: [], components: [] };
      if (stack.length > 0) stack[stack.length - 1].components.push(component);
      stack.push(component);
      continue;
    }

    if (name === 'END') {
      const finished = stack.pop();
      if (!finished) throw new IcsParseError(`unmatched END:${value}`);
      if (finished.name !== value.toUpperCase()) {
        throw new IcsParseError(`mismatched END:${value}, expected END:${finished.name}`);
      }
      if (stack.length === 0) root = finished;
      continue;
    }

    const current = stack[stack.length - 1];
    if (!current) throw new IcsParseError(`property outside of any component: ${line}`);
    current.properties.push({ name, params: parseParams(headParts.slice(1)), value });
  }

  if (stack.length > 0) {
    throw new IcsParseError(`unterminated component: ${stack[stack.length - 1].name}`);
  }
  if (!root) throw new IcsParseError('no VCALENDAR component found');
  return root;
}

export function getProperty(component: IcsComponent, name: string): IcsProperty | undefined {
  const target = name.toUpperCase();
  return component.properties.find((p) => p.name === target);
}

export function getPropertyValue(component: IcsComponent, name: string): string | undefined {
  return getProperty(component, name)?.value;
}

export function findComponents(component: IcsComponent, name: string): IcsComponent[] {
  const target = name.toUpperCase();
  return component.components.filter((c) => c.name === target);
}

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;

// Whether the JS runtime's ICU data recognizes `tzid` as a timezone. A
// calendar's TZID doesn't have to be an IANA name (it can be an arbitrary
// string matching a VTIMEZONE block defined in the same file), so this can
// legitimately fail for well-formed input.
function isSupportedTimeZone(tzid: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

// Offset (ms) of `timeZone` from UTC at the instant `date`, computed by
// asking Intl how it would render that instant's wall-clock time in that
// zone and diffing against the same instant read as UTC.
function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - date.getTime();
}

// Converts wall-clock components in `timeZone` to the UTC instant they
// represent. Offset lookups are instant-dependent (DST), so the first guess
// (treating the wall clock as if it were already UTC) can be off by the
// zone's offset; one correction pass resolves that for all but clock times
// that fall inside a DST fall-back overlap.
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = timeZoneOffsetMs(new Date(naiveUtc), timeZone);
  const corrected = naiveUtc - offset;
  const offsetAtCorrected = timeZoneOffsetMs(new Date(corrected), timeZone);
  return new Date(naiveUtc - offsetAtCorrected);
}

export function parseDateTimeProperty(prop: IcsProperty): IcsDateTime {
  const raw = prop.value;
  const tzid = prop.params.TZID;

  if (prop.params.VALUE === 'DATE') {
    const m = DATE_RE.exec(raw);
    if (!m) throw new IcsParseError(`invalid DATE value: ${raw}`);
    const [, y, mo, d] = m;
    return {
      raw,
      isDate: true,
      isFloating: false,
      date: new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))),
    };
  }

  const m = DATE_TIME_RE.exec(raw);
  if (!m) throw new IcsParseError(`invalid DATE-TIME value: ${raw}`);
  const [, y, mo, d, h, mi, s, utcSuffix] = m;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number);

  if (utcSuffix) {
    return {
      raw,
      isDate: false,
      isFloating: false,
      date: new Date(Date.UTC(year, month - 1, day, hour, minute, second)),
    };
  }

  if (tzid && isSupportedTimeZone(tzid)) {
    return {
      raw,
      isDate: false,
      isFloating: false,
      tzid,
      date: zonedTimeToUtc(year, month, day, hour, minute, second, tzid),
    };
  }

  // Floating local time (RFC 5545 3.3.5): no UTC marker and no resolvable
  // zone, so there's no correct absolute instant. Interpreting it in the
  // system's own timezone is a judgment call, not a spec requirement.
  return { raw, isDate: false, isFloating: true, tzid, date: new Date(year, month - 1, day, hour, minute, second) };
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  path: string;
}

// Lint-style checks beyond what parseIcs enforces structurally. parseIcs only
// rejects things that make the component tree itself unrepresentable
// (unbalanced BEGIN/END, a property with no value); this catches calendars
// that parse fine but are missing pieces RFC 5545 requires or that a
// downstream consumer would trip over (e.g. an event ending before it starts).
export function validateCalendar(calendar: IcsComponent): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (calendar.name !== 'VCALENDAR') {
    issues.push({ severity: 'error', message: `root component is ${calendar.name}, expected VCALENDAR`, path: calendar.name });
  }
  if (!getProperty(calendar, 'VERSION')) {
    issues.push({ severity: 'error', message: 'missing required VERSION property', path: 'VCALENDAR' });
  }
  if (!getProperty(calendar, 'PRODID')) {
    issues.push({ severity: 'error', message: 'missing required PRODID property', path: 'VCALENDAR' });
  }

  const seenUids = new Set<string>();
  findComponents(calendar, 'VEVENT').forEach((vevent, index) => {
    const path = `VCALENDAR > VEVENT[${index}]`;

    const uid = getPropertyValue(vevent, 'UID');
    if (!uid) {
      issues.push({ severity: 'error', message: 'missing required UID property', path });
    } else if (seenUids.has(uid)) {
      // Legitimate when paired with RECURRENCE-ID (an override of one
      // instance of a recurring event), which this library doesn't parse
      // yet, so flag it rather than reject it outright.
      issues.push({ severity: 'warning', message: `duplicate UID "${uid}" (only expected alongside RECURRENCE-ID)`, path });
    } else {
      seenUids.add(uid);
    }

    if (!getProperty(vevent, 'DTSTAMP')) {
      issues.push({ severity: 'error', message: 'missing required DTSTAMP property', path });
    }

    if (!getPropertyValue(vevent, 'SUMMARY')) {
      issues.push({ severity: 'warning', message: 'missing SUMMARY property', path });
    }

    const dtstartProp = getProperty(vevent, 'DTSTART');
    let start: IcsDateTime | undefined;
    if (!dtstartProp) {
      issues.push({ severity: 'error', message: 'missing required DTSTART property', path });
    } else {
      try {
        start = parseDateTimeProperty(dtstartProp);
      } catch (err) {
        issues.push({ severity: 'error', message: `invalid DTSTART value: ${(err as Error).message}`, path });
      }
    }

    const dtendProp = getProperty(vevent, 'DTEND');
    let end: IcsDateTime | undefined;
    if (dtendProp) {
      try {
        end = parseDateTimeProperty(dtendProp);
      } catch (err) {
        issues.push({ severity: 'error', message: `invalid DTEND value: ${(err as Error).message}`, path });
      }
    }

    if (start && end && end.date.getTime() < start.date.getTime()) {
      issues.push({ severity: 'error', message: 'DTEND is before DTSTART', path });
    }
  });

  return issues;
}

export function listEvents(calendar: IcsComponent): CalendarEvent[] {
  return findComponents(calendar, 'VEVENT').map((vevent) => {
    const text = (name: string): string | undefined => {
      const value = getPropertyValue(vevent, name);
      return value === undefined ? undefined : unescapeText(value);
    };
    const dateTime = (name: string): IcsDateTime | undefined => {
      const prop = getProperty(vevent, name);
      return prop === undefined ? undefined : parseDateTimeProperty(prop);
    };
    return {
      uid: text('UID'),
      summary: text('SUMMARY'),
      description: text('DESCRIPTION'),
      location: text('LOCATION'),
      start: dateTime('DTSTART'),
      end: dateTime('DTEND'),
    };
  });
}
