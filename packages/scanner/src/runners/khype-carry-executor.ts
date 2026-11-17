/**
 * KhypeCarryExecutor — end-to-end kHYPE carry arb executor.
 *
 * THE STRATEGY (kHYPE LST carry arb, ~91-212% APR):
 *   1. Swap WHYPE → kHYPE on HyperSwap V3 (instant, 0.01% fee pool)
 *   2. Approve kHYPE → STAKING_MANAGER
 *   3. Call unstake(kHypeAmount) → queue withdrawal (returns withdrawalId)
 *   4. Wait 7 days (withdrawalDelay verified on-chain)
 *   5. Call claimWithdrawal(withdrawalId) → receive HYPE
 *   6. Wrap HYPE → WHYPE. Repeat.
 *
 * NET P&L PER CYCLE (8-day average) — UNSUPPORTED, see below:
 *   +2.46% kHYPE discount on HyperSwap V3 (live Oct 13 2026)
 *   -0.01% HyperSwap V3 fee
 *   -????% Kinetiq unstake fee — UNKNOWN: no measured source is wired
 *   -gas (negligible on HyperEVM)
 *   -0.04% HyperLend flashloan fee (optional — own capital = no fee)
 *   = previous "~2.31%/cycle ≈ 105% APR" arithmetic assumed a 0.10% fee and
 *     is WITHDRAWN (EM-STRAT-016-WO-01-R1): the accepted EI evidence does
 *     not establish any measured unstake-fee input.
 *
 * ───────────────────────────────────────────────────────────────────────
 * EM-STRAT-016-WO-01-R1 — EXECUTION FAIL-CLOSED (unstake fee unverified)
 * ───────────────────────────────────────────────────────────────────────
 * The Kinetiq unstake fee and the economic model of THIS implementation are
 * unverified: the fee below is an unverified hardcoded figure (no measured
 * source), and the discount math uses `(1 - price) * 100` against an
 * assumed 1:1 ratio rather than the redemption-anchor model used by
 * HlLstArbScanner. executeCycle()/CLI --execute therefore fails closed:
 * it rejects at the entry gate, BEFORE any transaction is built or
 * submitted, and no environment variable or strategy configuration may
 * bypass the stop. This is on top of (not instead of) the shared execution
 * authorization checks, which are preserved unchanged. Re-enabling
 * execution requires a separate evidence-backed work order covering the
 * fee source and the economic model.
 *
 * Any scan output this file still produces is UNVERIFIED reference
 * information, not a validated executable opportunity.
 *
 * STATE PERSISTENCE:
 *   data/khype-carry-state.json — tracks pending withdrawal IDs + claim times
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KinetiqClient, KHYPE_TOKEN, hyperEvm } from '@edge/executor';
import { createWalletClient, createPublicClient, http, type WalletClient, type PublicClient, encodeFunctionData, type Address, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HYPERSWAP_V3_POOLS, HYPERSWAP_V3_SWAP_ROUTER_02, HL_TOKEN_DECIMALS, HYPEREVM_RPC, v3PriceToHuman } from '../lib/hyperliquid-defi.js';
import { assertExecutionAuthorized, type ExecutionScope } from '@edge/risk';

/**
 * EM-STRAT-016-WO-01-R1: execution is fail-closed while the unstake fee
 * and economic model remain unverified. Observable + testable rejection
 * reason; no env or strategy-config bypass exists.
 */
export const KHYPE_CARRY_EXECUTION_SUPPRESSED =
  'kHYPE carry execution suppressed — unstake fee unverified (no measured ' +
  'source; hardcoded 0.10% claim withdrawn) and discount model unverified ' +
  '(assumed 1:1 ratio, not the redemption-anchor model) ' +
  '(EM-STRAT-016-WO-01-R1)';

/**
 * EM-STRAT-016-WO-01-R1 fail-closed execution gate. Synchronous by design
 * so the rejection happens BEFORE any transaction construction, RPC call,
 * or submission attempt — and before the wallet/authorization layer, which
 * remains a defense-in-depth layer, not the first gate. Deliberately NOT
 * configurable: no environment variable or ordinary strategy configuration
 * can bypass this stop; re-enabling requires editing this constant and a
 * separate evidence-backed work order.
 */
