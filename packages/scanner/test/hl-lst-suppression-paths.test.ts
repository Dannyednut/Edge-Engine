import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  main,
  ENTRYPOINT_SCOPE as KHYPE_SCOPE,
  KHYPE_CARRY_EXECUTION_STOPPED,
  KHYPE_CARRY_EXECUTION_SUPPRESSED,
} from '../src/runners/khype-carry-executor.js';

// ─── EM-STRAT-016-WO-01-R1: complete kHYPE suppression across ────────────
// ─── remaining operational paths — presenter + executor contracts ───────
//
// Static source-contract assertions (the mechanism this repo already uses
// in strategy-labeling.test.ts / execution-containment.test.ts) plus
// runtime checks on the imported fail-closed constants. All offline: no
// RPC, no scanner/daemon/executor runs, no env or key material.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNNERS_DIR = resolve(__dirname, '..', 'src', 'runners');
// test dir = packages/scanner/test → repo root is three levels up.
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function readRunner(name: string): string {
  return readFileSync(resolve(RUNNERS_DIR, name), 'utf8');
}

// Extract the kHYPE gather block from a runner (from the kHYPE section
// comment/scan up to the next numbered section comment or the end of the
// enclosing function).
function khypeBlock(src: string, startRe: RegExp, endRe: RegExp): string {
  const start = src.match(startRe);
  expect(start, 'kHYPE block not found').not.toBeNull();
  const rest = src.slice((start!.index as number) + start![0].length);
  const end = rest.match(endRe);
  return end ? rest.slice(0, end.index as number) : rest;
}

describe('EM-STRAT-016-WO-01-R1 — dashboard.ts: no ranked kHYPE opportunity', () => {
  const src = readRunner('dashboard.ts');

  it('cannot rank suppressed kHYPE as an actionable opportunity (no opportunities.push in the kHYPE block)', () => {
    const block = khypeBlock(
      src,
      /\/\/ ─── EM-STRAT-016-WO-01-R1: kHYPE is SUPPRESSED/,
      /\n  \/\/ 2\. Euler HL lending arb/,
    );
    expect(block, 'dashboard kHYPE block not found').not.toBeNull();
    // The suppressed kHYPE block must NOT push into the ranked array.
    expect(block).not.toMatch(/opportunities\.push/);
    // It collects into the separate suppressed-reference list instead.
    expect(block).toMatch(/suppressedRefs\.push/);
  });

  it('kHYPE pre-fee estimate cannot enter the top-5 aggregate (totals aggregate only the ranked array)', () => {
    // The aggregate reads only from `opportunities`; kHYPE never enters it.
    // Additionally the suppressed section explicitly labels pre-fee figures.
    const aggMatch = src.match(/opportunities\.slice\(0,\s*5\)\.reduce\(\(sum,\s*o\)\s*=>\s*sum \+ o\.estimatedProfitUsd,\s*0\)/);
    expect(aggMatch, 'top-5 aggregate not found').not.toBeNull();
    // Section exists and its entries carry the pre-fee labeling; the
    // "NOT included in totals" wording is in the section banner and the
    // entry details.
    const section = src.match(/SUPPRESSED REFERENCE — not actionable[\s\S]*?(?=\n  \/\/ Kinetiq status footer)/);
    expect(section, 'suppressed-reference section not found').not.toBeNull();
    expect(src).toMatch(/PRE-UNSTAKE-FEE reference/i);
    // Entries' details carry the exclusion wording (checked against src
    // as a whole: the banner itself is shorter than the entry details).
    expect(src).toMatch(/NOT included in totals/i);
  });

  it('does not present kHYPE annualized return as an expected strategy return', () => {
    const block = khypeBlock(
      src,
      /\/\/ ─── EM-STRAT-016-WO-01-R1: kHYPE is SUPPRESSED/,
      /\n  \/\/ 2\. Euler HL lending arb/,
    );
    expect(block).not.toMatch(/Annualized: \$\$\{annualProfit\.toFixed\(0\)\}/);
    expect(block).toMatch(/NOT an expected strategy return/);
  });
});

