#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseIcs, listEvents } from './ics.js';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const arg = process.argv[2];

  // No path, or "-", both mean "read the calendar from stdin" so this works
  // as the tail end of a pipe (curl ... | ical-toolkit).
  const text = !arg || arg === '-' ? await readStdin() : readFileSync(arg, 'utf8');

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

main().catch((err: Error) => {
  console.error(`ical-toolkit: ${err.message}`);
  process.exitCode = 1;
});