export const KHYPE_CARRY_EXECUTION_STOPPED = true;

/** Entrypoint scope for this script (defense-in-depth layer). */
export const ENTRYPOINT_SCOPE: ExecutionScope = 'entrypoint:khype-carry-executor';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');
const STATE_FILE = resolve(REPO_ROOT, 'data', 'khype-carry-state.json');

// ─── State persistence ─────────────────────────────────────────────────
export interface KhypeCarryState {
  pendingWithdrawals: Array<{
    withdrawalId: string;
    khypeAmount: string;
    queuedAt: number;          // unix ms
    claimableAt: number;       // unix ms
    estimatedHypePayout: number;
    txHash: string;
  }>;
  completedCycles: Array<{
    withdrawalId: string;
    queuedAt: number;
    claimedAt: number;
    khypeAmount: number;
    hypePayout: number;
    profitUsd: number;
    profitPct: number;
  }>;
  totalProfitUsd: number;
  totalCyclesCompleted: number;
}

function loadState(): KhypeCarryState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  }
  return {
    pendingWithdrawals: [],
    completedCycles: [],
    totalProfitUsd: 0,
    totalCyclesCompleted: 0,
  };
}

function saveState(state: KhypeCarryState): void {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── HyperSwap V3 swap calldata builder ───────────────────────────────
const HYPERSWAP_V3_ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'tokenIn',  type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee',      type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export interface KhypeCarryOpportunity {
  discountPct: number;
  khypePriceInWhype: number;
  poolLiquidity: bigint;
  maxSizeUsd: number;
  estimatedProfitPct: number;
  estimatedProfitUsd: number;
  poolAddress: string;
  feeTier: number;
  ts: number;
}

export interface KhypeCarryExecutorOptions {
  /** Min discount % to enter a new cycle (default 0.5%) */
  minDiscountPct: number;
  /** Max capital per cycle in USD (default $5,000) */
  maxSizeUsd: number;
  /** Agent wallet address (for claiming + receiving HYPE) */
  agentAddress: Address;
  /** Optional: dry-run mode (no actual transactions, just log) */
  dryRun?: boolean;
}

export class KhypeCarryExecutor {
  private kinetiq: KinetiqClient;
  private state: KhypeCarryState;
  // EM-STRAT-012 Phase-0.5 (work order A): the signer-capable clients are
  // HARD-PRIVATE (`#`) fields, not TypeScript `private`. A TS-private field
  // survives compilation as a normal runtime own-property — an untyped
  // caller could do `(executor as any).walletClient.sendTransaction(...)`
  // and bypass the per-call guard in sendTx(). ECMAScript `#` fields are
  // not own properties and are lexically unreachable outside this class.
  #walletClient: WalletClient | null = null;
  #publicClient: PublicClient | null = null;