describe('EM-STRAT-016-WO-01-R1 — command-handler.ts: verified-profit aggregate + /khype', () => {
  const src = readRunner('command-handler.ts');

  it('/opportunities cannot include kHYPE in Total verified profit', () => {
    const aggMatch = src.match(/const totalProfit[^;]+;/);
    expect(aggMatch, 'totalProfit aggregate not found').not.toBeNull();
    expect(aggMatch![0]).not.toMatch(/khypeProfit/);
    // kHYPE estimate is NOT part of the aggregate expression.
    expect(src).not.toMatch(/khypeProfit\s*\*\s*\(365\s*\/\s*8\)/);
    // The total line explicitly notes the exclusion.
    const totalLine = src.match(/Total verified profit:[^`]*`/);
    expect(totalLine).not.toBeNull();
    expect(totalLine![0]).toMatch(/kHYPE suppressed — pre-fee reference excluded/);
  });

  it('/khype provides no execution instructions and no private-key prompt while suppression is in force', () => {
    const fnMatch = src.match(/async function handleKhype\(\)[\s\S]*?(?=\nasync function handleEuler)/);
    expect(fnMatch, 'handleKhype not found').not.toBeNull();
    const fn = fnMatch![0];
    expect(fn).not.toMatch(/AGENT_HYPE_PRIVKEY/);
    expect(fn).not.toMatch(/Needs .* to execute/);
    expect(fn).not.toMatch(/'Execution:'[\s\S]*1\. Buy kHYPE/);
    expect(fn).toMatch(/Execution: SUPPRESSED — do not execute/);
    expect(fn).toMatch(/separate evidence-backed work order/);
    // Any profit calculation is labeled a pre-fee reference.
    expect(fn).toMatch(/Pre-fee profit reference per 8-day cycle/);
    expect(fn).toMatch(/NOT an expected strategy return/);
  });
});

describe('EM-STRAT-016-WO-01-R1 — daily-report.ts: suppressed kHYPE excluded from rankings and aggregates', () => {
  const src = readRunner('daily-report.ts');

  it('excludes suppressed kHYPE from the actionable/ranked opportunities collection', () => {
    const block = khypeBlock(
      src,
      /\/\/ 1\. kHYPE LST carry arb/,
      /\n  \/\/ 2\. /,
    );
    expect(block).not.toMatch(/opportunities\.push/);
    expect(block).toMatch(/suppressedRefs\.push/);
    // No rank is allocated to suppressed entries.
    expect(block).not.toMatch(/rank:\s*\+\+rank/);
  });

  it('renders kHYPE only in a separate suppressed-reference section, not in the Top-N table', () => {
    const section = src.match(/Suppressed Reference — not actionable[\s\S]*?(?=\n  \/\/ Write report)/);
    expect(section, 'suppressed-reference section not found').not.toBeNull();
    expect(section![0]).toMatch(/PRE-UNSTAKE-FEE reference/i);
    // The status row suppression marker from R1 head is preserved.
    const row = src.match(/\|\s*11\s*\|\s*HL LST \(kHYPE\) Arb\s*\|\s*hl_lst_arb\s*\|\s*([^\n|]+)\|/);
    expect(row).not.toBeNull();
    expect(row![1]).toMatch(/Suppressed.*EM-STRAT-016-WO-01/);
  });
});

describe('EM-STRAT-016-WO-01-R1 — khype-carry-executor.ts: execution fails closed', () => {
  const src = readRunner('khype-carry-executor.ts');

  it('module imports cleanly and exposes the stop constants (no side effects)', () => {
    // Importing this module (top of this file) must not run main() or
    // touch the network; the constants are the observable contract.
    expect(KHYPE_SCOPE).toBe('entrypoint:khype-carry-executor');
    expect(KHYPE_CARRY_EXECUTION_STOPPED).toBe(true);
    expect(KHYPE_CARRY_EXECUTION_SUPPRESSED).toMatch(/unstake fee unverified/);
    expect(KHYPE_CARRY_EXECUTION_SUPPRESSED).toMatch(/EM-STRAT-016-WO-01-R1/);
  });

  it('executeCycle() rejects at the entry gate BEFORE any transaction construction', () => {
    const fn = src.match(/async executeCycle\([\s\S]*?(?=\n  \/\*\*)/);
    expect(fn, 'executeCycle not found').not.toBeNull();
    const body = fn![0];
    // The gate is the FIRST statement of the method.
    const gateIdx = body.indexOf('if (KHYPE_CARRY_EXECUTION_STOPPED)');
    const dryRunIdx = body.indexOf('if (this.opts.dryRun)');
    const swapIdx = body.indexOf('STEP 1');
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(dryRunIdx).toBeGreaterThan(gateIdx);
    expect(swapIdx).toBeGreaterThan(gateIdx);
    expect(body).toMatch(/return \{ queued: false, error: KHYPE_CARRY_EXECUTION_SUPPRESSED \}/);
  });

  it('executeCycle cannot reach a transaction submission while the stop is in force', () => {
    // The gate returns unconditionally before any sendTx/encodeFunctionData
    // call: between the gate and the next early return there is no path
    // that builds or submits a transaction.
    const fn = src.match(/async executeCycle\([\s\S]*?(?=\n  \/\*\*)/)!;
    const gateEnd = fn[0].indexOf('return { queued: false, error: KHYPE_CARRY_EXECUTION_SUPPRESSED };');
    expect(gateEnd).toBeGreaterThan(-1);
    // No transaction building before the gate's return.
    expect(fn[0].slice(0, gateEnd)).not.toMatch(/sendTx|encodeFunctionData/);
  });

  it('removes the unsupported 0.10% "verified" claim and substitutes no guessed value', () => {
    // The hardcoded fee assignment is gone entirely; the only prose
    // mentions are the withdrawn claim and the reason constant.
    expect(src).not.toMatch(/const unstakeFeePct\s*=\s*0\.10/);
    expect(src).not.toMatch(/unstake fee \(verified\)/i);
    // The scan profit arithmetic no longer subtracts any fee constant.
    const scanFn = src.match(/async scan\(\)[\s\S]*?(?=\n  \/\*\*)/)!;
    expect(scanFn[0]).not.toMatch(/unstakeFeePct/);
    // Scan output is labeled unverified (CLI banner + docstring).
    expect(src).toMatch(/UNVERIFIED reference — execution suppressed/);
    expect(src).toMatch(/NOT a validated executable opportunity/);
  });

  it('no environment variable or strategy config can bypass the execution stop', () => {
    // The gate reads a module constant only — no process.env, no opts
    // field, no config key participates in the stop condition.
    const fn = src.match(/async executeCycle\([\s\S]*?(?=\n  \/\*\*)/)!;
    const gate = fn[0].match(/if \(KHYPE_CARRY_EXECUTION_STOPPED\) \{[\s\S]*?\}/)![0];
    expect(gate).not.toMatch(/process\.env|this\.opts/);
    // And the constant itself is not derived from anything configurable.
    expect(src).toMatch(/export const KHYPE_CARRY_EXECUTION_STOPPED = true;/);
  });

  it('preserves the shared execution-authorization checks unchanged (defense-in-depth)', () => {
    // Constructor scope check + per-call sendTx scope check remain.
    expect(src).toMatch(/assertExecutionAuthorized\(ENTRYPOINT_SCOPE\)/);
    expect(src).toMatch(/assertExecutionAuthorized\('evm-executor:send-transaction'\)/);
  });

  it('CLI --execute route fails closed before scanning', () => {
    // EM-STRAT-016-WO-01-R2: the refusal is now the FIRST operation of
    // main() and returns immediately (ordering is proven by the injected
    // R2 tests below). Here: the route prints the suppression reason and
    // no executeCycle call exists anywhere in the CLI.
    const route = src.match(/if \(args\.has\('--execute'\)\)[\s\S]*?return;/);
    expect(route, '--execute route not found').not.toBeNull();
    expect(route![0]).toMatch(/KHYPE_CARRY_EXECUTION_SUPPRESSED/);
    expect(src).not.toMatch(/executor\.executeCycle/);
    expect((src.match(/args\.has\('--execute'\)/g) || []).length).toBe(1);
  });
});

describe('EM-STRAT-016-WO-01-R1 — execution-prioritizer.mts: no kHYPE execution recommendation', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts-explore', 'execution-prioritizer.mts'), 'utf8');

  it('no longer recommends kHYPE execution (no action/priority for kHYPE entries)', () => {
    // Both kHYPE entries are suppressed markers with rank 0 / score 0 and
    // a NONE action.
    const khypeEntries = src.match(/name: 'kHYPE[^']*'/g) || [];
    expect(khypeEntries.length).toBe(2);
    for (const entry of khypeEntries) {
      expect(entry).toMatch(/SUPPRESSED/);
    }
    // No kHYPE entry carries a positive score or a run/execution action.
    expect(src).not.toMatch(/Run HlLstArbScanner|flashloan executor/);
    expect(src).not.toMatch(/Stake HYPE → kHYPE/);
    const suppressedBlocks = src.match(/\{\s*rank: 0,[\s\S]*?\},/g) || [];
    expect(suppressedBlocks.length).toBe(2);
    for (const b of suppressedBlocks) {
      expect(b).toMatch(/riskAdjustedScore: 0/);
      expect(b).toMatch(/action: 'NONE — do not deploy/);
      expect(b).toMatch(/expectedApr: null/);
    }
  });

  it('deployment phases no longer deploy kHYPE; withdrawn aggregates are flagged, not re-estimated', () => {
    expect(src).not.toMatch(/→\s*kHYPE AMM Discount \(\$/);
    expect(src).not.toMatch(/→\s*Add kHYPE Carry \(\$/);
    expect(src).toMatch(/kHYPE AMM Discount SUPPRESSED — not deployed/);
    expect(src).toMatch(/kHYPE Carry SUPPRESSED — not deployed/);
    // The prior $380/day / $400/day / summary profit figures that included
    // kHYPE are withdrawn with an explicit note, no replacement estimate.
    expect(src).toMatch(/WITHDRAWN/);
    expect(src).not.toMatch(/Expected daily profit: ~\$430-630\/day/);
    expect(src).not.toMatch(/Expected annual profit: ~\$157-230k\/yr/);
  });
});

describe('EM-STRAT-016-WO-01-R1 — unrelated strategy presentations unchanged', () => {
  it('VOOI price-spread alerts still dispatch with severity opportunity in opportunity-monitor.ts', () => {
    const src = readRunner('opportunity-monitor.ts');
    const block = src.match(/\/\/ 1\. VOOI price spread arbs[\s\S]*?(?=\n\s*\/\/ 2\. kHYPE LST carry arb)/);
    expect(block, 'VOOI block not found').not.toBeNull();
    expect(block![0]).toMatch(/severity:\s*['"]opportunity['"]/);
    expect(block![0]).toMatch(/strategyId:\s*['"]vooi_price_spread['"]/);
  });

  it('dashboard LST-yield / PT-yield / VOOI strategies still push ranked opportunities', () => {
    const src = readRunner('dashboard.ts');
    expect(src).toMatch(/strategy: 'LST yield switch'/);
    expect(src).toMatch(/strategy: 'PT yield arb'/);
    expect(src).toMatch(/strategy: 'VOOI perp funding arb'/);
  });

  it('daily-report non-kHYPE opportunity sections still push to the ranked collection', () => {
    const src = readRunner('daily-report.ts');
    expect(src).toMatch(/strategy: 'LST yield switch'/);
    expect(src).toMatch(/strategy: 'PT yield arb'/);
    expect(src).toMatch(/strategy: 'VOOI perp funding arb'/);
  });
});

// ─── EM-STRAT-016-WO-01-R2: final kHYPE suppression corrections ──────────

describe('EM-STRAT-016-WO-01-R2 — --execute refusal is the FIRST CLI operation (injected)', () => {
  // Synthetic key bytes for the ordering detector only — never real key
  // material, never used for signing. The refusal path must not reach
  // signer initialization; a broken ordering would attempt constructor-time
  // assertExecutionAuthorized (EDGE_EXECUTION_AUTH is removed below) and
  // throw, failing the test loudly.
  const FAKE_KEY = `0x${'11'.repeat(32)}`;
  let origArgv: string[];
  let origAuth: string | undefined;
  let logLines: string[];
  let logSpy: any;

  beforeEach(() => {
    origArgv = process.argv;
    origAuth = process.env.EDGE_EXECUTION_AUTH;
    delete process.env.EDGE_EXECUTION_AUTH; // no authorization present: any executor construction throws
    vi.stubEnv('AGENT_HYPE_PRIVKEY', FAKE_KEY);
    logLines = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      logLines.push(parts.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllEnvs();
    process.argv = origArgv;
    if (origAuth === undefined) delete process.env.EDGE_EXECUTION_AUTH;
    else process.env.EDGE_EXECUTION_AUTH = origAuth;
  });

  async function runWithArgs(...flagArgs: string[]): Promise<void> {
    process.argv = ['node', 'khype-carry-executor.ts', ...flagArgs];
    // A broken ordering would reach executor construction (authorization
    // throw) or an async branch; a correct one resolves cleanly.
    await expect(main()).resolves.toBeUndefined();
    const out = logLines.join('\n');
    // Refusal printed…
    expect(out).toMatch(/Executing Cycle/);
    expect(out).toMatch(/unstake fee unverified/);
    expect(out).toMatch(/Refused before executor construction/);
    // …and NOTHING else ran: no executor banner (construction happened),
    // no status (KinetiqClient.getStatus), no scan, no claim.
    expect(out).not.toMatch(/kHYPE Carry Arb Executor/);
    expect(out).not.toMatch(/Mode:/);
    expect(out).not.toMatch(/Kinetiq Status/);
    expect(out).not.toMatch(/Carry State/);
    expect(out).not.toMatch(/Scanning/);
    expect(out).not.toMatch(/Claiming Ready Withdrawals/);
  }

  it('--execute alone returns before construction, wallet env use, status, scan, or claim', async () => {
    await runWithArgs('--execute');
  });

  it('--execute --status cannot reach the status branch', async () => {
    await runWithArgs('--execute', '--status');
  });

  it('--execute --scan cannot reach the scan branch', async () => {
    await runWithArgs('--execute', '--scan');
  });

  it('--execute --claim cannot reach the claim branch', async () => {
    await runWithArgs('--execute', '--claim');
  });

  it('all flags mixed: --status --execute --scan --claim still refuses immediately', async () => {
    await runWithArgs('--status', '--execute', '--scan', '--claim');
  });

  it('source contract: the --execute check precedes env read, construction, status, scan, and claim in main()', () => {
    const src = readRunner('khype-carry-executor.ts');
    const mainSrc = src.match(/export async function main\(\)[\s\S]*?(?=\n\/\/ Only run main)/);
    expect(mainSrc, 'main() not found').not.toBeNull();
    const body = mainSrc![0];
    const idxGate = body.indexOf("args.has('--execute')");
    const idxEnv = body.indexOf('process.env.AGENT_HYPE_PRIVKEY');
    const idxCtor = body.indexOf('new KhypeCarryExecutor');
    const idxStatus = body.indexOf("args.has('--status')");
    const idxScan = body.indexOf("args.has('--scan')");
    const idxClaim = body.indexOf("args.has('--claim')");
    expect(idxGate).toBeGreaterThan(-1);
    const targets: Array<[string, number]> = [
      ['wallet-env read', idxEnv],
      ['executor construction', idxCtor],
      ['status branch', idxStatus],
      ['scan branch', idxScan],
      ['claim branch', idxClaim],
    ];
    for (const [name, idx] of targets) {
      expect(idx, `${name} must appear in main()`).toBeGreaterThan(-1);
      expect(idxGate, `--execute gate must precede ${name}`).toBeLessThan(idx);
    }
    // The gate returns immediately; exactly one --execute branch exists.
    expect(body.slice(idxGate, idxGate + 400)).toMatch(/return;/);
    expect((src.match(/args\.has\('--execute'\)/g) || []).length).toBe(1);
  });

  it('R1 protections intact: executeCycle() entry gate and shared authorization checks unchanged', () => {
    const src = readRunner('khype-carry-executor.ts');
    expect(src).toMatch(/export const KHYPE_CARRY_EXECUTION_STOPPED = true;/);
    const fn = src.match(/async executeCycle\([\s\S]*?(?=\n  \/\*\*)/)!;
    expect(fn[0]).toMatch(/if \(KHYPE_CARRY_EXECUTION_STOPPED\) \{[\s\S]*?return \{ queued: false, error: KHYPE_CARRY_EXECUTION_SUPPRESSED \}/);
    expect(src).toMatch(/assertExecutionAuthorized\(ENTRYPOINT_SCOPE\)/);
    expect(src).toMatch(/assertExecutionAuthorized\('evm-executor:send-transaction'\)/);
  });
});

describe('EM-STRAT-016-WO-01-R2 — telegram-summary.ts: withdrawn aggregates + corrected comment', () => {
  const src = readRunner('telegram-summary.ts');

  it('no longer presents the $65k capital requirement or the $1.48M/yr = 2,274% APR forecast as active claims', () => {
    // The active-claim string literals are gone…
    expect(src).not.toMatch(/'Capital needed: \$65k/);
    expect(src).not.toMatch(/'Expected: \$1\.48M/);
    expect(src).not.toMatch(/Agent wallet \(\$10k HYPE\+USDC/);
    // …replaced by explicit withdrawals (the figures appear only as
    // withdrawn references, never as a forward-looking claim).
    expect(src).toMatch(/Capital needed: WITHDRAWN — prior \$65k aggregate included the suppressed kHYPE strategy/);
    expect(src).toMatch(/Expected: WITHDRAWN — prior \$1\.48M\/yr = 2,274% APR forecast had no in-file derivation/);
    expect(src).toMatch(/no replacement forecast without independently reconciled evidence/);
  });

  it('corrects the stale comment: estimatedProfitUsd is a pre-unstake-fee reference, not verified profit', () => {
    expect(src).not.toMatch(/verified number \(scanner requires/);
    expect(src).toMatch(/PRE-UNSTAKE-FEE reference/);
    expect(src).toMatch(/NOT verified net profit/);
  });

  it('labels all three kHYPE section variants as suppressed (alerts / no-alert / failure)', () => {
    expect((src.match(/kHYPE CARRY ARB \(SUPPRESSED/g) || []).length).toBe(3);
    expect(src).not.toMatch(/'--- kHYPE CARRY ARB ---'/);
    expect(src).not.toMatch(/`--- kHYPE CARRY ARB ---`/);
  });

  it('unrelated strategy forecasts untouched (VOOI price-spread/funding, Euler monitoring)', () => {
    expect(src).toMatch(/Top 5: \$\$\{top5\.toFixed\(0\)\}\/cycle/);
    expect(src).toMatch(/FUNDING RATE ARBS \(8-24h hold\)/);
    expect(src).toMatch(/EULER LENDING \(MONITORING ONLY — not actionable\)/);
  });
});

describe('EM-STRAT-016-WO-01-R2 — /opportunities: kHYPE is an UNRANKED suppressed reference', () => {
  const src = readRunner('command-handler.ts');

  it('the suppressed kHYPE reference carries no ranking prefix in either branch', () => {
    expect(src).not.toMatch(/#\d+\s*kHYPE/);
    const unranked = src.match(/SUPPRESSED reference \(UNRANKED, not an actionable opportunity/g) || [];
    expect(unranked.length).toBe(2); // alerts-present and no-alert branches
    expect(src).toMatch(/unstake-fee evidence unavailable; NOT counted in totals/);
  });

  it('numbered entries and the verified-profit exclusion are unchanged', () => {
    // The ranked/numbered mechanism still applies to the remaining entries.
    expect(src).toMatch(/#\$\{lines\.filter\(l => l\.startsWith\('#'\)\)\.length \+ 1\} Euler/);
    // R1 exclusion preserved.
    expect(src).toMatch(/kHYPE suppressed — pre-fee reference excluded/);
    expect(src).not.toMatch(/khypeProfit\s*\*\s*\(365\s*\/\s*8\)/);
  });
});
