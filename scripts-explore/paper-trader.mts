// Paper Trading Simulator V2 — Integrated with @edge/scanner accounting engine
// Simulates strategies with live market data — NO REAL CAPITAL
//
// V2 state/log files are separate from V1. V1 files are preserved as
// unaudited historical records. V2 starts with a clean $100k baseline.
//
// Fee semantics: Funding position fees are "settled at close" — they
// are estimated at open time (logged as estimatedFee) but only incurred
// in feesTotal and deducted from P&L when the position closes.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  type AccountingState,
  type VooiResponse,
  validateState,
  getSummary,
} from '../packages/scanner/src/lib/paper-trader-accounting.js';
import { runScan, createV2InitialState } from '../packages/scanner/src/lib/paper-trader-engine.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..');

// Load .env (for PAPER_HLP_APR / PAPER_KHYPE_APR config vars)
try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

// ─── V2 state/log paths (configurable for testing) ────────────────────
const V1_STATE = '/home/z/my-project/download/paper-trading-state.json';
const V1_LOG   = '/home/z/my-project/download/paper-trading-log.jsonl';

const V2_STATE = process.env.PAPER_V2_STATE ?? '/home/z/my-project/download/paper-trading-state-v2.json';
const V2_LOG   = process.env.PAPER_V2_LOG   ?? '/home/z/my-project/download/paper-trading-log-v2.jsonl';

const VOI_API = 'https://perps-api.vooi.io';

async function vooiScan(params: Record<string, unknown>): Promise<VooiResponse> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const url = `${VOI_API}/arbitrage-scanner?${q.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return { items: [], total: 0 };
  return res.json();
}

// ─── V2 State I/O (fail-closed) ───────────────────────────────────────

function loadV2State(): AccountingState | null {
  if (!existsSync(V2_STATE)) {
    return null; // no existing state — engine will create fresh
  }
  const raw = readFileSync(V2_STATE, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // State file is corrupted JSON — fail closed
    // Create a diagnostic copy, then abort
    const diagPath = V2_STATE + `.corrupt-${Date.now()}`;
    try { copyFileSync(V2_STATE, diagPath); } catch {}
    console.error(`FATAL: V2 state file is corrupted JSON. Original preserved at ${V2_STATE}. Diagnostic copy at ${diagPath}.`);
    console.error(`Not overwriting the original. Aborting.`);
    process.exit(1);
  }

  // Check for missing opportunityHistory (backward compat with earlier V2 state)
  const state = parsed as AccountingState;
  if (!state.opportunityHistory) {
    state.opportunityHistory = { entries: {} };
  }

  // Validate — fail closed on invalid state
  try {
    validateState(state);
  } catch (e) {
    // State is invalid — do NOT silently replace with a new baseline.
    // Create a diagnostic copy, then abort.
    const diagPath = V2_STATE + `.invalid-${Date.now()}`;
    try { copyFileSync(V2_STATE, diagPath); } catch {}
    console.error(`FATAL: V2 state validation failed. Original preserved at ${V2_STATE}. Diagnostic copy at ${diagPath}.`);
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`Not overwriting the original state. Aborting to prevent data loss.`);
    process.exit(1);
  }

  return state;
}

function saveV2State(state: AccountingState): void {
  const dir = dirname(V2_STATE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(V2_STATE, JSON.stringify(state, null, 2));
}

function logV2Trade(entry: Record<string, unknown>): void {
  const dir = dirname(V2_LOG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + '\n';
  try {
    const existing = readFileSync(V2_LOG, 'utf8').split('\n').filter(l => l.trim());
    existing.push(JSON.stringify({ ts: Date.now(), ...entry }));
    writeFileSync(V2_LOG, existing.map(l => l).join('\n') + '\n');
  } catch {
    writeFileSync(V2_LOG, line);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Paper Trading Simulator V2 (accounting-integrated)');
  console.log('═══════════════════════════════════════════════════\n');

  const result = await runScan({
    fetchPriceSpreadArbs: () => vooiScan({ limit: 10, orderBy: 'priceSpread', orderDirection: 'desc', minPriceSpread: 0.005 }),
    fetchFundingArbs: () => vooiScan({ limit: 10, orderBy: 'fundingSpread1h', orderDirection: 'desc', minFundingSpread: 0.0005 }),
    now: () => Date.now(),
    loadState: loadV2State,
    saveState: saveV2State,
    logTrade: logV2Trade,
    creditUnverified: process.env.PAPER_CREDIT_UNVERIFIED === 'true',
    scanIntervalMs: 5 * 60 * 1000,
  });

  const s = result.summary;
  console.log('═══════════════════════════════════════════════════');
  console.log('  V2 Paper Trading Summary');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Starting capital:     $${s.startingCapital.toLocaleString()}`);
  console.log(`  Total capital:        $${s.totalCapital.toFixed(2)}`);
  console.log(`  Available capital:    $${s.availableCapital.toFixed(2)}`);
  console.log(`  Reserved capital:     $${s.reservedCapital.toFixed(2)}`);
  console.log(`  Allocated capital:    ${s.allocatedCapital.map(a => `${a.source}=$${a.amount}`).join(', ') || '(none)'}`);
  console.log('');
  console.log('  P&L Breakdown:');
  console.log(`    Arb P&L:            $${s.pnl.arb.toFixed(2)}`);
  console.log(`    Funding P&L:        $${s.pnl.funding.toFixed(2)}`);
  console.log(`    Passive yield (est.):$${s.pnl.passiveYield.toFixed(2)}`);
  console.log(`    TOTAL P&L:          $${s.pnl.total.toFixed(2)}`);
  console.log(`    Fees paid:          $${s.fees.toFixed(2)}`);
  console.log('');
  console.log(`  Trades: ${s.trades.total} (W:${s.trades.winning} L:${s.trades.losing} WR:${(s.trades.winRate * 100).toFixed(1)}%)`);
  console.log(`  Open funding positions: ${s.openFundingPositions}`);
  console.log(`  ROI: ${(s.roi * 100).toFixed(4)}%`);
  if (result.errors.length > 0) {
    console.log('');
    console.log('  Errors:');
    for (const e of result.errors) {
      console.log(`    ${e}`);
    }
  }
  console.log('');
  console.log(`  Scan: ${result.arbTradesExecuted} arb trades, ${result.fundingPositionsOpened} funding opened, ${result.fundingPositionsClosed} funding closed`);
  console.log(`  Yield: ${result.yieldCredited.map(y => `${y.source}=$${y.amount.toFixed(4)}(${y.label})`).join(', ')}`);
  console.log('');
  console.log(`  V2 State: ${V2_STATE}`);
  console.log(`  V2 Log:   ${V2_LOG}`);
  console.log(`  V1 State (preserved, NOT modified): ${V1_STATE}`);
  console.log(`  V1 Log   (preserved, NOT modified): ${V1_LOG}`);
  console.log('');
  console.log('  NOTE: V2 is a new accounting period with clean $100k baseline.');
  console.log('  V1 P&L is NOT carried over. Do not combine V1 and V2 figures.');
  console.log('  Passive yield is labeled as estimate — not realized income.');
  console.log('  Funding position fees are settled at close (not at open).');
}

main().catch(err => {
  console.error('Paper trader V2 fatal error:', err);
  process.exit(1);
});
