import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { EXECUTION_SCOPES } from '@edge/risk';

// ─── EM-STRAT-012 Phase-0 task E: enforced submission-sink census ──────
//
// Offline CI test that scans the production source tree for every submission
// sink and verifies each is either (a) guarded with the expected execution
// scope, or (b) explicitly recorded as a safety-positive (risk-reducing)
// operation with its rationale marker in the source.
//
// EM-STRAT-012 Phase-0 R1 expansions:
//   - Scan boundary: ALL packages/**/src/** production source roots (was 6
//     selected roots). Test/build/generated/dist/node_modules directories
//     are excluded by the walkTsFiles filter.
//   - Sink coverage: direct transaction-producing methods AND HTTP
//     submission wrappers, including every PumpApi action route
//     (buy/sell/actions/jitoBundle/migrate/burn/wrapSol/transfer/
//     claimCashback/atomicTwoLegArb) plus the existing sinks.
//   - Synthetic-sink self-test: exercises the SAME scanForSinks() function
//     used by the production census (not just an individual regex match).
//   - Scope count reconciliation: EXECUTION_SCOPES.length is asserted to
//     match the documented expected count, so future scope additions must
//     update both the taxonomy and the test.
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
// caught by the actual scan logic.
//
// A NEW unreviewed sink fails this test in either of two ways:
//   1. It appears in a file not listed in CANONICAL_SINKS → "uninventoried
//      file" violation (caught by scanForSinks).
//   2. It appears in an inventoried file but changes the occurrence count →
//      "occurrence count drift" violation (caught by the per-file check).
// Either way the test fails and the sink must be added to the inventory
// with a guard or safety-positive rationale after review.

// ─── Scan boundary ──────────────────────────────────────────────────────
//
// Production source roots: every packages/**/src directory. We walk the
// packages/ directory and descend into each package's src/ tree. Excluded:
//   - dist/, node_modules/, .git/ (build artifacts + deps)
//   - test/, __tests__/ (test files, not production)
//   - *.d.ts (TypeScript declaration files)
//   - scripts-explore/ (exploratory scripts, not production code)
//   - contracts/ (Solidity, not TypeScript — handled separately)
//   - evidence/ (Python harness, not TypeScript)

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const PACKAGES_DIR = resolve(REPO_ROOT, 'packages');

// ─── Sink patterns ──────────────────────────────────────────────────────
//
// Two tiers:
//   SINK_PATTERNS (bare-name) — used for per-file inventory counts. Matches
//     both definitions (`async placeArbitrageOrder(`) and call sites
//     (`this.placeArbitrageOrder(`). Used on known inventory files only,
//     so false positives on generic names are not a concern.
//   GLOBAL_SCAN_PATTERNS (dot-prefixed) — used for the global uninventoried-
//     file scan. Matches call sites only (`x.method(`), not definitions
//     (`async method(`). This prevents the definition file itself from
//     being flagged and dramatically reduces false positives on generic
//     names like `buy`/`sell`/`transfer`/`burn`.

interface SinkPattern {
  name: string;
  /** Bare-name regex for per-file inventory counts. */
  inventoryRegex: RegExp;
  /** Dot-prefixed regex for global call-site scan. */
  globalRegex: RegExp;
}

function makeSinkPattern(name: string): SinkPattern {
  return {
    name,
    inventoryRegex: new RegExp(`${name}\\(`, 'g'),
    globalRegex: new RegExp(`\\.${name}\\(`, 'g'),
  };
}

const SINK_PATTERNS: SinkPattern[] = [
  // Unique-name sinks — bare-name is unambiguous.
  makeSinkPattern('sendTransaction'),
  makeSinkPattern('placeArbitrageOrder'),
  makeSinkPattern('createBot'),
  makeSinkPattern('startBot'),
  makeSinkPattern('stopBot'),
  makeSinkPattern('cancelArbitrageOrder'),
  makeSinkPattern('deleteBot'),
  makeSinkPattern('placeOrder'),
  makeSinkPattern('atomicTwoLegArb'),
  makeSinkPattern('jitoBundle'),
  makeSinkPattern('claimCashback'),
  makeSinkPattern('wrapSol'),
  makeSinkPattern('migrate'),
  // Generic-name sinks — bare-name in inventory (per-file), dot-prefixed in
  // global scan. The global scan's dot prefix prevents matching unrelated
  // `buy`/`sell`/`transfer`/`burn`/`actions` occurrences in non-PumpApi
  // files.
  makeSinkPattern('buy'),
  makeSinkPattern('sell'),
  makeSinkPattern('actions'),
  makeSinkPattern('burn'),
  makeSinkPattern('transfer'),
];

