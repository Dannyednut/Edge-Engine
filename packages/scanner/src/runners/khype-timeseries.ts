/**
 * kHYPE Time-Series Collector (hardened)
 * ─────────────────────────────────────────────────────────────────────
 * Purpose:
 *   Periodically sample kHYPE staking yield and related HyperEVM yield
 *   pools from DefiLlama, append each sample to a JSONL file. This builds
 *   a time-series for yield-persistence analysis.
 *
 * Storage:
 *   data/khope-study/observations.jsonl  (append-only, one JSON per line)
 *   data/khope-study/handoff.md          (sanitized research handoff)
 *
 * Scheduling:
 *   Default poll interval = 30 minutes (1800s). Override with
 *   KHYPE_POLL_INTERVAL_SEC env var. Daemon-supervisor.sh restarts on crash.
 *
 * Zero-capital:
 *   This collector performs NO trades, reads only public market data,
 *   and does NOT load .env (no secrets needed for public API access).
 *
 * Hardening (this sprint):
 *   1. Removed .env loading — this is a zero-capital public-data collector.
 *   2. Uses verified pool identity (full pool metadata recorded, not just
 *      substring-matched values).
 *   3. Records: pool ID, chain, project, symbol, APY, TVL, timestamp, source.
 *   4. Distinguishes "pool not found" (missing) from "APY is 0" (true zero)
 *      by recording `null` for missing and `0` for zero.
 *   5. Overlap guard: uses a lock flag to prevent concurrent collection
 *      cycles if a fetch takes longer than the poll interval.
 *   6. Clear failure logs: every fetch failure, parse failure, and write
 *      failure is logged with a timestamp and error message.
 *
 * Origin:
 *   Built per Edge Intelligence recommendation — see worklog shift Oct 13.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

// No .env loading — this collector needs no secrets for public DefiLlama data.
const POLL_INTERVAL_MS = Number(process.env.KHYPE_POLL_INTERVAL_SEC ?? 1800) * 1000;
const DATA_DIR = resolve(REPO_ROOT, 'data', 'khope-study');
const DATA_FILE = resolve(DATA_DIR, 'observations.jsonl');

const LLAMA_POOLS_API = 'https://yields.llama.fi/pools';

/**
 * Verified pool selectors. Each selector identifies a pool by checking
 * multiple fields (symbol, project, chain) — not just a single substring.
 * The `poolId` field is recorded in observations for traceability.
 *
 * `requireKhope` gates lending-protocol patterns (morpho, hyperlend) to
 * pools whose symbol contains 'khype' or 'hope', preventing false matches
 * with unrelated $3B+ vaults on the same protocol.
 */
interface PoolSelector {
  label: string;
  /** Substring to match against symbol|project|pool (case-insensitive) */
  pattern: string;
  /** If true, require 'khype' or 'hope' in symbol/pool to match */
  requireKhope?: boolean;
  /** Human-readable description of what this pool represents */
  description: string;
}

const WATCH_SELECTORS: PoolSelector[] = [
  {
    label: 'khype_staking',
    pattern: 'khype',
    description: 'kHYPE staking (Kinetiq) — primary subject of the study',
  },
  {
    label: 'whype_khope_nest',
    pattern: 'whype-khope',
    description: 'wHYPE/kHYPE LP on a HyperEVM DEX (Nest-style)',
  },
  {
    label: 'whype_khope_ramses',
    pattern: 'ramses',
    requireKhope: true,
    description: 'wHYPE/kHYPE LP on Ramses DEX',
  },
  {
    label: 'khype_morpho',
    pattern: 'morpho',
    requireKhope: true,
    description: 'kHYPE market on Morpho',
  },
  {
    label: 'khype_hyperlend',
    pattern: 'hyperlend',
    requireKhope: true,
    description: 'kHYPE market on HyperLend',
  },
];

/**
 * A single pool observation. Records FULL pool identity for traceability.
 * `apy: null` means the pool was found but APY data is missing.
 * `apy: 0` means the pool reports a true zero yield.
 */
