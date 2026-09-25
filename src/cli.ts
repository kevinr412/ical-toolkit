#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseIcs, listEvents, validateCalendar } from './ics.js';

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

async function main(): Promise<void> {
  const [first, second] = process.argv.slice(2);

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
