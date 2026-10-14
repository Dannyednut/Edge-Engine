/**
 * limUSD Monitor — Read-Only Zero-Capital Sampler (MVP)
 * ─────────────────────────────────────────────────────────────────────
 * Purpose:
 *   Implements EI-010-M1: read-only monitoring of the PT-LIMUSD fixed
 *   yield instrument on HyperEVM (chain 999). No trading, no execution,
 *   no wallet access — only public on-chain reads and DefiLlama API.
 *
 * Verified contract identities (on-chain probe, 2026-10-14 07:30Z):
 *   - PT-limUSD-26NOV2026: 0x1822bd335489d84abdd0779a7dcaeda0625e83c8
 *     (18 decimals, name="limUSD", symbol="limUSD", totalSupply ~8.49e24)
 *   - SY-limUSD: 0xcf6b4c156f51818922b98524dc832e352f40d516
 *     (18 decimals, name="SY limUSD", symbol="SY-limUSD")
 *   - Pendle PT market: 0x6b7cea9d070bbffd8205f256897319139cdef399
 *     (6 decimals, name="PT limUSD 26NOV2026")
 *   - Maturity: 26 NOV 2026 (from DefiLlama poolMeta)
 *
 *   NOTE: The actual LIMUSD underlying token address is NOT directly
 *   available — the Pendle API returns 404 for chain 999, and the SY
 *   token doesn't expose standard ERC4626 methods. The DefiLlama
 *   underlyingTokens field shows the USDC address (0xb883...) which is
 *   the backing asset, not LIMUSD itself. The LIMUSD token address
 *   remains UNVERIFIED — this is an explicit blocker documented in
 *   EI-S004 §6.4.
 *
 * What this sampler collects:
 *   1. PT-limUSD total supply (on-chain)
 *   2. SY-limUSD total supply (on-chain)
 *   3. DefiLlama APY for PT-LIMUSD and underlying LIMUSD
 *   4. Current block number and timestamp
 *   5. Data-source success/failure for each read
 *
 * Alert thresholds (from registry):
 *   - Share-price change > 0.5% per day
 *   - Redemption buffer < $50,000 (reported as zero at EI-S005 snapshot)
 *
 *   NOTE: Share-price and redemption buffer require the LIMUSD token
 *   contract address, which is UNVERIFIED. The sampler records what it
 *   CAN verify (supply, APY, block) and explicitly flags the missing
 *   data rather than guessing.
 *
 * Stateful deduplication:
 *   Alerts use a 1-hour cooldown per alert type to prevent spam.
 *   The redemption-buffer baseline is recorded as zero (per EI-S005)
 *   and will only alert once when the buffer remains below $50k.
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

// Verified contract addresses (on-chain probe, 2026-10-14)
const PT_LIMUSD_ADDR = '0x1822bd335489d84abdd0779a7dcaeda0625e83c8';
const SY_LIMUSD_ADDR = '0xcf6b4c156f51818922b98524dc832e352f40d516';

// Alert thresholds (from registry)
const SHARE_PRICE_CHANGE_THRESHOLD_PCT = 0.5;  // per day — referenced in alerts below
const REDEMPTION_BUFFER_THRESHOLD_USD = 50_000;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Baseline: redemption buffer reported as zero at EI-S005 snapshot.
// Recorded for documentation — the buffer is currently UNVERIFIABLE
// because the LIMUSD token address is unknown.
const REDEMPTION_BUFFER_BASELINE_USD = 0;

interface Observation {
  ts: string;              // ISO 8601 UTC
  blockNumber: number | null;
  source: 'hyperevm-rpc' | 'defillama';
  ptLimUsdTotalSupply: number | null;
  syLimUsdTotalSupply: number | null;
  ptApy: number | null;
  underlyingApy: number | null;
  ptTvlUsd: number | null;
  underlyingTvlUsd: number | null;
  redemptionBufferUsd: number | null;  // null = unverifiable (no contract address)
  sharePriceChangePct: number | null; // null = unverifiable
  rpcSuccess: boolean;
  defillamaSuccess: boolean;
  alerts: string[];
  note?: string;
}

interface MonitorState {
  lastAlertTime: Record<string, number>;
  lastSharePrice: number | null;
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

async function getTotalSupply(addr: string): Promise<number | null> {
  // totalSupply() = 0x18160ddd
  const result = await ethCall(addr, '0x18160ddd');
  if (!result) return null;
  const val = parseInt(result.slice(0, 66), 16);
  return isFinite(val) ? val : null;
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
  return { lastAlertTime: {}, lastSharePrice: null, lastSharePriceTs: null };
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

// ─── Collection ─────────────────────────────────────────────────────

async function collectOnce(): Promise<void> {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  console.log(`[limusd] collecting sample at ${ts}`);

  const state = loadState();
  const alerts: string[] = [];

  // 1. On-chain reads
  const [blockNumber, ptSupply, sySupply] = await Promise.all([
    getBlockNumber(),
    getTotalSupply(PT_LIMUSD_ADDR),
    getTotalSupply(SY_LIMUSD_ADDR),
  ]);
  const rpcSuccess = blockNumber !== null && ptSupply !== null;

  // 2. DefiLlama reads
  const yields = await fetchLimUsdYields();
  const defillamaSuccess = yields.ptApy !== null || yields.underlyingApy !== null;

  // 3. Redemption buffer — UNVERIFIABLE without the LIMUSD token address
  //    The Pendle API returns 404 for chain 999, and we cannot find the
  //    LIMUSD token contract. Record as null (not zero) to distinguish
  //    "missing data" from "buffer is zero".
  //    When the LIMUSD token address is verified, this will be replaced
  //    with an on-chain read of the RedemptionPipe USDC buffer balance.
  let redemptionBufferUsd: number | null = null;

  // Alert: redemption buffer below threshold (only if we could measure it)
  // Since we CANNOT measure it, we record the baseline and note the blocker.
  if (redemptionBufferUsd !== null && redemptionBufferUsd < REDEMPTION_BUFFER_THRESHOLD_USD) {
    const bufVal: number = redemptionBufferUsd;
    if (shouldAlert(state, 'redemption_buffer_low')) {
      alerts.push(`Redemption buffer $${bufVal.toFixed(0)} < $${REDEMPTION_BUFFER_THRESHOLD_USD} threshold (baseline: $${REDEMPTION_BUFFER_BASELINE_USD})`);
      recordAlert(state, 'redemption_buffer_low');
    }
  } else if (redemptionBufferUsd === null) {
    // Only alert once per cooldown that the buffer is unverifiable
    if (shouldAlert(state, 'redemption_buffer_unverifiable')) {
      alerts.push(`Redemption buffer UNVERIFIABLE — LIMUSD token address unknown, Pendle API 404 for chain 999. Baseline from EI-S005: $${REDEMPTION_BUFFER_BASELINE_USD}`);
      recordAlert(state, 'redemption_buffer_unverifiable');
    }
  }

  // 4. Share-price change — UNVERIFIABLE without the LIMUSD token address
  //    We track PT supply as a proxy, but supply ≠ share price.
  //    When the LIMUSD token address is verified, this will compute
  //    the actual share-price change vs the previous sample.
  //    Threshold: SHARE_PRICE_CHANGE_THRESHOLD_PCT (0.5% per day)
  let sharePriceChangePct: number | null = null;
  if (sharePriceChangePct !== null && Math.abs(sharePriceChangePct) > SHARE_PRICE_CHANGE_THRESHOLD_PCT) {
    if (shouldAlert(state, 'share_price_change')) {
      const spc: number = sharePriceChangePct;
      alerts.push(`Share price change ${spc.toFixed(2)}% exceeds ${SHARE_PRICE_CHANGE_THRESHOLD_PCT}% threshold`);
      recordAlert(state, 'share_price_change');
    }
  }

  // 5. Build observation
  const obs: Observation = {
    ts,
    blockNumber,
    source: 'hyperevm-rpc',
    ptLimUsdTotalSupply: ptSupply,
    syLimUsdTotalSupply: sySupply,
    ptApy: yields.ptApy,
    underlyingApy: yields.underlyingApy,
    ptTvlUsd: yields.ptTvl,
    underlyingTvlUsd: yields.underlyingTvl,
    redemptionBufferUsd,
    sharePriceChangePct,
    rpcSuccess,
    defillamaSuccess,
    alerts,
  };

  if (!rpcSuccess) obs.note = 'RPC read failed — on-chain data incomplete';
  if (!defillamaSuccess) obs.note = (obs.note ?? '') + ' DefiLlama read failed';

  // 6. Append to JSONL
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(DATA_FILE, JSON.stringify(obs) + '\n', 'utf8');
    console.log(`[limusd] sample saved: block=${blockNumber} ptSupply=${ptSupply} ptApy=${yields.ptApy?.toFixed(2) ?? 'n/a'}%`);
    if (alerts.length > 0) {
      for (const a of alerts) console.log(`[limusd] ALERT: ${a}`);
    }
  } catch (err: any) {
    console.error(`[limusd] failed to write observation: ${err?.message ?? err}`);
  }

  saveState(state);
  console.log(`[limusd] next sample in ${POLL_INTERVAL_MS / 1000}s`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Edge-Engine / limUSD Monitor (read-only MVP)');
  console.log(`  Data file:  ${DATA_FILE}`);
  console.log(`  Poll:       every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Zero-capital: no transactions, no wallet, read-only RPC + DefiLlama`);
  console.log(`  PT-limUSD:  ${PT_LIMUSD_ADDR}`);
  console.log(`  SY-limUSD:  ${SY_LIMUSD_ADDR}`);
  console.log(`  Maturity:   26 NOV 2026 (UNVERIFIED redemption)`);
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
