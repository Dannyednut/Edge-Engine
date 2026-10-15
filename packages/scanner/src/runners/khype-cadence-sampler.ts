/**
 * kHYPE On-Chain Cadence Sampler
 * ─────────────────────────────────────────────────────────────────────
 * Purpose:
 *   Collects on-chain reward-cadence evidence per the EI-001-E2 protocol.
 *   This is the sampler that can actually classify the kHYPE reward-credit
 *   cadence — unlike the DefiLlama collector which only tracks yield APY.
 *
 *   At each 30-minute interval, records:
 *     - UTC timestamp and block number
 *     - Accountant.totalRewards() (exact bigint)
 *     - kHYPEToHYPE(1e18) anchor exchange rate from Accountant (exact bigint)
 *     - Accountant.totalStaked() (exact bigint)
 *     - kHYPE.totalSupply() (exact bigint)
 *     - Changes in anchor and reward accumulator since previous sample
 *     - Per-field RPC read failures
 *     - Reward-step detection (fires when totalRewards changes)
 *
 * Cadence classification:
 *   UNRESOLVED until ≥3 distinct reward-step timestamps are observed.
 *   Do NOT infer cadence from a period of stability or microscopic drift.
 *   The sampler records evidence but does NOT classify — classification
 *   requires manual review against the pre-registered decision rule.
 *
 * Contracts (EI-S006 verified):
 *   Accountant:      0x9209648Ec9D448EF57116B73A2f081835643dc7A
 *   StakingManager:  0x393D0B87Ed38fc779FD9611144aE649BA6082109
 *   kHYPE token:     0xfD739d4e423301CE9385c1fb8850539D657C296D
 *
 * Selectors (keccak256-verified):
 *   totalRewards()       = 0x0e15561a  (on Accountant)
 *   kHYPEToHYPE(uint256) = 0x759bc2fc  (on Accountant, NOT StakingManager)
 *   totalStaked()        = 0x817b1cd2  (on Accountant)
 *   totalSupply()        = 0x18160ddd  (on kHYPE token)
 *
 * Zero-capital: no transactions, no wallet, read-only public RPC.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
const DATA_DIR = resolve(REPO_ROOT, 'data', 'khope-study');
const DATA_FILE = resolve(DATA_DIR, 'cadence-observations.jsonl');
const STATE_FILE = resolve(DATA_DIR, 'cadence-state.json');

const POLL_INTERVAL_MS = Number(process.env.KHYPE_CADENCE_POLL_SEC ?? 1800) * 1000; // 30 min

// ─── Verified contract identities (EI-S006) ────────────────────────
export const ACCOUNTANT_ADDR     = '0x9209648Ec9D448EF57116B73A2f081835643dc7A';
export const STAKING_MANAGER_ADDR = '0x393D0B87Ed38fc779FD9611144aE649BA6082109';
export const KHYPE_TOKEN_ADDR    = '0xfD739d4e423301CE9385c1fb8850539D657C296D';

// ─── Function selectors (keccak256-verified) ───────────────────────
// Exported so tests can verify without duplicating literals.
export const TOTAL_REWARDS_SELECTOR   = '0x0e15561a';  // totalRewards() on Accountant
export const KHYPE_TO_HYPE_SELECTOR   = '0x759bc2fc';  // kHYPEToHYPE(uint256) on Accountant
export const TOTAL_STAKED_SELECTOR    = '0x817b1cd2';  // totalStaked() on Accountant
export const TOTAL_SUPPLY_SELECTOR    = '0x18160ddd';  // totalSupply() on kHYPE token

const ONE_E18 = 10n ** 18n; // 1e18 as bigint (for kHYPEToHYPE arg)

interface Observation {
  ts: string;              // ISO 8601 UTC
  blockNumber: number | null;
  source: 'hyperevm-rpc';
  // Raw bigint values as strings (exact, no precision loss)
  totalRewardsRaw: string | null;     // Accountant.totalRewards() — 18-dec HYPE
  khypeToHypeRaw: string | null;      // Accountant.kHYPEToHYPE(1e18) — returns 1e18-scaled rate
  totalStakedRaw: string | null;      // Accountant.totalStaked() — 18-dec HYPE
  khypeTotalSupplyRaw: string | null; // kHYPE.totalSupply() — 18-dec kHYPE
  // Derived display values (18-decimal adjusted)
  totalRewards: string | null;        // e.g. "571007.910688"
  anchorExchangeRate: string | null;  // e.g. "1.026452220069944" (raw / 1e18)
  totalStaked: string | null;
  khypeTotalSupply: string | null;
  // Changes since previous sample
  totalRewardsDelta: string | null;   // change in totalRewards (null = first sample)
  anchorDelta: string | null;         // change in anchor exchange rate
  rewardStepDetected: boolean;        // true if totalRewards POSITIVE non-zero delta
  negativeDeltaAnomaly: boolean;      // true if totalRewards decreased (anomaly, not a reward step)
  secsSincePrevSample: number | null; // seconds since previous observation (null = first)
  // Data-source success — all 4 reads must succeed for rpcSuccess=true
  rpcSuccess: boolean;                // true only if ALL on-chain reads succeeded
  readFailures: string[];
  note?: string;
}

interface CadenceState {
  lastTotalRewards: string | null;
  lastAnchor: string | null;
  lastTs: string | null;              // previous observation timestamp (for secsSincePrevSample)
  rewardStepCount: number;           // cumulative count of detected steps (only positive deltas)
  lastObservationAppended: boolean;  // true only if the last observation was successfully written
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

async function getUint256(addr: string, selector: string): Promise<bigint | null> {
  const result = await ethCall(addr, selector);
  if (!result) return null;
  try {
    return BigInt(result);
  } catch {
    return null;
  }
}

async function getUint256WithArg(addr: string, selector: string, arg: bigint): Promise<bigint | null> {
  const data = selector + arg.toString(16).padStart(64, '0');
  const result = await ethCall(addr, data);
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

// ─── State management ───────────────────────────────────────────────

function loadState(): CadenceState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return { lastTotalRewards: null, lastAnchor: null, lastTs: null, rewardStepCount: 0, lastObservationAppended: false };
}

function saveState(state: CadenceState): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err: any) {
    console.error(`[khype-cadence] failed to save state: ${err?.message ?? err}`);
  }
}

// ─── Production commit helper (exported for DI testing) ────────────

/** Staged cadence state to be committed after a successful observation append. */
export interface StagedCadenceState {
  lastTotalRewards: string | null;
  lastAnchor: string | null;
  lastTs: string;
  rewardStep: boolean;  // true if a reward step was detected (positive delta)
}

