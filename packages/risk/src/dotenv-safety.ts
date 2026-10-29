/**
 * `.env` loader safety helpers — Phase-0 containment (EM-STRAT-012 R1).
 *
 * Problem: a `.env` file is a convenient place to put long-lived
 * configuration, but it MUST NOT carry the execution-authorization
 * descriptor. If `EDGE_EXECUTION_AUTH` could be loaded from `.env`, then any
 * committed `.env` (or a stale `.env` left in a developer's checkout) could
 * silently arm the fail-closed execution guard — turning a tracked-file
 * accident into an unintended live execution.
 *
 * Contract: the authorization descriptor must be supplied explicitly through
 * the process environment (e.g. `EDGE_EXECUTION_AUTH='...' npx tsx ...`), not
 * persisted in `.env`. Every `.env` loader in this repository must exclude
 * `EDGE_EXECUTION_AUTH` from the keys it copies into `process.env`.
 *
 * This module provides two helpers:
 *   - `parseDotEnvContents(content)` — pure parser that returns a key→value
 *     record, EXCLUDING `EDGE_EXECUTION_AUTH`. Tested directly with in-memory
 *     fixtures; no file I/O.
 *   - `loadDotEnvIntoProcessEnv(envPath)` — reads `.env` from disk, calls the
 *     pure parser, and merges the result into `process.env` (without
 *     overwriting keys that are already present). Used by entrypoint
 *     scripts; the path is injectable so tests can point it at a temp file.
 *
 * These helpers are an accident-prevention measure, not cryptographic proof
 * of Principal identity. They ensure a tracked `.env` cannot accidentally
 * enable live execution — but they do not authenticate the operator.
 */

import { readFileSync } from 'node:fs';
import { EXECUTION_AUTH_ENV_VAR } from './execution-guard.js';

/**
 * Keys that `.env` loaders must NEVER copy into `process.env`.
 *
 * `EDGE_EXECUTION_AUTH` is the execution-authorization descriptor. It must
 * be supplied through the parent-process environment, not persisted in any
 * tracked file. If a `.env` file happens to contain this key (e.g. an
 * operator accidentally pasted it there), the loader silently skips it.
 */
export const DOTENV_EXCLUDED_KEYS: ReadonlySet<string> = new Set<string>([
  EXECUTION_AUTH_ENV_VAR,
]);

/**
 * Parse the textual contents of a `.env` file into a key→value record,
 * EXCLUDING any key listed in `DOTENV_EXCLUDED_KEYS`.
 *
 * Rules:
 *   - Lines that do not match `^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$` are
 *     skipped (comments, blanks, malformed entries).
 *   - Surrounding single or double quotes on the value are stripped.
 *   - Keys in `DOTENV_EXCLUDED_KEYS` (currently `EDGE_EXECUTION_AUTH`) are
 *     omitted from the returned record — the caller therefore cannot arm
 *     the execution guard from a `.env` file via this helper.
 *
 * This function is pure (no file I/O, no `process.env` mutation) so it can
 * be tested deterministically with in-memory fixtures.
 */
export function parseDotEnvContents(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (DOTENV_EXCLUDED_KEYS.has(k)) continue;
    out[k] = v.replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Read `.env` from `envPath`, parse it with `parseDotEnvContents`, and merge
 * the result into `process.env`. Existing `process.env` keys are NOT
 * overwritten (so explicit parent-process settings win over `.env`).
 *
 * `EDGE_EXECUTION_AUTH` is excluded by the parser, so this function cannot
 * arm the execution guard from a `.env` file.
 *
 * Errors (file missing, unreadable) are swallowed — `.env` is optional.
 */
export function loadDotEnvIntoProcessEnv(envPath: string): void {
  let content: string;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return; // .env not present — no-op
  }
  const parsed = parseDotEnvContents(content);
  for (const [k, v] of Object.entries(parsed)) {
    if (!process.env[k]) process.env[k] = v;
  }
}
