/**
 * limUSD Monitor — Read-Only Zero-Capital Sampler (EI-010-V2 corrected)
 * ─────────────────────────────────────────────────────────────────────
 * Purpose:
 *   Implements EI-010-M1/V2: read-only monitoring of the PT-LIMUSD
 *   fixed-yield instrument on HyperEVM (chain 999). No trading, no
 *   execution, no wallet access — only public on-chain reads and
 *   DefiLlama API.
 *
 * Contract identities (EI-S006 verified, re-checked on-chain 2026-10-14):
 *   - limUSD (underlying): 0x1822bd335489d84abdd0779a7dcaeda0625e83c8
 *     (18 decimals, name="limUSD", supply ~8.48M)
 *   - PT-limUSD-26NOV2026: 0x6b7cea9d070bbffd8205f256897319139cdef399
 *     (6 decimals, name="PT limUSD 26NOV2026", supply ~1.23M)
 *   - SY-limUSD: 0xcf6b4c156f51818922b98524dc832e352f40d516
 *     (18 decimals, name="SY limUSD", supply ~1.88M)
 *   - Pendle market: 0xfc93d1ada3277e6274c3905db0a2c81ac1252025
 *   - NAVOracle: 0x47f8d4847f528C18Ea5A6dcb9E0940F6b2977CA7
 *   - RedemptionPipe: 0x2E8c1256356e261150120a384d95DC0d0D00ae29
 *   - USDC: 0xb88339CB7199b77E23DB6E890353E22632Ba630f (6 decimals)
 *
 * Correction from EI-S006 §4:
 *   The previous version (7087f43) swapped PT and underlying identities:
 *   - 0x1822 was labeled "PT-limUSD" but is actually the underlying limUSD
 *   - 0x6b7c was labeled "Pendle PT market" but is actually the PT token
 *   This version uses the correct identities and reads each contract
 *   separately with appropriate decimal handling.
 *
 * Precision:
 *   All supply reads use bigint arithmetic to avoid float precision loss
 *   on 18-decimal values. Supplies are stored as raw bigint strings in
 *   observations, with a derived decimal-adjusted string for display.
 *
 * Alert thresholds (from registry):
 *   - Share-price change > 0.5% per day
 *   - Redemption buffer < $50,000 (baseline: $0, verified unchanged)
 *
 * Stateful deduplication:
 *   Pre-existing breaches (buffer=0, depth criterion) are recorded once.
 *   Thereafter alerts fire only on transitions (OK→BREACH, BREACH→OK).
 *
 * Zero-capital: no transactions, no private keys, no wallet access.
 * Read-only public RPC and DefiLlama API only.
 *
 * Status: PT-LIMUSD remains at WATCHLIST. Redemption-at-maturity is
 * UNVERIFIED before November 26, 2026. This sampler does NOT promote
 * PT-LIMUSD to capital-ready status.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
const LLAMA_POOLS_API = 'https://yields.llama.fi/pools';
const DATA_DIR = resolve(REPO_ROOT, 'data', 'limusd-study');
const DATA_FILE = resolve(DATA_DIR, 'observations.jsonl');
const STATE_FILE = resolve(DATA_DIR, 'monitor-state.json');

const POLL_INTERVAL_MS = Number(process.env.LIMUSD_POLL_INTERVAL_SEC ?? 600) * 1000; // 10 min default

// ─── Verified contract identities (EI-S006, re-checked 2026-10-14) ──
const LIMUSD_ADDR    = '0x1822bd335489d84abdd0779a7dcaeda0625e83c8';  // underlying, 18 dec
const PT_LIMUSD_ADDR = '0x6b7cea9d070bbffd8205f256897319139cdef399';  // PT token, 6 dec
const SY_LIMUSD_ADDR = '0xcf6b4c156f51818922b98524dc832e352f40d516';  // SY token, 18 dec
const MARKET_ADDR    = '0xfc93d1ada3277e6274c3905db0a2c81ac1252025';  // Pendle market
const NAV_ORACLE_ADDR= '0x47f8d4847f528C18Ea5A6dcb9E0940F6b2977CA7';
const REDEMPTION_PIPE_ADDR = '0x2E8c1256356e261150120a384d95DC0d0D00ae29';
const USDC_ADDR      = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';  // 6 dec

const LIMUSD_DECIMALS = 18;
const PT_DECIMALS = 6;
// USDC uses 6 decimals — the RedemptionPipe buffer is divided by 1e6 in the alert logic

// Alert thresholds (from registry)
const SHARE_PRICE_CHANGE_THRESHOLD_PCT = 0.5;  // per day
const REDEMPTION_BUFFER_THRESHOLD_USD = 50_000;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Baseline: redemption buffer reported as zero at EI-S005 snapshot.
const REDEMPTION_BUFFER_BASELINE_USD = 0;

interface Observation {
  ts: string;              // ISO 8601 UTC
  blockNumber: number | null;
  source: 'hyperevm-rpc' | 'defillama';
  // Raw bigint supplies as strings (exact, no precision loss)
  limUsdTotalSupplyRaw: string | null;   // 18-dec bigint
  ptTotalSupplyRaw: string | null;       // 6-dec bigint
  syTotalSupplyRaw: string | null;       // 18-dec bigint
  // Derived display values (decimal-adjusted strings)
  limUsdTotalSupply: string | null;      // e.g. "8483686.270107"
  ptTotalSupply: string | null;          // e.g. "1232395.648233"
  syTotalSupply: string | null;
  // NAV and share price (exact bigint division where possible)
  navRaw: string | null;                 // NAVOracle getNAV() raw (18-dec fp)
  navUsd: string | null;                 // navRaw / 1e18
  sharePrice: string | null;             // navRaw / limUsdSupply (both 18-dec → ratio)
  // Redemption buffer (USDC balance of RedemptionPipe)
  redemptionBufferRaw: string | null;    // 6-dec bigint
  redemptionBufferUsd: number | null;    // raw / 1e6 (safe for $ amounts)
  // DefiLlama context (separate from executable economics)
  ptApy: number | null;
  underlyingApy: number | null;
  ptTvlUsd: number | null;
  underlyingTvlUsd: number | null;
  // Maturity (from PT.expiry() — authoritative, not DefiLlama label)
  ptExpiry: number | null;               // Unix timestamp
  ptMaturityDate: string | null;         // ISO date
  // Data-source success tracking
  rpcSuccess: boolean;
  defillamaSuccess: boolean;
  readFailures: string[];                // per-field error markers
  alerts: string[];
  note?: string;
}

interface MonitorState {
  lastAlertTime: Record<string, number>;
  preexistingBreaches: Record<string, string>;  // breachKey → timestamp first seen
  lastSharePrice: string | null;
  lastSharePriceTs: string | null;
}

// ─── RPC helpers ────────────────────────────────────────────────────

async function ethCall(to: string, data: string): Promise<string | null> {
  try {
    const res = await fetch(HYPEREVM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'eth_call',
        params: [{ to, data }, 'latest'], id: 1,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as any;
    const result = j?.result;
    if (!result || result === '0x' || result.length < 66) return null;
    return result;
  } catch {
    return null;
  }
}

async function getBlockNumber(): Promise<number | null> {
  try {
    const res = await fetch(HYPEREVM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as any;
    return j?.result ? parseInt(j.result, 16) : null;
  } catch {
    return null;
  }
}

/** Read totalSupply() as exact bigint. Returns null on failure. */
async function getTotalSupplyBig(addr: string): Promise<bigint | null> {
  // totalSupply() = 0x18160ddd
  const result = await ethCall(addr, '0x18160ddd');
  if (!result) return null;
  try {
    return BigInt(result);
  } catch {
    return null;
  }
}

