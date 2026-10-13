/**
 * kHYPE Time-Series Collector
 * ─────────────────────────────────────────────────────────────────────
 * Purpose:
 *   Periodically sample kHYPE staking yield and related HyperEVM yield
 *   pools from DefiLlama, append each sample to a JSONL file. This builds
 *   a time-series that lets us answer:
 *     - Is the 1.93% kHYPE yield persistent, or a one-off snapshot?
 *     - How variable is it (daily/weekly)?
 *     - Do correlated pools (whype-khope-nest, ramses, etc.) lead/lag?
 *
 * Storage:
 *   data/khope-study/observations.jsonl  (append-only, one JSON per line)
 *
 * Scheduling:
 *   Default poll interval = 30 minutes (1800s). Override with
 *   KHYPE_POLL_INTERVAL_SEC env var. Daemon-supervisor.sh restarts on crash.
 *
 * Zero-capital:
 *   This collector performs NO trades and reads only public market data.
 *
 * Origin:
 *   Built per Edge Intelligence recommendation — see worklog shift Oct 13.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

// Load .env (so any optional keys are picked up)
try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch { /* .env not present */ }

const POLL_INTERVAL_MS = Number(process.env.KHYPE_POLL_INTERVAL_SEC ?? 1800) * 1000;
const DATA_DIR = resolve(REPO_ROOT, 'data', 'khope-study');
const DATA_FILE = resolve(DATA_DIR, 'observations.jsonl');

const LLAMA_POOLS_API = 'https://yields.llama.fi/pools';

/** Pool identifiers we care about — matched against the 'symbol' and 'project'
 * fields (case-insensitive). Patterns that name a protocol only (morpho,
 * hyperlend) are restricted to pools whose symbol contains 'khype' or 'hope'
 * to avoid false matches with unrelated vaults on the same protocol. */
const WATCH_PATTERNS: { pattern: string; label: string; requireKhope?: boolean }[] = [
  // kHYPE staking — the primary subject of the study
  { pattern: 'khype',       label: 'khype_staking' },
  // wHYPE/kHYPE nest-style LPs on HyperEVM DEXs
  { pattern: 'whype-khope', label: 'whype_khope_nest' },
  { pattern: 'whype-khype', label: 'whype_khope_nest' },
  { pattern: 'hope-khype',  label: 'whype_khope_nest' },
  // Ramses wHYPE/kHYPE pool — Ramses is a HyperEVM DEX, but we still gate on khope
  { pattern: 'ramses',      label: 'whype_khope_ramses', requireKhope: true },
  // kHYPE on lending markets — gate on khope symbol to avoid $3B+ false matches
  { pattern: 'morpho',      label: 'khype_morpho',      requireKhope: true },
  { pattern: 'hyperlend',   label: 'khype_hyperlend',   requireKhope: true },
];

interface Observation {
  ts: string;          // ISO 8601 UTC
  source: 'defillama';
  khype_staking_apy?: number;
  khype_tvl_usd?: number;
  whype_khope_nest_apy?: number;
  whype_khope_nest_tvl?: number;
  whype_khope_ramses_apy?: number;
  whype_khope_ramses_tvl?: number;
  khype_morpho_tvl?: number;
  khype_hyperlend_tvl?: number;
  sample_count: number;
  note?: string;
}

async function fetchPools(): Promise<any[]> {
  try {
    const res = await fetch(LLAMA_POOLS_API, {
      headers: { 'User-Agent': 'Mozilla/5.0 Edge-Engine-Manager', 'Accept': 'application/json' },
    });
    if (!res.ok) {
      console.error(`[kHYPE] DefiLlama returned ${res.status}`);
      return [];
    }
    const j = await res.json() as any;
    return j?.data ?? [];
  } catch (err: any) {
    console.error(`[kHYPE] fetch failed: ${err?.message ?? err}`);
    return [];
  }
}

function matchPool(pool: any): string | null {
  const symbol = String(pool.symbol || '').toLowerCase();
  const project = String(pool.project || '').toLowerCase();
  const poolId = String(pool.pool || '').toLowerCase();
  const haystack = `${symbol}|${project}|${poolId}`;
  const hasKhope = symbol.includes('khype') || symbol.includes('hope') || poolId.includes('khype') || poolId.includes('hope');
  for (const w of WATCH_PATTERNS) {
    if (w.requireKhope && !hasKhope) continue;
    if (haystack.includes(w.pattern)) return w.label;
  }
  return null;
}

async function collectOnce(): Promise<void> {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  console.log(`[kHYPE] collecting sample at ${ts}`);

  const pools = await fetchPools();
  if (pools.length === 0) {
    console.warn(`[kHYPE] no pools returned — skipping this cycle`);
    return;
  }

  const obs: Observation = { ts, source: 'defillama', sample_count: 0 };

  // Track best (highest TVL) pool for each label so we don't double-count
  const best = new Map<string, { apy: number; tvl: number }>();

  for (const p of pools) {
    const label = matchPool(p);
    if (!label) continue;
    const apy = Number(p.apy ?? 0);
    const tvl = Number(p.tvlUsd ?? 0);
    if (!isFinite(apy) || !isFinite(tvl)) continue;

    const prev = best.get(label);
    if (!prev || tvl > prev.tvl) {
      best.set(label, { apy, tvl });
    }
  }

  // Populate observation from best pools
  for (const [label, v] of best.entries()) {
    obs.sample_count++;
    switch (label) {
      case 'khype_staking':
        obs.khype_staking_apy = v.apy;
        obs.khype_tvl_usd = v.tvl;
        break;
      case 'whype_khope_nest':
        obs.whype_khope_nest_apy = v.apy;
        obs.whype_khope_nest_tvl = v.tvl;
        break;
      case 'whype_khope_ramses':
        obs.whype_khope_ramses_apy = v.apy;
        obs.whype_khope_ramses_tvl = v.tvl;
        break;
      case 'khype_morpho':
        obs.khype_morpho_tvl = v.tvl;
        break;
      case 'khype_hyperlend':
        obs.khype_hyperlend_tvl = v.tvl;
        break;
    }
  }

  // Append to JSONL
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(DATA_FILE, JSON.stringify(obs) + '\n', 'utf8');
  console.log(`[kHYPE] sample saved: ${obs.sample_count} pools matched`);
  console.log(`[kHYPE]   kHYPE staking APY: ${obs.khype_staking_apy ?? 'n/a'}% (TVL $${((obs.khype_tvl_usd ?? 0) / 1e6).toFixed(2)}M)`);
  console.log(`[kHYPE]   whype-khope nest: ${obs.whype_khope_nest_apy ?? 'n/a'}% (TVL $${((obs.whype_khope_nest_tvl ?? 0) / 1e6).toFixed(2)}M)`);
  console.log(`[kHYPE] next sample in ${POLL_INTERVAL_MS / 1000}s`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Edge-Engine / kHYPE Time-Series Collector');
  console.log(`  Data file:  ${DATA_FILE}`);
  console.log(`  Poll:       every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Zero-capital research module (no trades, no wallet)`);
  console.log('═══════════════════════════════════════════════════');

  // Collect immediately on startup, then on interval
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
