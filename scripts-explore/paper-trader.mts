// Paper Trading Simulator V2 — Integrated with @edge/scanner accounting module
// Simulates strategies with live market data — NO REAL CAPITAL
// Tracks simulated P&L with separated categories, capital allocation,
// funding-position lifecycle, and conservative yield handling.
//
// V2 state/log files are separate from V1. V1 files are preserved as
// unaudited historical records. V2 starts with a clean $100k baseline.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  // Types
  type AccountingState,
  type YieldConfig,
  type YieldSource,
  type ArbTrade,
  // Constants
  SCAN_INTERVAL_MS,
  ONE_DAY_MS,
  DEFAULT_FUNDING_MATURITY_MS,
  DEFAULT_ADVERSE_DRIFT,
  DEFAULT_EROSION_FACTOR,
  DEFAULT_SLIPPAGE_FRACTION,
  DEFAULT_SLIPPAGE_CAP_PCT,
  DEFAULT_FEE_BPS,
  // Pure functions
  createInitialState,
  calcSlippage,
  calcFees,
  calcSpreadErosion,
  calcArbGrossProfit,
  calcArbNetProfit,
  calcFundingReversal,
  calcPassiveYield,
  allocateCapital,
  tryRecordArbTrade,
  tryOpenFundingPosition,
  closeMatureFundingPositions,
  creditPassiveYield,
  getSummary,
  getTotalPnl,
  getWinRate,
  getRoi,
  isValidPositiveAmount,
  validateState,
} from '../packages/scanner/src/lib/paper-trader-accounting.ts';

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
// V1 legacy files are NOT modified by V2.
const V1_STATE = '/home/z/my-project/download/paper-trading-state.json';
const V1_LOG   = '/home/z/my-project/download/paper-trading-log.jsonl';

const V2_STATE = process.env.PAPER_V2_STATE ?? '/home/z/my-project/download/paper-trading-state-v2.json';
const V2_LOG   = process.env.PAPER_V2_LOG   ?? '/home/z/my-project/download/paper-trading-log-v2.jsonl';

const HL_API = 'https://api.hyperliquid.xyz/info';
const VOI_API = 'https://perps-api.vooi.io';