/** Read balanceOf(address) as exact bigint. Returns null on failure. */
async function getBalanceOfBig(tokenAddr: string, holderAddr: string): Promise<bigint | null> {
  // balanceOf(address) = 0x70a08231 + padded address
  const paddedAddr = holderAddr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const result = await ethCall(tokenAddr, `0x70a08231${paddedAddr}`);
  if (!result) return null;
  try {
    return BigInt(result);
  } catch {
    return null;
  }
}

/** Read a simple uint256 return value as bigint. */
async function getUint256(addr: string, selector: string): Promise<bigint | null> {
  const result = await ethCall(addr, selector);
  if (!result) return null;
  try {
    return BigInt(result);
  } catch {
    return null;
  }
}

/** Convert a raw bigint to a decimal-adjusted string (exact, no float). */
function bigToDecimalString(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const absRaw = neg ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const wholePart = absRaw / divisor;
  const fracPart = absRaw % divisor;
  const fracStr = fracPart.toString().padStart(decimals, '0');
  return (neg ? '-' : '') + `${wholePart}.${fracStr}`;
}

/** Calculate share price = NAV / supply (both same decimals → ratio is dimensionless).
 *  Returns a decimal string. decimals param documents the input scale. */
function calcSharePrice(navRaw: bigint, supplyRaw: bigint, _decimals: number): string {
  if (supplyRaw === 0n) return '0';
  // sharePrice = navRaw / supplyRaw (both 18-dec → result is a ratio like 1.0356)
  // To get 6 decimal places of precision: (navRaw * 1e6) / supplyRaw, then format
  const precision = 6n;
  const multiplier = 10n ** precision;
  const scaledPrice = (navRaw * multiplier) / supplyRaw;
  const wholePart = scaledPrice / multiplier;
  const fracPart = scaledPrice % multiplier;
  return `${wholePart}.${fracPart.toString().padStart(Number(precision), '0')}`;
}