/** Type of the append function — injectable for testing. */
export type CadenceAppendFn = (obs: Observation) => void;

/** Default production append function. */
const defaultCadenceAppend: CadenceAppendFn = (obs: Observation) => {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(DATA_FILE, JSON.stringify(obs) + '\n', 'utf8');
};

/**
 * Commit a cadence observation and its staged state.
 *
 * Production commit path — tests inject a failing appendFn to verify
 * that failed writes do not advance rewardStepCount, lastTotalRewards,
 * lastAnchor, or lastTs.
 *
 * @returns true if committed, false if append failed.
 */
export function commitCadenceObservation(
  state: CadenceState,
  obs: Observation,
  staged: StagedCadenceState,
  appendFn: CadenceAppendFn = defaultCadenceAppend,
  saveStateFn: (s: CadenceState) => void = saveState,
): boolean {
  let appendSuccess = false;
  try {
    appendFn(obs);
    appendSuccess = true;
    console.log(`[khype-cadence] sample saved: block=${obs.blockNumber} totalRewards=${obs.totalRewards} anchor=${obs.anchorExchangeRate} step=${obs.rewardStepDetected} secsSincePrev=${obs.secsSincePrevSample}`);
  } catch (err: any) {
    console.error(`[khype-cadence] failed to write observation: ${err?.message ?? err}`);
  }

  if (appendSuccess) {
    state.lastTotalRewards = staged.lastTotalRewards;
    state.lastAnchor = staged.lastAnchor;
    state.lastTs = staged.lastTs;
    if (staged.rewardStep) {
      state.rewardStepCount++;
      console.log(`[khype-cadence] reward step committed (cumulative: ${state.rewardStepCount})`);
    }
    state.lastObservationAppended = true;
    saveStateFn(state);
  } else {
    // Append failed — do NOT advance any observation state.
    // lastObservationAppended is set to false in memory for the current
    // cycle's audit trail but is NOT persisted (no saveStateFn call).
    // This means:
    //   - On restart, lastObservationAppended reverts to its last-persisted value
    //   - The failure is visible in the process log but not in the state file
    //   - No counters, timestamps, or baselines are advanced
    // This is an explicit, tested contract: a failed append has ZERO effect
    // on persisted state. The in-memory false is ephemeral and does not
    // survive a restart.
    state.lastObservationAppended = false;
    // Do NOT call saveStateFn — nothing to persist on failure
  }

  return appendSuccess;
}