async function vooiScan(params: Record<string, unknown>): Promise<any> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const url = `${VOI_API}/arbitrage-scanner?${q.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return { items: [], total: 0 };
  return res.json();
}

// ─── V2 State I/O ─────────────────────────────────────────────────────

function loadV2State(): AccountingState {
  if (existsSync(V2_STATE)) {
    const raw = JSON.parse(readFileSync(V2_STATE, 'utf8'));
    // Deserialize — restore bigint fields that were serialized as strings
    const state: AccountingState = {
      ...raw,
      openFundingPositions: (raw.openFundingPositions || []).map((p: any) => ({
        ...p,
      })),
    };
    try {
      validateState(state);
    } catch (e) {
      console.error('V2 state validation failed, starting fresh:', e);
      return createV2InitialState();
    }
    return state;
  }
  return createV2InitialState();
}

function createV2InitialState(): AccountingState {
  // V2 starts with a clean $100k baseline — NOT a continuation of V1.
  // V1's inflated realizedPnl/currentCapital are NOT carried over.
  const hlpApr = Number(process.env.PAPER_HLP_APR ?? 0.30);
  const khypeApr = Number(process.env.PAPER_KHYPE_APR ?? 0.0193);

  const yields: Record<YieldSource, YieldConfig> = {
    hlp: {
      source: 'hlp',
      apr: hlpApr,
      capitalUsd: 5000,
      verified: false, // HLP 30% APR is UNVERIFIED
      verifiedAt: null,
      freshnessMs: ONE_DAY_MS,
    },
    khype: {
      source: 'khype',
      apr: khypeApr,
      capitalUsd: 10000,
      verified: false, // kHYPE 1.93% was verified Oct 13 but is now stale
      verifiedAt: null, // Do NOT invent fresh verification timestamps
      freshnessMs: ONE_DAY_MS,
    },
  };

  let state = createInitialState(100_000, yields);

  // Pre-allocate capital for passive yield positions (one-time)
  state = allocateCapital(state, 'hlp', 5000);
  state = allocateCapital(state, 'khype', 10000);

  return state;
}

function saveV2State(state: AccountingState): void {
  state.lastUpdate = Date.now();
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

// ─── Main scan function ───────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Paper Trading Simulator V2 (accounting-integrated)');
  console.log('═══════════════════════════════════════════════════\n');

  // Load V2 state
  let state = loadV2State();
  const now = Date.now();

  // Validate state
  try {
    validateState(state);
  } catch (e) {
    console.error('State validation failed — starting fresh:', e);
    state = createV2InitialState();
  }

  const summaryBefore = getSummary(state);
  console.log(`V2 Starting capital: $${summaryBefore.startingCapital.toLocaleString()}`);
  console.log(`V2 Available capital: $${summaryBefore.availableCapital.toFixed(2)}`);
  console.log(`V2 Allocated capital: ${JSON.stringify(summaryBefore.allocatedCapital)}`);
  console.log(`V2 Reserved capital: $${summaryBefore.reservedCapital.toFixed(2)}`);
  console.log(`V2 Arb P&L: $${summaryBefore.pnl.arb.toFixed(2)}`);
  console.log(`V2 Funding P&L: $${summaryBefore.pnl.funding.toFixed(2)}`);
  console.log(`V2 Passive yield (est.): $${summaryBefore.pnl.passiveYield.toFixed(2)}`);
  console.log(`V2 Open funding positions: ${summaryBefore.openFundingPositions}`);
  console.log(`V2 Total trades: ${summaryBefore.trades.total}`);
  console.log('');

  // 0. Close any mature funding positions
  console.log('── Closing Mature Funding Positions ──');
  const closeResult = closeMatureFundingPositions(state, now);
  state = closeResult.state;
  for (const c of closeResult.closed) {
    console.log(`  [CLOSE] ${c.positionId} pnl=$${c.pnl.toFixed(2)} reason=${c.closeReason}`);
    logV2Trade({
      type: 'funding_close',
      positionId: c.positionId,
      pnl: c.pnl,
      closeReason: c.closeReason,
      isMature: c.isMature,
    });
  }
  if (closeResult.closed.length === 0) {
    console.log('  No mature positions to close');
  }
  console.log('');

  // 1. Scan VOOI price-spread arbs
  console.log('── Scanning VOOI Price Spread Arb ──');
  let vooiArbsFound = 0;
  let vooiProfitSimulated = 0;
  try {
    const vooiResp = await vooiScan({ limit: 10, orderBy: 'priceSpread', orderDirection: 'desc', minPriceSpread: 0.005 });
    const seenAssets = new Set<string>();

    for (const item of (vooiResp?.items || [])) {
      if (vooiArbsFound >= 3) break;
      if (seenAssets.has(item.asset)) continue;
      for (const p of (item.pairs || [])) {
        if (vooiArbsFound >= 3) break;
        const spread = (p.priceSpread || 0) * 100;
        if (spread < 0.5) continue;

        seenAssets.add(item.asset);
        const captureCount = 0; // V2 doesn't carry V1 capture counts
        const effectiveSpread = calcSpreadErosion(spread, captureCount);
        if (effectiveSpread < 0.3) continue;

        const notional = 5000;
        const grossProfit = calcArbGrossProfit(notional, effectiveSpread);
        const { slippageUsd } = calcSlippage(notional, effectiveSpread);
        const fees = calcFees(notional, DEFAULT_FEE_BPS);
        const netProfit = calcArbNetProfit(grossProfit, slippageUsd, fees);

        const trade: ArbTrade = {
          strategy: 'VOOI Price Spread Arb',
          asset: item.asset,
          notionalUsd: notional,
          grossProfitUsd: grossProfit,
          slippageUsd,
          feesUsd: fees,
          netProfitUsd: netProfit,
        };

        // Try to record — checks available capital
        const result = tryRecordArbTrade(state, trade);
        if (!result.ok) {
          console.log(`  [SKIP] ${item.asset} — ${result.reason}`);
          continue;
        }
        state = result.state;

        logV2Trade({
          type: 'arb',
          strategy: 'VOOI Price Spread Arb',
          asset: item.asset,
          notionalUsd: notional,
          grossProfitUsd: grossProfit,
          slippageUsd,
          feesUsd: fees,
          netProfitUsd: netProfit,
        });

        vooiArbsFound++;
        vooiProfitSimulated += netProfit;
        console.log(`  [VOOI] ${item.asset} spread=${effectiveSpread.toFixed(2)}%  net=$${netProfit.toFixed(2)} ${netProfit > 0 ? '✓' : '✗'}`);
        break; // one arb per asset
      }
    }
  } catch (err) {
    console.log(`  [ERROR] VOOI price scan failed: ${err}`);
  }
  if (vooiArbsFound === 0) {
    console.log('  No VOOI arbs executed');
  } else {
    console.log(`  Subtotal: ${vooiArbsFound} trades, $${vooiProfitSimulated.toFixed(2)} net P&L`);
  }
  console.log('');

  // 2. Scan VOOI funding-rate arbs — OPEN positions (do not credit P&L)
  console.log('── Scanning VOOI Funding Rate Arb ──');
  let fundingArbsOpened = 0;
  try {
    const vooiFundingResp = await vooiScan({ limit: 10, orderBy: 'fundingSpread1h', orderDirection: 'desc', minFundingSpread: 0.0005 });
    const seenAssets = new Set<string>();

    for (const item of (vooiFundingResp?.items || [])) {
      if (fundingArbsOpened >= 3) break;
      if (seenAssets.has(item.asset)) continue;
      for (const p of (item.pairs || [])) {
        if (fundingArbsOpened >= 3) break;
        const spread = (p.fundingSpread1h || 0) * 100;
        const annualApr = spread * 24 * 365;
        if (annualApr < 70 || annualApr > 120) continue;

        seenAssets.add(item.asset);
        const notional = 5000;
        const reversed = calcFundingReversal(item.asset);
        const fees = calcFees(notional, DEFAULT_FEE_BPS);

        // Try to open — checks available capital, reserves notional
        const result = tryOpenFundingPosition(
          state,
          {
            asset: item.asset,
            notionalUsd: notional,
            entryFundingSpread1hPct: spread,
            maturityMs: DEFAULT_FUNDING_MATURITY_MS,
            adverseDriftFactor: DEFAULT_ADVERSE_DRIFT,
            reversed,
            feesUsd: fees,
          },
          now,
        );
        if (!result.ok) {
          console.log(`  [SKIP] ${item.asset} — ${result.reason}`);
          continue;
        }
        state = result.state;

        logV2Trade({
          type: 'funding_open',
          positionId: result.positionId,
          asset: item.asset,
          notionalUsd: notional,
          entryFundingSpread1hPct: spread,
          annualApr,
          reversed,
          feesUsd: fees,
        });

        fundingArbsOpened++;
        console.log(`  [FUND-OPEN] ${item.asset} 1h=${spread.toFixed(4)}% (${annualApr.toFixed(0)}%/yr${reversed ? ' REVERSED' : ''})  notional=$${notional} reserved`);
        break;
      }
    }
  } catch (err) {
    console.log(`  [ERROR] VOOI funding scan failed: ${err}`);
  }
  if (fundingArbsOpened === 0) {
    console.log('  No funding positions opened');
  } else {
    console.log(`  Subtotal: ${fundingArbsOpened} positions opened (P&L credited on close, not now)`);
  }
  console.log('');

  // 3. Credit passive yield (conservative — creditUnverified=false by default)
  console.log('── Passive Yield (conservative) ──');
  const creditUnverified = process.env.PAPER_CREDIT_UNVERIFIED === 'true';

  for (const source of ['hlp', 'khype'] as YieldSource[]) {
    const config = state.yields[source];
    if (!config) continue;
    const yieldResult = calcPassiveYield(config, SCAN_INTERVAL_MS, now, creditUnverified);
    if (yieldResult.yieldUsd > 0) {
      state = creditPassiveYield(state, source, yieldResult.yieldUsd);
      logV2Trade({
        type: 'passive_yield',
        source,
        yieldUsd: yieldResult.yieldUsd,
        label: yieldResult.label,
        apr: config.apr,
        capitalUsd: config.capitalUsd,
      });
      console.log(`  ${source}: +$${yieldResult.yieldUsd.toFixed(6)} (${yieldResult.label}, ${(config.apr * 100).toFixed(2)}% APR on $${config.capitalUsd})`);
    } else {
      console.log(`  ${source}: $0.00 (${yieldResult.label} — yield not credited)`);
    }
  }
  console.log('');

  // 4. Save V2 state
  saveV2State(state);

  // 5. Print summary
  const summary = getSummary(state);
  console.log('═══════════════════════════════════════════════════');
  console.log('  V2 Paper Trading Summary');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Starting capital:     $${summary.startingCapital.toLocaleString()}`);
  console.log(`  Total capital:        $${summary.totalCapital.toFixed(2)}`);
  console.log(`  Available capital:    $${summary.availableCapital.toFixed(2)}`);
  console.log(`  Reserved capital:     $${summary.reservedCapital.toFixed(2)}`);
  console.log(`  Allocated capital:    ${summary.allocatedCapital.map(a => `${a.source}=$${a.amount}`).join(', ') || '(none)'}`);
  console.log('');
  console.log('  P&L Breakdown:');
  console.log(`    Arb P&L:            $${summary.pnl.arb.toFixed(2)}`);
  console.log(`    Funding P&L:        $${summary.pnl.funding.toFixed(2)}`);
  console.log(`    Passive yield (est.):$${summary.pnl.passiveYield.toFixed(2)}`);
  console.log(`    TOTAL P&L:          $${summary.pnl.total.toFixed(2)}`);
  console.log(`    Fees paid:          $${summary.fees.toFixed(2)}`);
  console.log('');
  console.log(`  Trades: ${summary.trades.total} (W:${summary.trades.winning} L:${summary.trades.losing} WR:${(summary.trades.winRate * 100).toFixed(1)}%)`);
  console.log(`  Open funding positions: ${summary.openFundingPositions}`);
  console.log(`  ROI: ${(summary.roi * 100).toFixed(4)}%`);
  console.log('');
  console.log(`  V2 State: ${V2_STATE}`);
  console.log(`  V2 Log:   ${V2_LOG}`);
  console.log(`  V1 State (preserved, NOT modified): ${V1_STATE}`);
  console.log(`  V1 Log   (preserved, NOT modified): ${V1_LOG}`);
  console.log('');
  console.log('  NOTE: V2 is a new accounting period with clean $100k baseline.');
  console.log('  V1 P&L is NOT carried over. Do not combine V1 and V2 figures.');
  console.log('  Passive yield is labeled as estimate — not realized income.');
}

main().catch(err => {
  console.error('Paper trader V2 fatal error:', err);
  process.exit(1);
});