function getSinkPattern(name: string): SinkPattern {
  const p = SINK_PATTERNS.find(p => p.name === name);
  if (!p) throw new Error(`unknown sink pattern: ${name}`);
  return p;
}

// ─── Comment stripping ─────────────────────────────────────────────────

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
  // Clone the regex to avoid mutating lastIndex on the shared pattern.
  const local = new RegExp(regex.source, regex.flags);
  let n = 0;
  while (local.exec(content) !== null) n++;
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
//   'not-a-sink'      — the regex match is a FALSE POSITIVE: the method name
//                       collides with a trading-sink name but the call site
//                       is NOT a trading action (e.g. PnlDb.migrate is a
//                       SQLite schema migration, not PumpApi.migrate). The
//                       file carries a NOT-A-SINK rationale marker explaining
//                       why the match is not a trading sink.

interface CanonicalSink {
  file: string;
  sink: string;
  expectedCount: number;
  guardScope: string | null;
  guardMode: 'direct' | 'indirect' | 'safety-positive' | 'not-a-sink';
  rationale?: string;
}

const CANONICAL_SINKS: CanonicalSink[] = [
  // ── VooiClient — shared HTTP choke point (definitions; guards live here) ─
  { file: 'packages/vooi-client/src/index.ts', sink: 'placeArbitrageOrder', expectedCount: 1, guardScope: 'vooi:place-arbitrage-order', guardMode: 'direct', rationale: 'open intent guarded; intent:"close" branch requires BOTH legs reduceOnly===true (R1 close-intent validation) — the validated reduce-only exit is the documented risk-reducing exemption' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'createBot', expectedCount: 1, guardScope: 'vooi:create-bot', guardMode: 'direct' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'startBot', expectedCount: 1, guardScope: 'vooi:start-bot', guardMode: 'direct' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'stopBot', expectedCount: 1, guardScope: null, guardMode: 'safety-positive', rationale: 'SAFETY-POSITIVE: emergency stop must remain available without execution authorization' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'cancelArbitrageOrder', expectedCount: 1, guardScope: null, guardMode: 'safety-positive', rationale: 'SAFETY-POSITIVE: cancellation reduces exposure' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'deleteBot', expectedCount: 1, guardScope: null, guardMode: 'safety-positive', rationale: 'SAFETY-POSITIVE: cleanup of a stopped bot cannot open/increase exposure' },

  // ── VooiExecutor (strategy class) — executor-layer defense-in-depth ─────
  // Both placeArbitrageOrder calls route through the guarded client sink;
  // the open path additionally asserts vooi-executor:execute-arb locally.
  { file: 'packages/scanner/src/strategies/vooi-executor.ts', sink: 'placeArbitrageOrder', expectedCount: 2, guardScope: 'vooi-executor:execute-arb', guardMode: 'direct', rationale: 'call 1 (open) asserts the executor scope locally then the client sink re-checks vooi:place-arbitrage-order; call 2 (closeArb) passes intent:"close" with both legs reduceOnly:true — R1-validated risk-reducing exit, deliberately ungated at the executor layer (documented in closeArb docstring)' },

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

  // ── BackpackClient (dormant sink; guarded at the definition) ────────────
  { file: 'packages/backpack-client/src/index.ts', sink: 'placeOrder', expectedCount: 1, guardScope: 'backpack-client:place-order', guardMode: 'direct', rationale: 'reduceOnly:true orders classified risk-reducing and usable without authorization (validated at the sink, R1 pattern); all other orders require the scope' },

  // ── PumpApiClient — every transaction-producing action method (R1) ──────
  // Each method has its own narrow scope. atomicTwoLegArb calls this.post()
  // directly (NOT this.actions()) so neither guard bypasses the other.
  // claimCashback is SAFETY-POSITIVE (recovers owed cashback; cannot open
  // or increase exposure). getBalances/getTokenInfo are read-only and not
  // listed in the census (they don't produce transactions).
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'buy', expectedCount: 1, guardScope: 'pumpapi-client:buy', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'sell', expectedCount: 1, guardScope: 'pumpapi-client:sell', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'actions', expectedCount: 1, guardScope: 'pumpapi-client:actions', guardMode: 'direct', rationale: 'arbitrary action array — no reduce-only variant, whole method gated' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'jitoBundle', expectedCount: 1, guardScope: 'pumpapi-client:jito-bundle', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'migrate', expectedCount: 1, guardScope: 'pumpapi-client:migrate', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'burn', expectedCount: 1, guardScope: 'pumpapi-client:burn', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'wrapSol', expectedCount: 1, guardScope: 'pumpapi-client:wrap-sol', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'transfer', expectedCount: 1, guardScope: 'pumpapi-client:transfer', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'claimCashback', expectedCount: 1, guardScope: null, guardMode: 'safety-positive', rationale: 'SAFETY-POSITIVE: recovers owed cashback into the wallet; cannot open or increase exposure (see JSDoc rationale)' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'atomicTwoLegArb', expectedCount: 1, guardScope: 'pumpapi-client:atomic-two-leg-arb', guardMode: 'direct', rationale: 'calls this.post() directly (NOT this.actions()) so the actions() guard is not bypassed and atomicTwoLegArb\'s own guard is sufficient' },

  // ── False-positive regex matches (NOT-A-SINK) ───────────────────────────
  // These entries document regex collisions where a non-trading method name
  // matches a sink pattern. The file carries a NOT-A-SINK marker explaining
  // why the match is not a trading action. Without these entries the global
  // scan would flag them as uninventoried sinks.
  { file: 'packages/pnl/src/index.ts', sink: 'migrate', expectedCount: 2, guardScope: null, guardMode: 'not-a-sink', rationale: 'NOT-A-SINK: PnlDb.migrate() is a SQLite schema migration (CREATE TABLE / CREATE INDEX DDL), not a trading action. The regex matches because PumpApiClient also has a migrate() method that submits a Solana transaction; this PnlDb method is a database migration, not a trading sink. Count=2: the constructor call site (this.migrate()) + the private method definition.' },
];