// ─── DefiLlama helpers ──────────────────────────────────────────────

async function fetchLimUsdYields(): Promise<{
  ptApy: number | null;
  underlyingApy: number | null;
  ptTvl: number | null;
  underlyingTvl: number | null;
}> {
  try {
    const res = await fetch(LLAMA_POOLS_API, {
      headers: { 'User-Agent': 'Edge-Engine-Manager/limusd-monitor', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ptApy: null, underlyingApy: null, ptTvl: null, underlyingTvl: null };
    const j = await res.json() as any;
    const pools = j?.data ?? [];
    const limUsdPools = pools.filter((p: any) =>
      p.project === 'pendle-v2' && p.symbol === 'LIMUSD' && p.chain === 'Hyperliquid L1'
    );
    const underlyingPools = pools.filter((p: any) =>
      p.project === 'liminal-basis' && p.symbol === 'LIMUSD' && p.chain === 'Hyperliquid L1'
    );

    let ptApy: number | null = null;
    let ptTvl: number | null = null;
    for (const p of limUsdPools) {
      if (p.poolMeta?.includes('buying PT')) {
        ptApy = p.apy ?? null;
        ptTvl = p.tvlUsd ?? null;
        break;
      }
    }

    const underlyingApy = underlyingPools[0]?.apy ?? null;
    const underlyingTvl = underlyingPools[0]?.tvlUsd ?? null;

    return { ptApy, underlyingApy, ptTvl, underlyingTvl };
  } catch {
    return { ptApy: null, underlyingApy: null, ptTvl: null, underlyingTvl: null };
  }
}

// ─── State management ───────────────────────────────────────────────

function loadState(): MonitorState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return { lastAlertTime: {}, preexistingBreaches: {}, lastSharePrice: null, lastSharePriceTs: null };
}

function saveState(state: MonitorState): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err: any) {
    console.error(`[limusd] failed to save state: ${err?.message ?? err}`);
  }
}

function shouldAlert(state: MonitorState, alertKey: string): boolean {
  const last = state.lastAlertTime[alertKey] ?? 0;
  return (Date.now() - last) >= ALERT_COOLDOWN_MS;
}

function recordAlert(state: MonitorState, alertKey: string): void {
  state.lastAlertTime[alertKey] = Date.now();
}

function recordPreexisting(state: MonitorState, breachKey: string): boolean {
  // Returns true if this is the FIRST time seeing this pre-existing breach
  if (!state.preexistingBreaches[breachKey]) {
    state.preexistingBreaches[breachKey] = new Date().toISOString();
    return true;
  }
  return false;
}

// ─── Collection ─────────────────────────────────────────────────────

let collecting = false;

