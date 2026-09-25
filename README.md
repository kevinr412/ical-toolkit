# ical-toolkit

A small TypeScript library and CLI for reading iCalendar (`.ics`) files.

The format looks simple until you actually parse one: lines get folded across
multiple physical lines with a leading space, property values are escaped
(`\n`, `\,`, `\;`), and parameters can carry quoted strings with their own
delimiters inside them. This library handles that plumbing and gives you back
a plain tree of components and properties, plus a convenience function for
pulling `VEVENT`s out of a calendar.

No dependencies. Standard library only.

## Install

Not published yet. Clone it and build locally:

```
npm install
npm run build
```

## CLI usage

Read from a file:

```
$ ical-toolkit calendar.ics
[
  {
    "uid": "abc123@example.com",
    "summary": "Team standup",
    "description": "Daily sync",
    "location": "Room 4",
    "start": {
      "raw": "20260918T090000",
      "isDate": false,
      "isFloating": false,
      "tzid": "America/New_York",
      "date": "2026-09-18T13:00:00.000Z"
    },
    "end": {
      "raw": "20260918T093000",
      "isDate": false,
      "isFloating": false,
      "tzid": "America/New_York",
      "date": "2026-09-18T13:30:00.000Z"
    }
  }
]
```

Or read from stdin, which is the point of piping calendars around instead of
saving them to disk first:

```
$ curl -s https://example.com/feed.ics | ical-toolkit
$ cat calendar.ics | ical-toolkit -
```

With no argument, or with `-` as the argument, the CLI reads from stdin.
Otherwise the argument is treated as a file path.

### validate

`validate` runs lint-style checks instead of printing events: required
properties that are missing (`VERSION`, `PRODID`, and per-event `UID`,
`DTSTAMP`, `DTSTART`), a `DTEND` that falls before its `DTSTART`, and a
few things that are only warnings rather than outright errors (a missing
`SUMMARY`, a `UID` reused across events without `RECURRENCE-ID`).

```
$ ical-toolkit validate calendar.ics
ERROR: VCALENDAR > VEVENT[1]: missing required DTSTAMP property
WARNING: VCALENDAR > VEVENT[2]: missing SUMMARY property
```

Takes the same file-path-or-stdin argument as the default command. Exits
non-zero if any issue is an error; warnings alone don't affect the exit code.

## Library usage

```ts
import { parseIcs, listEvents } from 'ical-toolkit';

const calendar = parseIcs(icsText);
const events = listEvents(calendar);

for (const event of events) {
  console.log(event.summary, event.start?.date.toISOString());
}
```

`parseIcs` returns the full component tree (`IcsComponent`), so you're not
limited to events — `calendar.components` includes every `BEGIN`/`END` block
in the file (`VTIMEZONE`, `VALARM`, and so on), each with its own
`properties` array of `{ name, params, value }`.

`DTSTART`/`DTEND` come back as an `IcsDateTime`: `{ raw, date, isDate, isFloating, tzid? }`.
`date` is always a real `Date` (UTC internally). `isDate` marks a whole-day
`VALUE=DATE` property. `isFloating` marks a time with no `Z` suffix and no
`TZID` that the runtime's `Intl` data recognizes — RFC 5545 leaves floating
times' meaning up to the consumer, and this library resolves them against
the system's local timezone.

`validateCalendar` runs the same checks the `validate` CLI command uses,
returning an array of `{ severity, message, path }` instead of printing them.

## Current limitations

- No recurrence (`RRULE`) expansion.
- No serialization back to `.ics` text — parsing only, for now.

## License

MIT
