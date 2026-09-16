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

export interface CalendarEvent {
  uid?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
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

// DTSTART/DTEND are left as raw ICS date-time strings for now: turning them
// into real Date objects correctly means handling VALUE=DATE, floating times,
// and TZID lookups, which is more than this first pass covers.
export function listEvents(calendar: IcsComponent): CalendarEvent[] {
  return findComponents(calendar, 'VEVENT').map((vevent) => {
    const text = (name: string): string | undefined => {
      const value = getPropertyValue(vevent, name);
      return value === undefined ? undefined : unescapeText(value);
    };
    return {
      uid: text('UID'),
      summary: text('SUMMARY'),
      description: text('DESCRIPTION'),
      location: text('LOCATION'),
      start: getPropertyValue(vevent, 'DTSTART'),
      end: getPropertyValue(vevent, 'DTEND'),
    };
  });
}