// ─── File walking ──────────────────────────────────────────────────────

/** All production .ts files under every packages/<pkg>/src/ tree. Excludes dist, node_modules, test dirs. */
function walkProductionTsFiles(): string[] {
  const acc: string[] = [];
  if (!existsSync(PACKAGES_DIR)) return acc;
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const pkgSrc = join(PACKAGES_DIR, pkg, 'src');
    if (!existsSync(pkgSrc)) continue;
    walkTsDir(pkgSrc, acc);
  }
  return acc;
}

function walkTsDir(dir: string, acc: string[]): void {
  for (const e of readdirSync(dir)) {
    // Skip excluded directories.
    if (e === 'node_modules' || e === 'dist' || e === '.git' || e === '__tests__') continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip test directories.
      if (e === 'test') continue;
      walkTsDir(full, acc);
    } else if (e.endsWith('.ts') && !e.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
}

function toRepoRel(absolute: string): string {
  return relative(REPO_ROOT, absolute).replace(/\\/g, '/');
}

// ─── Reusable scan logic (used by production census + synthetic-sink test) ─

export interface SinkViolation {
  file: string;
  sinkName: string;
  count: number;
  reason: 'uninventoried-file' | 'uninventoried-sink-in-known-file';
}

/**
 * Scan a set of directories for sink occurrences in files NOT covered by the
 * canonical inventory. Returns one violation per uninventoried sink.
 *
 * This function is the SINGLE source of truth for the uninventoried-sink
 * check. Both the production census test and the synthetic-sink self-test
 * call it — so a regression in scan logic is caught by both.
 *
 * `fileContents` is a map of repo-relative path → stripped file content.
 * Callers can pass pre-read contents (production census) or synthetic
 * contents (self-test).
 */
export function scanForUninventoriedSinks(
  fileContents: Map<string, string>,
  inventory: CanonicalSink[] = CANONICAL_SINKS,
): SinkViolation[] {
  // Build a map: file → set of sinks inventoried for that file.
  const known = new Map<string, Set<string>>();
  for (const entry of inventory) {
    if (!known.has(entry.file)) known.set(entry.file, new Set());
    known.get(entry.file)!.add(entry.sink);
  }

  const violations: SinkViolation[] = [];
  for (const [relPath, strippedContent] of fileContents) {
    const inventoriedSinks = known.get(relPath);
    for (const pattern of SINK_PATTERNS) {
      // Use the dot-prefixed global pattern for the uninventoried-file scan
      // so definitions (`async methodName(`) are not flagged — only call
      // sites (`x.methodName(`).
      const count = countOccurrences(strippedContent, pattern.globalRegex);
      if (count === 0) continue;
      if (!inventoriedSinks) {
        violations.push({
          file: relPath,
          sinkName: pattern.name,
          count,
          reason: 'uninventoried-file',
        });
      } else if (!inventoriedSinks.has(pattern.name)) {
        violations.push({
          file: relPath,
          sinkName: pattern.name,
          count,
          reason: 'uninventoried-sink-in-known-file',
        });
      }
    }
  }
  return violations;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('EM-STRAT-012 submission-sink census (task E) — R1 expansion', () => {

  // ── Scope-count reconciliation ──────────────────────────────────────────
  //
  // The Phase-0 worklog claimed "17 ExecutionScope values" but the actual
  // taxonomy had 16. R1 adds 8 new PumpApi scopes (buy/sell/actions/
  // jito-bundle/migrate/burn/wrap-sol/transfer) bringing the total to 24.
  // This test pins the count so future additions must update both the
  // taxonomy AND this assertion.

  it('EXECUTION_SCOPES length matches the documented R1 count (reconciliation)', () => {
    // R1 additions: 8 new PumpApi scopes (buy, sell, actions, jito-bundle,
    // migrate, burn, wrap-sol, transfer). The pre-R1 taxonomy had 16 scopes
    // (not 17 as the worklog claimed — the worklog was off by one). After
    // R1: 16 + 8 = 24.
    expect(EXECUTION_SCOPES.length).toBe(24);
  });

  it('EXECUTION_SCOPES contains all 8 new R1 PumpApi action scopes', () => {
    for (const s of [
      'pumpapi-client:buy',
      'pumpapi-client:sell',
      'pumpapi-client:actions',
      'pumpapi-client:jito-bundle',
      'pumpapi-client:migrate',
      'pumpapi-client:burn',
      'pumpapi-client:wrap-sol',
      'pumpapi-client:transfer',
    ]) {
      expect(EXECUTION_SCOPES).toContain(s);
    }
  });

  // ── Per-file inventory: exact occurrence counts ─────────────────────────

  it('every canonical sink appears in its file with the exact expected occurrence count (comments stripped)', () => {
    const problems: string[] = [];
    for (const entry of CANONICAL_SINKS) {
      const path = resolve(REPO_ROOT, entry.file);
      if (!existsSync(path)) {
        problems.push(`${entry.file}: FILE MISSING (moved or deleted without inventory update)`);
        continue;
      }
      const content = stripComments(readFileSync(path, 'utf8'));
      const pattern = getSinkPattern(entry.sink);
      const count = countOccurrences(content, pattern.inventoryRegex);
      if (count !== entry.expectedCount) {
        problems.push(
          `${entry.file}: sink "${entry.sink}" occurrence count ${count} != expected ${entry.expectedCount}` +
          ` — a new call site was added or an old one removed without updating the inventory`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  // ── Direct-guard verification ───────────────────────────────────────────

  it('every direct-guard sink file contains its assertExecutionAuthorized call', () => {
    const problems: string[] = [];
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardMode !== 'direct') continue;
      const content = readFileSync(resolve(REPO_ROOT, entry.file), 'utf8');
      if (!content.includes(`assertExecutionAuthorized('${entry.guardScope}')`)) {
        problems.push(`${entry.file}: expected guard assertExecutionAuthorized('${entry.guardScope}') not found — sink lost its guard`);
      }
    }
    expect(problems).toEqual([]);
  });

  // ── Indirect-guard chain verification ───────────────────────────────────

  it('every indirect sink routes to a sink definition that is direct-guarded in its own file', () => {
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

  // ── Safety-positive marker verification ─────────────────────────────────

  it('every safety-positive sink file contains its documented rationale marker', () => {
    const problems: string[] = [];
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardMode !== 'safety-positive') continue;
      const content = readFileSync(resolve(REPO_ROOT, entry.file), 'utf8');
      if (!content.includes('SAFETY-POSITIVE')) {
        problems.push(`${entry.file}: safety-positive sink "${entry.sink}" lost its SAFETY-POSITIVE rationale marker`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every not-a-sink entry file contains its NOT-A-SINK rationale marker', () => {
    // False-positive regex matches (e.g. PnlDb.migrate vs PumpApi.migrate)
    // must carry a NOT-A-SINK marker in the source explaining why the match
    // is not a trading sink. Without this marker the entry would be a silent
    // allow-list entry.
    const problems: string[] = [];
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardMode !== 'not-a-sink') continue;
      const content = readFileSync(resolve(REPO_ROOT, entry.file), 'utf8');
      if (!content.includes('NOT-A-SINK')) {
        problems.push(`${entry.file}: not-a-sink entry for "${entry.sink}" lost its NOT-A-SINK rationale marker`);
      }
    }
    expect(problems).toEqual([]);
  });

  // ── Global uninventoried-sink scan (R1: covers ALL packages/**/src) ─────

  it('no sink pattern appears as a CALL SITE in any production file outside the canonical inventory', () => {
    // Walk ALL packages/**/src/** production files.
    const allFiles = walkProductionTsFiles();
    expect(allFiles.length).toBeGreaterThan(0);

    // Read + strip comments for each file.
    const fileContents = new Map<string, string>();
    for (const f of allFiles) {
      const rel = toRepoRel(f);
      fileContents.set(rel, stripComments(readFileSync(f, 'utf8')));
    }

    const violations = scanForUninventoriedSinks(fileContents);
    if (violations.length > 0) {
      const msg = violations.map(v =>
        `${v.file}: ${v.reason} — sink "${v.sinkName}" × ${v.count} (add to CANONICAL_SINKS with a guard or safety-positive rationale after review)`,
      ).join('\n');
      throw new Error(`Uninventoried sink call sites found:\n${msg}`);
    }
    expect(violations).toEqual([]);
  });

  // ── Guard-scope taxonomy verification ───────────────────────────────────

  it('all guard scopes referenced by the inventory exist in the EXECUTION_SCOPES taxonomy', () => {
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardScope === null) continue;
      expect(EXECUTION_SCOPES).toContain(entry.guardScope as any);
    }
  });

  // ── Synthetic-sink self-test (R1: exercises the ACTUAL scan logic) ──────

  it('scanForUninventoriedSinks catches an injected synthetic unknown sink (self-test)', () => {
    // Create a temp directory with a synthetic .ts file containing a sink
    // call site that is NOT in the canonical inventory. Run the ACTUAL
    // scanForUninventoriedSinks function on it and verify the sink is
    // flagged. This proves the census logic itself catches new sinks —
    // not just that an individual regex matches a string.
    const tmpDir = resolve(__dirname, 'census-fixture-tmp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'synthetic-sink.ts');
    writeFileSync(
      tmpFile,
      'export async function evil() {\n' +
      '  await client.placeArbitrageOrder(req);\n' +
      '  await pumpApi.buy(req);\n' +
      '  await pumpApi.transfer(mint, to, amt);\n' +
      '}\n',
    );

    try {
      const content = stripComments(readFileSync(tmpFile, 'utf8'));
      // Build a fileContents map keyed by a fake repo-relative path that is
      // NOT in the canonical inventory.
      const fileContents = new Map<string, string>();
      fileContents.set('packages/synthetic/src/synthetic-sink.ts', content);

      const violations = scanForUninventoriedSinks(fileContents);

      // The synthetic file is not in the inventory, so EVERY sink call site
      // in it must be flagged as an uninventoried-file violation.
      const flaggedSinks = new Set(violations.map(v => v.sinkName));
      expect(flaggedSinks.has('placeArbitrageOrder')).toBe(true);
      expect(flaggedSinks.has('buy')).toBe(true);
      expect(flaggedSinks.has('transfer')).toBe(true);

      // Every violation must be classified as 'uninventoried-file'.
      for (const v of violations) {
        expect(v.reason).toBe('uninventoried-file');
        expect(v.count).toBeGreaterThan(0);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    expect(statSync(tmpDir, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('scanForUninventoriedSinks flags a known file with an uninventoried NEW sink type', () => {
    // A file that IS in the inventory (for sink A) introduces a NEW sink B
    // that is not inventoried for that file. The scan must flag sink B as
    // 'uninventoried-sink-in-known-file'.
    const fileContents = new Map<string, string>();
    // packages/vooi-client/src/index.ts is in the inventory for placeArbitrageOrder,
    // createBot, startBot, stopBot, cancelArbitrageOrder, deleteBot — but NOT for `buy`.
    fileContents.set(
      'packages/vooi-client/src/index.ts',
      'export async function evil() { await this.buy(req); }\n',
    );
    const violations = scanForUninventoriedSinks(fileContents);
    const buyViolation = violations.find(v => v.sinkName === 'buy');
    expect(buyViolation).toBeDefined();
    expect(buyViolation!.reason).toBe('uninventoried-sink-in-known-file');
  });

  it('scanForUninventoriedSinks does NOT flag a definition (no dot prefix) in an uninventoried file', () => {
    // A file that defines `async buy(` (definition, no dot prefix) but does
    // not call it should NOT be flagged — the global scan uses dot-prefixed
    // patterns to match call sites only, not definitions.
    const fileContents = new Map<string, string>();
    fileContents.set(
      'packages/synthetic/src/defs-only.ts',
      'export class Foo {\n  async buy(req: unknown): Promise<void> {}\n}\n',
    );
    const violations = scanForUninventoriedSinks(fileContents);
    expect(violations).toEqual([]);
  });
});
