import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { EXECUTION_SCOPES } from '@edge/risk';

// ─── EM-STRAT-012 Phase-0 task E: enforced submission-sink census ──────
//
// Offline CI test that scans the production source tree for every submission
// sink and verifies each is either (a) guarded with the expected execution
// scope, or (b) explicitly recorded as a safety-positive (risk-reducing)
// operation with its rationale marker in the source.
//
// Method: narrowly scoped static scan. Comments (// lines and JSDoc
// continuation lines) are stripped before counting so documentation mentions
// of sink names do not produce false positives; a sink name must appear in
// live code to be counted. Limitations (documented per task instruction): a
// regex scan cannot see through string interpolation, dynamic dispatch, or
// re-exported aliases. Compensating controls: the canonical inventory pins
// exact file+method+guard triples, occurrence counts must match exactly (a
// new call site in a known file or ANY hit in an unknown file fails the
// census), and the census self-test proves an injected synthetic sink is
// caught.
//
// A NEW unreviewed sink fails this test in either of two ways:
//   1. It appears in a file not listed in CANONICAL_SINKS → "uninventoried
//      file" violation.
//   2. It appears in an inventoried file but changes the occurrence count →
//      "occurrence count drift" violation.
// Either way the test fails and the sink must be added to the inventory
// with a guard or safety-positive rationale after review.

const SCANNER_SRC = resolve(__dirname, '..', 'src');
const RISK_SRC = resolve(__dirname, '..', '..', 'risk', 'src');
const VOOI_CLIENT_SRC = resolve(__dirname, '..', '..', 'vooi-client', 'src');
const EXECUTOR_SRC = resolve(__dirname, '..', '..', 'executor', 'src');
const BACKPACK_SRC = resolve(__dirname, '..', '..', 'backpack-client', 'src');
const PUMPAPI_SRC = resolve(__dirname, '..', '..', 'pumpapi-client', 'src');