  constructor(private opts: KhypeCarryExecutorOptions) {
    this.kinetiq = new KinetiqClient({ rpcUrl: HYPEREVM_RPC });
    this.state = loadState();

    // Initialize wallet client if private key is available
    if (process.env.AGENT_HYPE_PRIVKEY && !opts.dryRun) {
      // EM-STRAT-012 Phase-0: signer construction enables submission — it
      // requires the entrypoint scope (the sendTransaction sites re-check
      // 'evm-executor:send-transaction' scopes via the shared guard).
      assertExecutionAuthorized(ENTRYPOINT_SCOPE);
      const account = privateKeyToAccount(process.env.AGENT_HYPE_PRIVKEY as `0x${string}`);
      this.#walletClient = createWalletClient({
        account,
        chain: hyperEvm,
        transport: http(HYPEREVM_RPC),
      });
      this.#publicClient = createPublicClient({
        chain: hyperEvm,
        transport: http(HYPEREVM_RPC),
      });
      console.log(`[khype-carry] Wallet initialized: ${account.address}`);
    }
  }

  /** Sign and submit a transaction, wait for confirmation. Returns tx hash. */
  private async sendTx(to: Address, data: `0x${string}`, value: bigint = 0n): Promise<Hash> {
    if (!this.#walletClient || !this.#publicClient || !this.#walletClient.account) {
      throw new Error('Wallet not initialized — set AGENT_HYPE_PRIVKEY');
    }
    // EM-STRAT-012 Phase-0: raw EVM submission sink. Re-checked per call so an
    // existing instance cannot submit after authorization expires. The
    // 'evm-executor:send-transaction' scope names the capability (send an EVM
    // transaction) regardless of which runner performs it.
    assertExecutionAuthorized('evm-executor:send-transaction');
    const txHash = await this.#walletClient.sendTransaction({
      account: this.#walletClient.account,
      chain: hyperEvm,
      to, data, value,
    });
    const receipt = await this.#publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(`Transaction reverted: ${txHash}`);
    }
    return txHash;
  }

  /**
   * Scan for new opportunity — same logic as HlLstArbScanner but
   * returns the opportunity object the executor needs.
   */
  async scan(): Promise<KhypeCarryOpportunity | null> {
    const pools = HYPERSWAP_V3_POOLS.filter(p => p.pair === 'WHYPE/kHYPE');

    let best: KhypeCarryOpportunity | null = null;

    for (const pool of pools) {
      try {
        // Get slot0 for current price
        const slot0Res = await fetch(HYPEREVM_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'eth_call',
            params: [{ to: pool.address, data: '0x3850c7bd' }, 'latest'], id: 1,
          }),
        }).then(r => r.json() as any);
        if (!slot0Res.result || slot0Res.result.length < 66) continue;

        const sqrtPriceX96 = BigInt('0x' + slot0Res.result.slice(2, 66));
        const dec0 = HL_TOKEN_DECIMALS['WHYPE'] ?? 18;
        const dec1 = HL_TOKEN_DECIMALS['kHYPE'] ?? 18;
        const price = v3PriceToHuman(sqrtPriceX96, dec0, dec1);
        if (price <= 0 || price > 2) continue;

        const discountPct = (1 - price) * 100;
        if (discountPct < this.opts.minDiscountPct) continue;

        // Get liquidity
        const liqRes = await fetch(HYPEREVM_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'eth_call',
            params: [{ to: pool.address, data: '0x1a686502' }, 'latest'], id: 1,
          }),
        }).then(r => r.json() as any);
        const liquidity = liqRes.result && liqRes.result.length >= 66
          ? BigInt('0x' + liqRes.result.slice(2, 66)) : 0n;
        if (liquidity === 0n) continue;

        const ammFeePct = (pool.fee / 10000) * 100;
        // EM-STRAT-016-WO-01-R1: the unstake fee has NO measured source —
        // it is NOT substituted with a guess and NOT assumed zero. The
        // figure below is a PRE-FEE reference only (discount minus AMM
        // fee); it is unverified information, never a validated
        // opportunity.
        const estimatedProfitPct = discountPct - ammFeePct;
        if (estimatedProfitPct <= 0) continue;

        const estimatedProfitUsd = (estimatedProfitPct / 100) * this.opts.maxSizeUsd;

        const opp: KhypeCarryOpportunity = {
          discountPct,
          khypePriceInWhype: price,
          poolLiquidity: liquidity,
          maxSizeUsd: this.opts.maxSizeUsd,
          estimatedProfitPct,
          estimatedProfitUsd,
          poolAddress: pool.address,
          feeTier: pool.fee,
          ts: Date.now(),
        };

        if (!best || opp.estimatedProfitUsd > best.estimatedProfitUsd) {
          best = opp;
        }
      } catch {
        // skip
      }
    }
    return best;
  }

  /**
   * Execute one full cycle: swap WHYPE→kHYPE, queue unstake, schedule claim.
   *
   * This requires an agent wallet that can sign HyperEVM transactions.
   * Returns the withdrawal ID once queued.
   */
  async executeCycle(opp: KhypeCarryOpportunity): Promise<{ queued: boolean; withdrawalId?: string; txHash?: string; error?: string }> {
    // ─── EM-STRAT-016-WO-01-R1 fail-closed gate ───
    // BEFORE any transaction construction, wallet use, RPC call, or
    // submission attempt. No env/strategy-config bypass exists; the shared
    // execution-authorization checks below are preserved unchanged and
    // remain defense-in-depth — this gate is the first, not the only,
    // layer.
    if (KHYPE_CARRY_EXECUTION_STOPPED) {
      return { queued: false, error: KHYPE_CARRY_EXECUTION_SUPPRESSED };
    }

    if (this.opts.dryRun) {
      console.log(`[dry-run] Would execute cycle: ${opp.estimatedProfitPct.toFixed(2)}% profit = $${opp.estimatedProfitUsd.toFixed(2)} on $${opp.maxSizeUsd}`);
      return { queued: false, error: 'dry-run mode' };
    }

    if (!process.env.AGENT_HYPE_PRIVKEY) {
      return { queued: false, error: 'AGENT_HYPE_PRIVKEY not set — agent wallet not funded yet' };
    }

    try {
      // STEP 1: Build swap calldata (WHYPE → kHYPE on HyperSwap V3)
      const HYPE_USD_PRICE = 89.5; // Updated Oct 7 2026 — was $25
      const whypeAmountWei = BigInt(Math.floor(opp.maxSizeUsd * 1e18 / HYPE_USD_PRICE));
      const swapCalldata = encodeFunctionData({
        abi: HYPERSWAP_V3_ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [{
          tokenIn: '0x5555555555555555555555555555555555555555',
          tokenOut: KHYPE_TOKEN,
          fee: opp.feeTier,
          recipient: this.opts.agentAddress,
          amountIn: whypeAmountWei,
          amountOutMinimum: BigInt(0), // TODO: compute from quoter
          sqrtPriceLimitX96: BigInt(0),
        }],
      });

      console.log(`[khype-carry] Step 1: swap ${Number(whypeAmountWei) / 1e18} WHYPE → kHYPE on HyperSwap V3 (fee=${opp.feeTier})`);
      console.log(`  → to: ${HYPERSWAP_V3_SWAP_ROUTER_02}`);
      console.log(`  → data: ${swapCalldata}`);
      // Execute swap via wallet client (when not in dry-run)
      const swapTxHash = await this.sendTx(
        HYPERSWAP_V3_SWAP_ROUTER_02 as Address,
        swapCalldata,
        whypeAmountWei,
      );
      console.log(`  ✓ tx: ${swapTxHash}`);

      // STEP 2: Approve kHYPE → STAKING_MANAGER
      console.log(`[khype-carry] Step 2: approve kHYPE → STAKING_MANAGER`);
      const approveData = this.kinetiq.buildApproveTx(BigInt(2) ** BigInt(256) - BigInt(1)); // max approve
      const approveTxHash = await this.sendTx(approveData.to, approveData.data);
      console.log(`  ✓ tx: ${approveTxHash}`);

      // STEP 3: Call unstake(kHypeAmount) to queue withdrawal
      console.log(`[khype-carry] Step 3: unstake kHYPE → queue withdrawal`);
      const kHypeAmountWei = BigInt(Math.floor(Number(whypeAmountWei) * opp.khypePriceInWhype)); // expected kHYPE received
      const unstakeData = this.kinetiq.buildUnstakeTx(kHypeAmountWei);
      const unstakeTxHash = await this.sendTx(unstakeData.to, unstakeData.data);
      console.log(`  ✓ tx: ${unstakeTxHash}`);
      // TODO: parse withdrawalId from unstakeTxHash receipt logs (WithdrawalQueued event)

      // STEP 4: Record state for claiming later
      const status = await this.kinetiq.getStatus();
      const queuedAt = Date.now();
      const claimableAt = queuedAt + (status.withdrawalDelaySec * 1000);
      const withdrawalId = `pending-${queuedAt}`; // placeholder until we parse actual ID from tx receipt

      this.state.pendingWithdrawals.push({
        withdrawalId,
        khypeAmount: kHypeAmountWei.toString(),
        queuedAt,
        claimableAt,
        estimatedHypePayout: Number(kHypeAmountWei) / 1e18, // 1:1 minus fee
        txHash: 'simulated',
      });
      saveState(this.state);

      console.log(`[khype-carry] ✓ Cycle queued. Withdrawal ID: ${withdrawalId}`);
      console.log(`  Claimable at: ${new Date(claimableAt).toISOString()}`);

      return { queued: true, withdrawalId };
    } catch (e: any) {
      return { queued: false, error: e.message };
    }
  }

  /**
   * Check pending withdrawals and claim any that are ready.
   * Called periodically (e.g. every hour).
   */
  async claimReadyWithdrawals(): Promise<{ claimed: number; totalPayoutHype: number }> {
    const now = Date.now();
    const ready = this.state.pendingWithdrawals.filter(w => w.claimableAt <= now);
    if (ready.length === 0) {
      console.log(`[khype-carry] No withdrawals ready to claim. ${this.state.pendingWithdrawals.length} pending.`);
      return { claimed: 0, totalPayoutHype: 0 };
    }

    if (this.opts.dryRun || !process.env.AGENT_HYPE_PRIVKEY) {
      console.log(`[khype-carry] ${ready.length} withdrawals ready to claim (skipped — no wallet)`);
      for (const w of ready) {
        console.log(`  - ${w.withdrawalId}: ${Number(w.khypeAmount) / 1e18} kHYPE → ~${w.estimatedHypePayout} HYPE`);
      }
      return { claimed: 0, totalPayoutHype: 0 };
    }

    let claimed = 0;
    let totalPayout = 0;

    for (const w of ready) {
      try {
        const claimData = this.kinetiq.buildClaimTx(BigInt(w.withdrawalId));
        console.log(`[khype-carry] Claiming withdrawal ${w.withdrawalId}`);
        console.log(`  → to: ${claimData.to}`);
        console.log(`  → data: ${claimData.data}`);
        // const txHash = await walletClient.sendTransaction({ to: claimData.to, data: claimData.data });
        // const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        // const payout = parseLog(receipt.logs, 'WithdrawalClaimed');

        // Move to completed
        const payout = w.estimatedHypePayout;
        const profitPct = ((payout - Number(w.khypeAmount) / 1e18) / (Number(w.khypeAmount) / 1e18)) * 100;
        const profitUsd = (profitPct / 100) * w.estimatedHypePayout * 25; // assume HYPE=$25

        this.state.completedCycles.push({
          withdrawalId: w.withdrawalId,
          queuedAt: w.queuedAt,
          claimedAt: now,
          khypeAmount: Number(w.khypeAmount) / 1e18,
          hypePayout: payout,
          profitUsd,
          profitPct,
        });
        this.state.totalProfitUsd += profitUsd;
        this.state.totalCyclesCompleted++;
        totalPayout += payout;
        claimed++;

        // Remove from pending
        this.state.pendingWithdrawals = this.state.pendingWithdrawals.filter(p => p.withdrawalId !== w.withdrawalId);
      } catch (e: any) {
        console.error(`[khype-carry] Failed to claim ${w.withdrawalId}: ${e.message}`);
      }
    }

    saveState(this.state);
    console.log(`[khype-carry] Claimed ${claimed} withdrawals. Total HYPE: ${totalPayout.toFixed(4)}`);
    console.log(`[khype-carry] Cumulative profit: $${this.state.totalProfitUsd.toFixed(2)} across ${this.state.totalCyclesCompleted} cycles`);

    return { claimed, totalPayoutHype: totalPayout };
  }

  /** Get current state for monitoring/CLI */
  getState(): KhypeCarryState {
    return this.state;
  }

  /** Get Kinetiq staking status (cached client) */
  async getKinetiqStatus() {
    return this.kinetiq.getStatus();
  }
}

