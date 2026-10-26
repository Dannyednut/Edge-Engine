/**
 * EM-STRAT-014-E1 — replay CLI (offline, deterministic).
 *
 * Usage:
 *   tsx src/cli/replay.ts --manifest <manifest.json> --raw <raw-dir>
 *
 * The raw dir must contain anchor.jsonl and one <poolAddress>.jsonl per
 * census pool. Output is the canonical report JSON on stdout (exactly one
 * trailing newline). Fail-closed conditions print a canonical JSON error
 * object and exit 1. The CLI performs NO network access and NO writes.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runReplay } from '../replay.js';

function fail(errors: string[]): never {
  process.stdout.write(JSON.stringify({ ok: false, errors }) + '\n');
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  let manifestPath: string | null = null;
  let rawDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest' && i + 1 < argv.length) manifestPath = argv[i + 1];
    else if (argv[i] === '--raw' && i + 1 < argv.length) rawDir = argv[i + 1];
  }
  if (manifestPath === null || rawDir === null) {
    fail(['cli:usage_error:required_--manifest_<path>_--raw_<dir>']);
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(readFileSync(manifestPath as string, 'utf8'));
  } catch (e) {
    fail([`cli:manifest_unreadable_or_invalid_json:${(e as Error).message}`]);
  }

  let files: string[];
  try {
    files = readdirSync(rawDir as string).filter(f => f.endsWith('.jsonl')).sort();
  } catch (e) {
    fail([`cli:raw_dir_unreadable:${(e as Error).message}`]);
  }

  const anchorFile = files.find(f => f === 'anchor.jsonl');
  if (anchorFile === undefined) fail(['cli:anchor_jsonl_missing_in_raw_dir']);

  const poolJsonls: Record<string, string> = {};
  for (const f of files) {
    if (f === 'anchor.jsonl') continue;
    const address = f.slice(0, -'.jsonl'.length);
    poolJsonls[address] = readFileSync(join(rawDir as string, f), 'utf8');
  }

  const anchorJsonl = readFileSync(join(rawDir as string, 'anchor.jsonl'), 'utf8');
  const result = runReplay(manifestRaw, { anchorJsonl, poolJsonls });
  if (!result.ok) {
    fail(result.errors);
  }
  process.stdout.write(result.reportJson + '\n');
}

main();
