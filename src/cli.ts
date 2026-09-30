#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseIcs, listEvents, validateCalendar } from './ics.js';
import { listOccurrences } from './rrule.js';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

// No path, or "-", both mean "read the calendar from stdin" so this works
// as the tail end of a pipe (curl ... | ical-toolkit).
async function readInput(arg: string | undefined): Promise<string> {
  return !arg || arg === '-' ? readStdin() : readFileSync(arg, 'utf8');
}

async function runList(arg: string | undefined): Promise<void> {
  const text = await readInput(arg);
  let calendar;
  try {
    calendar = parseIcs(text);
  } catch (err) {
    console.error(`ical-toolkit: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(listEvents(calendar), null, 2));
}

async function runValidate(arg: string | undefined): Promise<void> {
  const text = await readInput(arg);
  let calendar;
  try {
    calendar = parseIcs(text);
  } catch (err) {
    console.error(`ical-toolkit: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const issues = validateCalendar(calendar);
  if (issues.length === 0) {
    console.log('OK: no issues found');
    return;
  }

  for (const issue of issues) {
    console.log(`${issue.severity.toUpperCase()}: ${issue.path}: ${issue.message}`);
  }
  if (issues.some((issue) => issue.severity === 'error')) {
    process.exitCode = 1;
  }
}

async function runExpand(args: string[]): Promise<void> {
  let limit = 50;
  let path: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') {
      limit = Number(args[++i]);
      if (!Number.isInteger(limit) || limit < 1) {
        console.error('ical-toolkit: --limit needs a positive integer');
        process.exitCode = 1;
        return;
      }
    } else {
      path = args[i];
    }
  }

  const text = await readInput(path);
  try {
    const occurrences = listOccurrences(parseIcs(text), limit);
    console.log(JSON.stringify(occurrences, null, 2));
  } catch (err) {
    console.error(`ical-toolkit: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [first, second] = process.argv.slice(2);

  if (first === 'expand') {
    await runExpand(process.argv.slice(3));
    return;
  }

  if (first === 'validate') {
    await runValidate(second);
    return;
  }

  await runList(first);
}

main().catch((err: Error) => {
  console.error(`ical-toolkit: ${err.message}`);
  process.exitCode = 1;
});