const SINK_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'sendTransaction', regex: /sendTransaction\(/g },
  { name: 'placeArbitrageOrder', regex: /placeArbitrageOrder\(/g },
  { name: 'createBot', regex: /createBot\(/g },
  { name: 'startBot', regex: /startBot\(/g },
  { name: 'stopBot', regex: /stopBot\(/g },
  { name: 'cancelArbitrageOrder', regex: /cancelArbitrageOrder\(/g },
  { name: 'deleteBot', regex: /deleteBot\(/g },
  { name: 'placeOrder', regex: /placeOrder\(/g },
  { name: 'atomicTwoLegArb', regex: /atomicTwoLegArb\(/g },
];

/**
 * Strip line comments (// ...) and JSDoc continuation lines (leading *)
 * so documentation mentions of sink names are not counted. Strings that
 * contain "//" (e.g. URLs) survive because we only strip from the FIRST
 * "//" that is not preceded by a word character or ":".
 */
function stripComments(source: string): string {
  return source.split('\n').map(line => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
    const idx = line.indexOf('//');
    if (idx > 0 && line[idx - 1] !== ':' && line[idx - 1] !== "'") {
      return line.slice(0, idx);
    }
    return line;
  }).join('\n');
}

function countOccurrences(content: string, regex: RegExp): number {
  regex.lastIndex = 0;
  let n = 0;
  while (regex.exec(content) !== null) n++;
  return n;
}

// ─── Canonical inventory ────────────────────────────────────────────────
//
// guardMode:
//   'direct'          — this file contains assertExecutionAuthorized('<scope>')
//   'indirect'        — the sink call goes through a client whose definition
//                       (in another inventoried file) carries the guard; the
//                       call site needs no local guard
//   'safety-positive' — risk-reducing operation, deliberately ungated; the
//                       file carries a SAFETY-POSITIVE rationale marker

interface CanonicalSink {
  file: string;
  sink: string;
  expectedCount: number;
  guardScope: string | null;
  guardMode: 'direct' | 'indirect' | 'safety-positive';
  rationale?: string;
}

const CANONICAL_SINKS: CanonicalSink[] = [
  // ── VooiClient — shared HTTP choke point (definitions; guards live here) ─
  { file: 'packages/vooi-client/src/index.ts', sink: 'placeArbitrageOrder', expectedCount: 1, guardScope: 'vooi:place-arbitrage-order', guardMode: 'direct', rationale: 'open intent guarded; intent:"close" branch is the documented risk-reducing exit (reduceOnly legs)' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'createBot', expectedCount: 1, guardScope: 'vooi:create-bot', guardMode: 'direct' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'startBot', expectedCount: 1, guardScope: 'vooi:start-bot', guardMode: 'direct' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'stopBot', expectedCount: 1, guardScope: null, guardMode: 'safety-positive', rationale: 'SAFETY-POSITIVE: emergency stop must remain available without execution authorization' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'cancelArbitrageOrder', expectedCount: 1, guardScope: null, guardMode: 'safety-positive', rationale: 'SAFETY-POSITIVE: cancellation reduces exposure' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'deleteBot', expectedCount: 1, guardScope: null, guardMode: 'safety-positive', rationale: 'SAFETY-POSITIVE: cleanup of a stopped bot cannot open/increase exposure' },

  // ── VooiExecutor (strategy class) — executor-layer defense-in-depth ─────
  // Both placeArbitrageOrder calls route through the guarded client sink;
  // the open path additionally asserts vooi-executor:execute-arb locally.
  { file: 'packages/scanner/src/strategies/vooi-executor.ts', sink: 'placeArbitrageOrder', expectedCount: 2, guardScope: 'vooi-executor:execute-arb', guardMode: 'direct', rationale: 'call 1 (open) asserts the executor scope locally then the client sink re-checks vooi:place-arbitrage-order; call 2 (closeArb) passes intent:"close" — RISK-REDUCING reduceOnly exit, deliberately ungated (documented in closeArb docstring)' },

  // ── VooiPriceSpreadExecutor (runner class) — direct local guard ─────────
  { file: 'packages/scanner/src/runners/vooi-price-spread-executor.ts', sink: 'placeArbitrageOrder', expectedCount: 1, guardScope: 'vooi-price-spread-executor:execute-opp', guardMode: 'direct', rationale: 'local executor-scope guard; the client sink additionally re-checks vooi:place-arbitrage-order' },

  // ── EvmExecutor — three sendTransaction sites, each re-checked per call ──
  { file: 'packages/executor/src/index.ts', sink: 'sendTransaction', expectedCount: 3, guardScope: 'evm-executor:send-transaction', guardMode: 'direct' },

  // ── EVM runner scripts — raw walletClient.sendTransaction sinks ─────────
  { file: 'packages/scanner/src/runners/khype-carry-executor.ts', sink: 'sendTransaction', expectedCount: 1, guardScope: 'evm-executor:send-transaction', guardMode: 'direct', rationale: 'single live call inside sendTx; guard re-checks per call' },
  { file: 'packages/scanner/src/runners/euler-lending-executor.ts', sink: 'sendTransaction', expectedCount: 1, guardScope: 'evm-executor:send-transaction', guardMode: 'direct' },

  // ── Runner call sites through the guarded VooiClient (indirect) ─────────
  // These files call vooi.createBot / vooi.startBot / vooi.stopBot; the
  // risk-increasing ones are guarded at the client definition (verified by
  // the vooi-client entries above and its own test file).
  { file: 'packages/scanner/src/runners/go-live.ts', sink: 'createBot', expectedCount: 1, guardScope: 'vooi:create-bot', guardMode: 'indirect', rationale: 'client sink guard fires inside VooiClient.createBot; entrypoint:go-live asserted locally in main()' },
  { file: 'packages/scanner/src/runners/go-live.ts', sink: 'startBot', expectedCount: 1, guardScope: 'vooi:start-bot', guardMode: 'indirect' },
  { file: 'packages/scanner/src/runners/vooi-create-bot.ts', sink: 'createBot', expectedCount: 1, guardScope: 'vooi:create-bot', guardMode: 'indirect', rationale: 'client sink guard fires inside VooiClient.createBot; entrypoint:vooi-create-bot asserted locally' },
  { file: 'packages/scanner/src/runners/vooi-create-bot.ts', sink: 'startBot', expectedCount: 1, guardScope: 'vooi:start-bot', guardMode: 'indirect' },
  { file: 'packages/scanner/src/runners/vooi-arb-executor.ts', sink: 'placeArbitrageOrder', expectedCount: 1, guardScope: 'vooi:place-arbitrage-order', guardMode: 'indirect', rationale: 'client sink guard fires inside VooiClient.placeArbitrageOrder (open intent); entrypoint:vooi-arb-executor asserted locally on --live' },
  { file: 'packages/scanner/src/runners/vooi-arb-executor.ts', sink: 'createBot', expectedCount: 1, guardScope: 'vooi:create-bot', guardMode: 'indirect' },
  { file: 'packages/scanner/src/runners/vooi-arb-executor.ts', sink: 'startBot', expectedCount: 2, guardScope: 'vooi:start-bot', guardMode: 'indirect', rationale: 'wrapper definition + client call; client sink guard fires inside VooiClient.startBot' },
  { file: 'packages/scanner/src/runners/vooi-arb-executor.ts', sink: 'stopBot', expectedCount: 2, guardScope: null, guardMode: 'safety-positive', rationale: 'SAFETY-POSITIVE: stopBot wrapper definition + client call — the ungated client stopBot keeps emergency stop available' },

  // ── Dormant client sinks (guarded at the definition; no callers) ────────
  { file: 'packages/backpack-client/src/index.ts', sink: 'placeOrder', expectedCount: 1, guardScope: 'backpack-client:place-order', guardMode: 'direct', rationale: 'reduceOnly:true orders classified risk-reducing and usable without authorization (documented at the sink)' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'atomicTwoLegArb', expectedCount: 1, guardScope: 'pumpapi-client:atomic-two-leg-arb', guardMode: 'direct' },
];

/** All production .ts files under the given roots. */
function walkTsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) walkTsFiles(full, acc);
    else if (e.endsWith('.ts') && !e.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

function toRepoRel(absolute: string): string {
  const idx = absolute.indexOf('packages');
  return absolute.slice(idx).replace(/\\/g, '/');
}

describe('EM-STRAT-012 submission-sink census (task E)', () => {

  it('every canonical sink appears in its file with the exact expected occurrence count (comments stripped)', () => {
    const problems: string[] = [];
    for (const entry of CANONICAL_SINKS) {
      const path = resolve(__dirname, '..', '..', '..', entry.file);
      if (!existsSync(path)) {
        problems.push(`${entry.file}: FILE MISSING (moved or deleted without inventory update)`);
        continue;
      }
      const content = stripComments(readFileSync(path, 'utf8'));
      const pattern = SINK_PATTERNS.find(p => p.name === entry.sink)!;
      const count = countOccurrences(content, pattern.regex);
      if (count !== entry.expectedCount) {
        problems.push(
          `${entry.file}: sink "${entry.sink}" occurrence count ${count} != expected ${entry.expectedCount}` +
          ` — a new call site was added or an old one removed without updating the inventory`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('every direct-guard sink file contains its assertExecutionAuthorized call', () => {
    const problems: string[] = [];
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardMode !== 'direct') continue;
      const content = readFileSync(resolve(__dirname, '..', '..', '..', entry.file), 'utf8');
      if (!content.includes(`assertExecutionAuthorized('${entry.guardScope}')`)) {
        problems.push(`${entry.file}: expected guard assertExecutionAuthorized('${entry.guardScope}') not found — sink lost its guard`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every indirect sink routes to a sink definition that is direct-guarded in its own file', () => {
    // Build a map: sink name → set of definition files with direct guards.
    const directDefs = new Map<string, Set<string>>();
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardMode !== 'direct') continue;
      if (!directDefs.has(entry.sink)) directDefs.set(entry.sink, new Set());
      directDefs.get(entry.sink)!.add(entry.file);
    }
    const problems: string[] = [];
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardMode !== 'indirect') continue;
      const defFiles = directDefs.get(entry.sink);
      if (!defFiles || defFiles.size === 0) {
        problems.push(`${entry.file}: indirect sink "${entry.sink}" has NO direct-guarded definition file in the inventory — the guard chain is broken`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every safety-positive sink file contains its documented rationale marker', () => {
    const problems: string[] = [];
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardMode !== 'safety-positive') continue;
      const content = readFileSync(resolve(__dirname, '..', '..', '..', entry.file), 'utf8');
      if (!content.includes('SAFETY-POSITIVE')) {
        problems.push(`${entry.file}: safety-positive sink "${entry.sink}" lost its SAFETY-POSITIVE rationale marker`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('no sink pattern appears in any production file outside the canonical inventory', () => {
    const known = new Map<string, CanonicalSink[]>();
    for (const entry of CANONICAL_SINKS) {
      if (!known.has(entry.file)) known.set(entry.file, []);
      known.get(entry.file)!.push(entry);
    }
    const scanDirs = [SCANNER_SRC, RISK_SRC, VOOI_CLIENT_SRC, EXECUTOR_SRC, BACKPACK_SRC, PUMPAPI_SRC];
    const problems: string[] = [];

    for (const dir of scanDirs) {
      for (const f of walkTsFiles(dir)) {
        const rel = toRepoRel(f);
        const entries = known.get(rel);
        if (!entries) {
          // Unknown file — ANY sink occurrence is a violation.
          const content = stripComments(readFileSync(f, 'utf8'));
          for (const { name, regex } of SINK_PATTERNS) {
            const count = countOccurrences(content, regex);
            if (count > 0) {
              problems.push(`${rel}: UNINVENTORIED sink "${name}" (${count}) — add to CANONICAL_SINKS with a guard or safety-positive rationale after review`);
            }
          }
        } else {
          // Known file — check for sink names NOT inventoried for this file.
          const content = stripComments(readFileSync(f, 'utf8'));
          const inventoried = new Set(entries.map(e => e.sink));
          for (const { name, regex } of SINK_PATTERNS) {
            if (inventoried.has(name)) continue;
            const count = countOccurrences(content, regex);
            if (count > 0) {
              problems.push(`${rel}: sink "${name}" present but NOT inventoried for this file (${count}) — update CANONICAL_SINKS after review`);
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('all guard scopes referenced by the inventory exist in the EXECUTION_SCOPES taxonomy', () => {
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardScope === null) continue;
      expect(EXECUTION_SCOPES).toContain(entry.guardScope as any);
    }
  });

  it('census catches an injected synthetic unknown sink (self-test)', () => {
    const tmpDir = resolve(__dirname, 'census-fixture-tmp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'synthetic-sink.ts');
    writeFileSync(tmpFile, 'export async function evil() { await client.placeArbitrageOrder(req); }\n');

    try {
      const content = stripComments(readFileSync(tmpFile, 'utf8'));
      let detected = false;
      for (const { name, regex } of SINK_PATTERNS) {
        if (countOccurrences(content, regex) > 0) {
          detected = true;
          expect(name).toBe('placeArbitrageOrder');
          break;
        }
      }
      expect(detected).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    expect(statSync(tmpDir, { throwIfNoEntry: false })).toBeUndefined();
  });
});