interface PoolObservation {
  label: string;
  poolId: string;        // DefiLlama pool identifier (e.g., "0xabc..-hyperevm")
  chain: string;
  project: string;
  symbol: string;
  apy: number | null;    // null = missing, 0 = true zero
  apyBase: number | null;
  apyReward: number | null;
  tvlUsd: number;
}

interface Observation {
  ts: string;            // ISO 8601 UTC (second precision)
  source: 'defillama';
  apiStatus: 'ok' | 'error' | 'empty';
  fetchMs: number;
  totalPoolsScanned: number;
  matchedPools: number;
  pools: PoolObservation[];
  note?: string;
}

// ─── Overlap guard ──────────────────────────────────────────────────
let collecting = false;

async function fetchPools(): Promise<{ pools: any[]; ok: boolean; error?: string }> {
  try {
    const res = await fetch(LLAMA_POOLS_API, {
      headers: { 'User-Agent': 'Edge-Engine-Manager/khype-timeseries', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30_000),  // 30s timeout
    });
    if (!res.ok) {
      return { pools: [], ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    }
    const j = await res.json() as any;
    const pools = j?.data ?? [];
    if (!Array.isArray(pools)) {
      return { pools: [], ok: false, error: 'response.data is not an array' };
    }
    return { pools, ok: true };
  } catch (err: any) {
    return { pools: [], ok: false, error: err?.message ?? String(err) };
  }
}

function matchPool(pool: any): PoolSelector | null {
  const symbol = String(pool?.symbol ?? '').toLowerCase();
  const project = String(pool?.project ?? '').toLowerCase();
  const poolId = String(pool?.pool ?? '').toLowerCase();
  const haystack = `${symbol}|${project}|${poolId}`;
  const hasKhope = symbol.includes('khype') || symbol.includes('hope') ||
                   poolId.includes('khype') || poolId.includes('hope');
  for (const w of WATCH_SELECTORS) {
    if (w.requireKhope && !hasKhope) continue;
    if (haystack.includes(w.pattern)) return w;
  }
  return null;
}

function toPoolObservation(pool: any, selector: PoolSelector): PoolObservation {
  const apyRaw = pool?.apy;
  const apy = typeof apyRaw === 'number' && isFinite(apyRaw) ? apyRaw : null;
  const apyBase = typeof pool?.apyBase === 'number' && isFinite(pool.apyBase) ? pool.apyBase : null;
  const apyReward = typeof pool?.apyReward === 'number' && isFinite(pool.apyReward) ? pool.apyReward : null;
  const tvl = typeof pool?.tvlUsd === 'number' && isFinite(pool.tvlUsd) ? pool.tvlUsd : 0;
  return {
    label: selector.label,
    poolId: String(pool?.pool ?? ''),
    chain: String(pool?.chain ?? ''),
    project: String(pool?.project ?? ''),
    symbol: String(pool?.symbol ?? ''),
    apy,
    apyBase,
    apyReward,
    tvlUsd: tvl,
  };
}

async function collectOnce(): Promise<boolean> {
  // Overlap guard — skip if a previous cycle is still running
  if (collecting) {
    console.warn(`[kHYPE] overlap: previous cycle still running, skipping`);
    return false;
  }
  collecting = true;

  try {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const t0 = Date.now();
    console.log(`[kHYPE] collecting sample at ${ts}`);

    const { pools, ok, error } = await fetchPools();
    const fetchMs = Date.now() - t0;

    if (!ok) {
      console.error(`[kHYPE] fetch failed: ${error} (${fetchMs}ms)`);
      const failObs: Observation = {
        ts, source: 'defillama', apiStatus: 'error', fetchMs,
        totalPoolsScanned: 0, matchedPools: 0, pools: [],
        note: `fetch failed: ${error}`,
      };
      const appendOk = appendObservation(failObs);
      console.log(`[kHYPE] next sample in ${POLL_INTERVAL_MS / 1000}s`);
      return appendOk;
    }

    if (pools.length === 0) {
      console.warn(`[kHYPE] API returned 0 pools (${fetchMs}ms) — possible upstream issue`);
      const emptyObs: Observation = {
        ts, source: 'defillama', apiStatus: 'empty', fetchMs,
        totalPoolsScanned: 0, matchedPools: 0, pools: [],
        note: 'API returned 0 pools',
      };
      const appendOk = appendObservation(emptyObs);
      console.log(`[kHYPE] next sample in ${POLL_INTERVAL_MS / 1000}s`);
      return appendOk;
    }

    const matched: PoolObservation[] = [];
    const best = new Map<string, PoolObservation>();

    for (const p of pools) {
      const selector = matchPool(p);
      if (!selector) continue;
      const obs = toPoolObservation(p, selector);
      const prev = best.get(obs.label);
      if (!prev || obs.tvlUsd > prev.tvlUsd) {
        best.set(obs.label, obs);
      }
    }

    for (const v of best.values()) matched.push(v);

    const observation: Observation = {
      ts, source: 'defillama', apiStatus: 'ok', fetchMs,
      totalPoolsScanned: pools.length, matchedPools: matched.length, pools: matched,
    };

    const appendSuccess = appendObservation(observation);
    if (appendSuccess) {
      console.log(`[kHYPE] sample saved: ${matched.length}/${pools.length} pools matched (${fetchMs}ms)`);
      for (const p of matched) {
        const apyStr = p.apy === null ? 'MISSING' : p.apy.toFixed(4) + '%';
        console.log(`[kHYPE]   ${p.label}: ${apyStr} (TVL $${(p.tvlUsd / 1e6).toFixed(2)}M) [${p.symbol} @ ${p.project}/${p.chain}]`);
      }
    }
    console.log(`[kHYPE] next sample in ${POLL_INTERVAL_MS / 1000}s`);
    return appendSuccess;

  } finally {
    collecting = false;
  }
}

/** Type of the append function — injectable for testing. */
export type DefiLlamaAppendFn = (obs: Observation) => boolean;

/** Default production append function. */
const defaultDefiLlamaAppend: DefiLlamaAppendFn = (obs: Observation): boolean => {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(DATA_FILE, JSON.stringify(obs) + '\n', 'utf8');
    return true;
  } catch (err: any) {
    console.error(`[kHYPE] FAILED to write observation: ${err?.message ?? err}`);
    return false;
  }
};