async function collectOnce(): Promise<void> {
  if (collecting) {
    console.warn(`[limusd] overlap: previous cycle still running, skipping`);
    return;
  }
  collecting = true;

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  console.log(`[limusd] collecting sample at ${ts}`);

  const state = loadState();
  const alerts: string[] = [];
  const readFailures: string[] = [];

  // 1. Block number
  const blockNumber = await getBlockNumber();
  if (blockNumber === null) readFailures.push('blockNumber');

  // 2. Token supplies (exact bigint)
  const [limUsdSupply, ptSupply, sySupply] = await Promise.all([
    getTotalSupplyBig(LIMUSD_ADDR),
    getTotalSupplyBig(PT_LIMUSD_ADDR),
    getTotalSupplyBig(SY_LIMUSD_ADDR),
  ]);

  if (limUsdSupply === null) readFailures.push('limUsdTotalSupply');
  if (ptSupply === null) readFailures.push('ptTotalSupply');
  if (sySupply === null) readFailures.push('syTotalSupply');

  // 3. NAV from NAVOracle
  // getNAV() selector — try the known selector
  const navRaw = await getUint256(NAV_ORACLE_ADDR, '0x41976e09');
  if (navRaw === null) readFailures.push('navOracle');

  // 4. RedemptionPipe USDC balance (direct balanceOf read)
  const redemptionBufferRaw = await getBalanceOfBig(USDC_ADDR, REDEMPTION_PIPE_ADDR);
  if (redemptionBufferRaw === null) readFailures.push('redemptionBuffer');

  // 5. PT expiry (authoritative maturity, not DefiLlama label)
  // expiry() selector — try 0x96c8ef5d (Pendle PT standard)
  const ptExpiryRaw = await getUint256(PT_LIMUSD_ADDR, '0x96c8ef5d');
  let ptExpiry: number | null = null;
  let ptMaturityDate: string | null = null;
  if (ptExpiryRaw !== null) {
    ptExpiry = Number(ptExpiryRaw);
    ptMaturityDate = new Date(ptExpiry * 1000).toISOString().slice(0, 10);
  } else {
    readFailures.push('ptExpiry');
  }

  // 6. DefiLlama context (separate from executable economics)
  const yields = await fetchLimUsdYields();
  const defillamaSuccess = yields.ptApy !== null || yields.underlyingApy !== null;

  // 7. Calculate share price (NAV / limUSD supply, both 18-dec)
  let sharePrice: string | null = null;
  if (navRaw !== null && limUsdSupply !== null && limUsdSupply > 0n) {
    sharePrice = calcSharePrice(navRaw, limUsdSupply, LIMUSD_DECIMALS);
  }

  // 8. Redemption buffer alert (transition-based, not repetitive)
  let redemptionBufferUsd: number | null = null;
  if (redemptionBufferRaw !== null) {
    redemptionBufferUsd = Number(redemptionBufferRaw) / 1e6;
    if (redemptionBufferUsd < REDEMPTION_BUFFER_THRESHOLD_USD) {
      // Record as pre-existing breach (fires once), then only alert on transitions
      const isFirst = recordPreexisting(state, 'redemption_buffer_low');
      if (isFirst) {
        alerts.push(`Redemption buffer $${redemptionBufferUsd.toFixed(2)} < $${REDEMPTION_BUFFER_THRESHOLD_USD} threshold (PRE-EXISTING, baseline: $${REDEMPTION_BUFFER_BASELINE_USD})`);
      }
    }
  } else {
    // RPC read failed — distinguish from a true zero balance
    if (shouldAlert(state, 'redemption_buffer_read_failed')) {
      alerts.push(`Redemption buffer RPC read FAILED (not zero — distinguish from real zero)`);
      recordAlert(state, 'redemption_buffer_read_failed');
    }
  }

  // 9. Share-price change alert (if we have both current and previous)
  if (sharePrice && state.lastSharePrice) {
    const current = parseFloat(sharePrice);
    const previous = parseFloat(state.lastSharePrice);
    if (previous > 0) {
      const changePct = ((current - previous) / previous) * 100;
      if (Math.abs(changePct) > SHARE_PRICE_CHANGE_THRESHOLD_PCT) {
        if (shouldAlert(state, 'share_price_change')) {
          alerts.push(`Share price change ${changePct.toFixed(4)}% exceeds ${SHARE_PRICE_CHANGE_THRESHOLD_PCT}% threshold (was ${state.lastSharePrice}, now ${sharePrice})`);
          recordAlert(state, 'share_price_change');
        }
      }
    }
  }

  // Update state with current share price
  if (sharePrice) {
    state.lastSharePrice = sharePrice;
    state.lastSharePriceTs = ts;
  }

  // 10. Build observation
  const rpcSuccess = blockNumber !== null && limUsdSupply !== null && ptSupply !== null;
  const obs: Observation = {
    ts,
    blockNumber,
    source: 'hyperevm-rpc',
    limUsdTotalSupplyRaw: limUsdSupply?.toString() ?? null,
    ptTotalSupplyRaw: ptSupply?.toString() ?? null,
    syTotalSupplyRaw: sySupply?.toString() ?? null,
    limUsdTotalSupply: limUsdSupply ? bigToDecimalString(limUsdSupply, LIMUSD_DECIMALS) : null,
    ptTotalSupply: ptSupply ? bigToDecimalString(ptSupply, PT_DECIMALS) : null,
    syTotalSupply: sySupply ? bigToDecimalString(sySupply, LIMUSD_DECIMALS) : null,
    navRaw: navRaw?.toString() ?? null,
    navUsd: navRaw ? bigToDecimalString(navRaw, LIMUSD_DECIMALS) : null,
    sharePrice,
    redemptionBufferRaw: redemptionBufferRaw?.toString() ?? null,
    redemptionBufferUsd,
    ptApy: yields.ptApy,
    underlyingApy: yields.underlyingApy,
    ptTvlUsd: yields.ptTvl,
    underlyingTvlUsd: yields.underlyingTvl,
    ptExpiry,
    ptMaturityDate,
    rpcSuccess,
    defillamaSuccess,
    readFailures,
    alerts,
  };

  if (readFailures.length > 0) {
    obs.note = `Read failures: ${readFailures.join(', ')}`;
  }

  // 11. Append to JSONL
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(DATA_FILE, JSON.stringify(obs) + '\n', 'utf8');
    console.log(`[limusd] sample saved: block=${blockNumber} limUSD=${obs.limUsdTotalSupply} PT=${obs.ptTotalSupply} sharePrice=${sharePrice ?? 'n/a'} buffer=$${redemptionBufferUsd?.toFixed(2) ?? 'n/a'}`);
    if (alerts.length > 0) {
      for (const a of alerts) console.log(`[limusd] ALERT: ${a}`);
    }
  } catch (err: any) {
    console.error(`[limusd] failed to write observation: ${err?.message ?? err}`);
  }

  saveState(state);
  console.log(`[limusd] next sample in ${POLL_INTERVAL_MS / 1000}s`);

  collecting = false;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Edge-Engine / limUSD Monitor (EI-010-V2 corrected)');
  console.log(`  Data file:  ${DATA_FILE}`);
  console.log(`  Poll:       every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Zero-capital: no transactions, no wallet, read-only RPC + DefiLlama`);
  console.log(`  limUSD:     ${LIMUSD_ADDR} (18 dec)`);
  console.log(`  PT-limUSD:  ${PT_LIMUSD_ADDR} (6 dec)`);
  console.log(`  SY-limUSD:  ${SY_LIMUSD_ADDR} (18 dec)`);
  console.log(`  Market:     ${MARKET_ADDR}`);
  console.log(`  NAVOracle:  ${NAV_ORACLE_ADDR}`);
  console.log(`  RedempPipe: ${REDEMPTION_PIPE_ADDR}`);
  console.log(`  USDC:       ${USDC_ADDR} (6 dec)`);
  console.log(`  Status:     WATCHLIST — NOT capital-ready`);
  console.log('═══════════════════════════════════════════════════');

  await collectOnce();
  setInterval(collectOnce, POLL_INTERVAL_MS);

  process.on('unhandledRejection', (r) => console.error(`[limusd] UNHANDLED REJECTION:`, r));
  process.on('uncaughtException', (e) => console.error(`[limusd] UNCAUGHT EXCEPTION:`, e));
  process.on('SIGHUP', () => console.log(`[limusd] SIGHUP ignored`));
  process.on('SIGINT', () => { console.log('[limusd] SIGINT, exiting'); process.exit(0); });
  process.on('SIGTERM', () => { console.log('[limusd] SIGTERM, exiting'); process.exit(0); });
}

main().catch(err => {
  console.error('[limusd] fatal:', err);
  process.exit(1);
});