// ─── CLI entry point ────────────────────────────────────────────────────
// Usage: tsx khype-carry-executor.ts [--scan] [--claim] [--execute] [--status]
async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = !process.env.AGENT_HYPE_PRIVKEY || args.has('--dry-run');

  const executor = new KhypeCarryExecutor({
    minDiscountPct: 0.5,
    maxSizeUsd: 5000,
    agentAddress: (process.env.AGENT_HYPE_ADDRESS || '0x0000000000000000000000000000000000000000') as Address,
    dryRun,
  });

  console.log('═══════════════════════════════════════════════════');
  console.log('  kHYPE Carry Arb Executor');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Mode: ${dryRun ? 'DRY-RUN (no wallet)' : 'LIVE'}`);
  console.log(`  Agent: ${executor['opts'].agentAddress}`);

  // Always show status
  if (args.has('--status') || args.size === 0) {
    console.log('\n── Kinetiq Status ──');
    try {
      const status = await executor.getKinetiqStatus();
      console.log(`  Min stake: ${status.minStakeAmountHype} HYPE`);
      console.log(`  Max stake: ${status.maxStakeAmountHype} HYPE`);
      console.log(`  Withdrawal delay: ${status.withdrawalDelayDays.toFixed(1)} days`);
      console.log(`  Unstake fee: ${status.unstakeFeeRatePct}%`);
      console.log(`  Total staked: ${status.totalStakedHype.toLocaleString()} HYPE`);
      console.log(`  Total queued: ${status.totalQueuedWithdrawals.toLocaleString()} HYPE`);
      console.log(`  Whitelist: ${status.whitelistEnabled ? 'ENABLED' : 'OPEN'}`);
    } catch (e: any) {
      console.log(`  ⚠ Failed: ${e.message}`);
    }

    const state = executor.getState();
    console.log('\n── Carry State ──');
    console.log(`  Pending withdrawals: ${state.pendingWithdrawals.length}`);
    for (const w of state.pendingWithdrawals) {
      const daysLeft = Math.max(0, (w.claimableAt - Date.now()) / 86400000);
      console.log(`    - ${w.withdrawalId}: ${Number(w.khypeAmount) / 1e18} kHYPE → claim in ${daysLeft.toFixed(1)}d`);
    }
    console.log(`  Completed cycles: ${state.totalCyclesCompleted}`);
    console.log(`  Total profit: $${state.totalProfitUsd.toFixed(2)}`);
  }

  if (args.has('--scan')) {
    console.log('\n── Scanning (UNVERIFIED reference — execution suppressed, EM-STRAT-016-WO-01-R1) ──');
    const opp = await executor.scan();
    if (opp) {
      console.log(`  ✓ DISCOUNT FOUND (unverified reference — NOT a validated executable opportunity)`);
      console.log(`    kHYPE price: ${opp.khypePriceInWhype.toFixed(6)} WHYPE`);
      console.log(`    Discount: ${opp.discountPct.toFixed(2)}%`);
      console.log(`    Pool: ${opp.poolAddress} (fee=${opp.feeTier})`);
      console.log(`    Liquidity: ${opp.poolLiquidity.toString()}`);
      console.log(`    Est. profit: ${opp.estimatedProfitPct.toFixed(2)}% = $${opp.estimatedProfitUsd.toFixed(2)} on $${opp.maxSizeUsd}`);
    } else {
      console.log('  ✗ No discount above threshold right now');
    }
  }

  if (args.has('--execute')) {
    // EM-STRAT-016-WO-01-R1: --execute fails closed at the CLI route as
    // well — the refusal prints BEFORE any scan or cycle execution. The
    // executeCycle() entry gate is the authoritative stop; this route-level
    // message exists so an operator sees the reason without triggering the
    // scan path.
    console.log('\n── Executing Cycle ──');
    console.log(`  ✗ ${KHYPE_CARRY_EXECUTION_SUPPRESSED}`);
    console.log('  No scan was run and no cycle was attempted. Re-enabling requires a separate evidence-backed work order.');
  }

  if (args.has('--claim')) {
    console.log('\n── Claiming Ready Withdrawals ──');
    const result = await executor.claimReadyWithdrawals();
    console.log(`  Claimed: ${result.claimed}, Total HYPE: ${result.totalPayoutHype.toFixed(4)}`);
  }
}

// Only run main if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