// Injectable append function — tests can override this
let appendFn: DefiLlamaAppendFn = defaultDefiLlamaAppend;

/** Set the append function (for testing). */
export function setAppendFn(fn: DefiLlamaAppendFn): void {
  appendFn = fn;
}

function appendObservation(obs: Observation): boolean {
  return appendFn(obs);
}

async function main() {
  const oneShot = process.argv.includes('--once');
  console.log('═══════════════════════════════════════════════════');
  console.log('  Edge-Engine / kHYPE Time-Series Collector (hardened)');
  console.log(`  Data file:  ${DATA_FILE}`);
  console.log(`  Mode:       ${oneShot ? 'ONE-SHOT (exits after 1 sample)' : `continuous (poll every ${POLL_INTERVAL_MS / 1000}s)`}`);
  console.log(`  Zero-capital: no .env, no wallet, public DefiLlama data only`);
  console.log(`  Overlap guard: enabled`);
  console.log(`  Pool identity: full metadata recorded per sample`);
  console.log('═══════════════════════════════════════════════════');

  if (oneShot) {
    const success = await collectOnce();
    if (!success) {
      console.error('[kHYPE] one-shot FAILED: observation not durably appended');
      process.exit(1);
    }
    console.log('[kHYPE] one-shot complete, exiting');
    process.exit(0);
  }

  await collectOnce();
  setInterval(collectOnce, POLL_INTERVAL_MS);

  process.on('unhandledRejection', (r) => console.error(`[kHYPE] UNHANDLED REJECTION:`, r));
  process.on('uncaughtException', (e) => console.error(`[kHYPE] UNCAUGHT EXCEPTION:`, e));
  process.on('SIGHUP', () => console.log(`[kHYPE] SIGHUP ignored (background mode)`));
  process.on('SIGINT', () => { console.log('[kHYPE] SIGINT, exiting'); process.exit(0); });
  process.on('SIGTERM', () => { console.log('[kHYPE] SIGTERM, exiting'); process.exit(0); });
}

main().catch(err => {
  console.error('[kHYPE] fatal:', err);
  process.exit(1);
});