// ─── Collection ─────────────────────────────────────────────────────

let collecting = false;

async function collectOnce(): Promise<void> {
  if (collecting) {
    console.warn(`[khype-cadence] overlap: previous cycle still running, skipping`);
    return;
  }
  collecting = true;

  try {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    console.log(`[khype-cadence] collecting sample at ${ts}`);

    const state = loadState();
    const readFailures: string[] = [];

    // 1. Block number
    const blockNumber = await getBlockNumber();
    if (blockNumber === null) readFailures.push('blockNumber');

    // 2. On-chain reads (all from Accountant except kHYPE totalSupply)
    const [totalRewards, anchorRate, totalStaked, khypeSupply] = await Promise.all([
      getUint256(ACCOUNTANT_ADDR, TOTAL_REWARDS_SELECTOR),
      getUint256WithArg(ACCOUNTANT_ADDR, KHYPE_TO_HYPE_SELECTOR, ONE_E18),
      getUint256(ACCOUNTANT_ADDR, TOTAL_STAKED_SELECTOR),
      getUint256(KHYPE_TOKEN_ADDR, TOTAL_SUPPLY_SELECTOR),
    ]);

    if (totalRewards === null) readFailures.push('totalRewards');
    if (anchorRate === null) readFailures.push('khypeToHype');
    if (totalStaked === null) readFailures.push('totalStaked');
    if (khypeSupply === null) readFailures.push('khypeTotalSupply');

    // 3. Calculate deltas from previous sample
    let totalRewardsDelta: string | null = null;
    let anchorDelta: string | null = null;
    let rewardStepDetected = false;
    let negativeDeltaAnomaly = false;
    let secsSincePrevSample: number | null = null;

    // Calculate secs since previous sample
    if (state.lastTs) {
      const prevMs = new Date(state.lastTs).getTime();
      const currMs = new Date(ts).getTime();
      secsSincePrevSample = Math.round((currMs - prevMs) / 1000);
    }

    if (totalRewards !== null && state.lastTotalRewards !== null) {
      const prev = BigInt(state.lastTotalRewards);
      const delta = totalRewards - prev;
      totalRewardsDelta = delta.toString();
      if (delta > 0n) {
        // Positive delta = reward credit (a reward step)
        rewardStepDetected = true;
        // STAGE the step count — do NOT mutate state.rewardStepCount yet.
        // It will be committed only after the JSONL append succeeds.
        // (EI-S008 P1: state-commit ordering fix)
        console.log(`[khype-cadence] REWARD STEP DETECTED (pending commit): delta=${bigToDecimalString(delta, 18)} HYPE (staged count: ${state.rewardStepCount + 1})`);
      } else if (delta < 0n) {
        // Negative delta = anomaly (totalRewards should only increase)
        // Do NOT count as a reward step — flag as anomaly
        negativeDeltaAnomaly = true;
        console.warn(`[khype-cadence] ANOMALY: totalRewards decreased by ${bigToDecimalString(-delta, 18)} HYPE (not a reward step)`);
      }
      // delta === 0n: no change, no step, no anomaly
    }

    if (anchorRate !== null && state.lastAnchor !== null) {
      const prev = BigInt(state.lastAnchor);
      const delta = anchorRate - prev;
      anchorDelta = delta.toString();
    }

    // 4. Build observation (rpcSuccess = ALL 4 reads succeeded, not just block+rewards)
    const rpcSuccess = blockNumber !== null && totalRewards !== null && anchorRate !== null
                       && totalStaked !== null && khypeSupply !== null;
    const obs: Observation = {
      ts,
      blockNumber,
      source: 'hyperevm-rpc',
      totalRewardsRaw: totalRewards?.toString() ?? null,
      khypeToHypeRaw: anchorRate?.toString() ?? null,
      totalStakedRaw: totalStaked?.toString() ?? null,
      khypeTotalSupplyRaw: khypeSupply?.toString() ?? null,
      totalRewards: totalRewards ? bigToDecimalString(totalRewards, 18) : null,
      anchorExchangeRate: anchorRate ? bigToDecimalString(anchorRate, 18) : null,
      totalStaked: totalStaked ? bigToDecimalString(totalStaked, 18) : null,
      khypeTotalSupply: khypeSupply ? bigToDecimalString(khypeSupply, 18) : null,
      totalRewardsDelta,
      anchorDelta,
      rewardStepDetected,
      negativeDeltaAnomaly,
      secsSincePrevSample,
      rpcSuccess,
      readFailures,
    };

    if (readFailures.length > 0) {
      obs.note = `Read failures: ${readFailures.join(', ')}`;
    }

    // 5. Commit observation + staged state via the production commit helper.
    // (EI-S008 P1: commitCadenceObservation handles append-then-commit ordering.)
    const staged: StagedCadenceState = {
      lastTotalRewards: totalRewards?.toString() ?? state.lastTotalRewards,
      lastAnchor: anchorRate?.toString() ?? state.lastAnchor,
      lastTs: ts,
      rewardStep: rewardStepDetected,
    };
    commitCadenceObservation(state, obs, staged);

    console.log(`[khype-cadence] next sample in ${POLL_INTERVAL_MS / 1000}s`);

  } finally {
    // ALWAYS reset the overlap flag, even if an unexpected throw occurred.
    collecting = false;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Edge-Engine / kHYPE On-Chain Cadence Sampler');
  console.log(`  Data file:  ${DATA_FILE}`);
  console.log(`  Poll:       every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Zero-capital: no transactions, no wallet, read-only RPC`);
  console.log(`  Accountant: ${ACCOUNTANT_ADDR}`);
  console.log(`  StakingMgr: ${STAKING_MANAGER_ADDR}`);
  console.log(`  kHYPE:      ${KHYPE_TOKEN_ADDR}`);
  console.log(`  Selectors:  totalRewards=${TOTAL_REWARDS_SELECTOR}`);
  console.log(`              kHYPEToHYPE=${KHYPE_TO_HYPE_SELECTOR}`);
  console.log(`              totalStaked=${TOTAL_STAKED_SELECTOR}`);
  console.log(`              totalSupply=${TOTAL_SUPPLY_SELECTOR}`);
  console.log(`  Cadence:    UNRESOLVED until ≥3 distinct reward-step timestamps`);
  console.log('═══════════════════════════════════════════════════');

  await collectOnce();
  setInterval(collectOnce, POLL_INTERVAL_MS);

  process.on('unhandledRejection', (r) => console.error(`[khype-cadence] UNHANDLED REJECTION:`, r));
  process.on('uncaughtException', (e) => console.error(`[khype-cadence] UNCAUGHT EXCEPTION:`, e));
  process.on('SIGHUP', () => console.log(`[khype-cadence] SIGHUP ignored`));
  process.on('SIGINT', () => { console.log('[khype-cadence] SIGINT, exiting'); process.exit(0); });
  process.on('SIGTERM', () => { console.log('[khype-cadence] SIGTERM, exiting'); process.exit(0); });
}

main().catch(err => {
  console.error('[khype-cadence] fatal:', err);
  process.exit(1);
});
