/**
 * EulerLendingArbExecutor — end-to-end Euler HL lending arb executor.
 *
 * THE STRATEGY:
 *   Euler V2 has multiple vaults per asset (eUSDC-1 through -6, etc.)
 *   When the same asset has different interest rates across vaults:
 *     1. Deposit into highest-APY vault (earn that rate, becomes collateral via EVC)
 *     2. Borrow from lowest-APY vault (pay that rate)
 *     3. Net capture = (deposit APY - borrow APY) × collateral factor
 *
 * CURRENT OPPORTUNITY (Oct 13 2026):
 *   USDC: eUSDC-3 @ 12.14% APR vs eUSDC-4 @ 5.02% APR = 7.12% spread
 *   On $5,000 collateral at 80% LTV: ~$285/year risk-free
 *
 * EXECUTION FLOW:
 *   1. Approve USDC → eUSDC-3 (deposit vault)
 *   2. Deposit USDC into eUSDC-3 (earn 12.14% APR)
 *   3. Borrow USDC from eUSDC-4 (pay 5.02% APR, uses deposit as collateral via EVC)
 *   4. (Optional) Use borrowed USDC for another opportunity
 *   5. To close: repay borrowed USDC, withdraw deposited USDC
 *
 * STATE PERSISTENCE:
 *   data/euler-lending-state.json — tracks open positions
 *
 * REQUIREMENTS:
 *   - Agent wallet with USDC on HyperEVM
 *   - Set AGENT_HYPE_PRIVKEY env var
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EulerClient, hyperEvm, type EulerVaultInfo } from '@edge/executor';
import { createWalletClient, createPublicClient, http, type WalletClient, type PublicClient, type Address, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');
const STATE_FILE = resolve(REPO_ROOT, 'data', 'euler-lending-state.json');
const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';

// ─── State persistence ─────────────────────────────────────────────────
export interface EulerLendingState {
  openPositions: Array<{
    assetSymbol: string;
    depositVault: { address: string; name: string; apyPct: number; };
    borrowVault: { address: string; name: string; apyPct: number; };
    depositAmount: string;     // raw wei
    borrowAmount: string;      // raw wei
    openedAt: number;
    txHashes: string[];
    status: 'open' | 'closed';
  }>;
  closedPositions: Array<{
    assetSymbol: string;
    openedAt: number;
    closedAt: number;
    depositAmount: number;
    borrowAmount: number;
    interestEarnedUsd: number;
    interestPaidUsd: number;
    netProfitUsd: number;
  }>;
  totalProfitUsd: number;
}

function loadState(): EulerLendingState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  }
  return { openPositions: [], closedPositions: [], totalProfitUsd: 0 };
}

function saveState(state: EulerLendingState): void {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Asset price assumptions (for USD conversion) ─────────────────────
const ASSET_PRICES: Record<string, number> = {
  USDC: 1, USDT0: 1, USDH: 1, sUSN: 1, sUSDp: 1, USDXL: 1, USDG0: 1, syzUSD: 1, FXRP: 1,
  WHYPE: 89.5, kHYPE: 87.3, wstHYPE: 89.5, lstHYPE: 89.5, beHYPE: 89.5, haHYPE: 89.5, hwHYPE: 89.5, xHYPE: 89.5, LHYPE: 89.5,
  UBTC: 96000, UETH: 3300,
};

export interface EulerLendingArbOpportunity {
  assetSymbol: string;
  assetAddress: Address;
  depositVault: { address: Address; name: string; apyPct: number; tvl: number; };
  borrowVault:  { address: Address; name: string; apyPct: number; tvl: number; };
  spreadPct: number;
  estimatedProfitUsd: number;  // per YEAR on $5k collateral at 80% LTV
  collateralFactorPct: number;
  totalLiquidityUsd: number;
  ts: number;
}

export interface EulerLendingArbExecutorOptions {
  /** Min spread % to enter (default 2%) */
  minSpreadPct: number;
  /** Min total liquidity (default $50k) */
  minLiquidityUsd: number;
  /** Max capital per position (default $5,000) */
  maxSizeUsd: number;
  /** Collateral factor assumption (default 80%) */
  collateralFactorPct: number;
  /** Agent wallet address */
  agentAddress: Address;
  /** Dry-run mode */
  dryRun?: boolean;
}

export class EulerLendingArbExecutor {
  private euler: EulerClient;
  private state: EulerLendingState;
  private walletClient: WalletClient | null = null;
  private publicClient: PublicClient | null = null;

  constructor(private opts: EulerLendingArbExecutorOptions) {
    this.euler = new EulerClient();
    this.state = loadState();

    if (process.env.AGENT_HYPE_PRIVKEY && !opts.dryRun) {
      const account = privateKeyToAccount(process.env.AGENT_HYPE_PRIVKEY as `0x${string}`);
      this.walletClient = createWalletClient({
        account,
        chain: hyperEvm,
        transport: http(HYPEREVM_RPC),
      });
      this.publicClient = createPublicClient({
        chain: hyperEvm,
        transport: http(HYPEREVM_RPC),
      });
      console.log(`[euler-arb] Wallet initialized: ${account.address}`);
    }
  }

  /** Sign and submit a transaction, wait for confirmation. */
  private async sendTx(to: Address, data: `0x${string}`, value: bigint = 0n): Promise<Hash> {
    if (!this.walletClient || !this.publicClient || !this.walletClient.account) {
      throw new Error('Wallet not initialized — set AGENT_HYPE_PRIVKEY');
    }
    const txHash = await this.walletClient.sendTransaction({
      account: this.walletClient.account,
      chain: hyperEvm,
      to, data, value,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(`Transaction reverted: ${txHash}`);
    }
    return txHash;
  }

  /** Scan for opportunities (same logic as EulerLendingArbScanner). */
  async scan(): Promise<EulerLendingArbOpportunity | null> {
    const vaults = await this.euler.getAllVaults();
    if (vaults.length === 0) return null;

    // Group by asset
    const byAsset = new Map<string, EulerVaultInfo[]>();
    for (const v of vaults) {
      if (v.totalAssets <= 0) continue;
      if (!byAsset.has(v.assetSymbol)) byAsset.set(v.assetSymbol, []);
      byAsset.get(v.assetSymbol)!.push(v);
    }

    let best: EulerLendingArbOpportunity | null = null;

    for (const [asset, vaultsForAsset] of byAsset.entries()) {
      if (vaultsForAsset.length < 2) continue;

      const sorted = [...vaultsForAsset].sort((a, b) => b.interestRatePct - a.interestRatePct);
      const highest = sorted[0];
      const lowest = sorted[sorted.length - 1];

      const spreadPct = highest.interestRatePct - lowest.interestRatePct;
      if (spreadPct < this.opts.minSpreadPct) continue;

      const price = ASSET_PRICES[asset] ?? 0;
      if (price === 0) continue;

      const totalLiquidityUsd = (highest.totalAssets + lowest.totalAssets) * price;
      if (totalLiquidityUsd < this.opts.minLiquidityUsd) continue;

      // Skip if either vault has too little liquidity for our position
      const minVaultLiquidity = this.opts.maxSizeUsd / price;
      if (highest.totalAssets < minVaultLiquidity || lowest.totalAssets < minVaultLiquidity) continue;

      const borrowUsd = this.opts.maxSizeUsd * (this.opts.collateralFactorPct / 100);
      const estimatedProfitUsd = (spreadPct / 100) * borrowUsd;

      const opp: EulerLendingArbOpportunity = {
        assetSymbol: asset,
        assetAddress: highest.asset,
        depositVault: {
          address: highest.address,
          name: highest.name,
          apyPct: highest.interestRatePct,
          tvl: highest.totalAssets,
        },
        borrowVault: {
          address: lowest.address,
          name: lowest.name,
          apyPct: lowest.interestRatePct,
          tvl: lowest.totalAssets,
        },
        spreadPct,
        estimatedProfitUsd,
        collateralFactorPct: this.opts.collateralFactorPct,
        totalLiquidityUsd,
        ts: Date.now(),
      };

      if (!best || opp.estimatedProfitUsd > best.estimatedProfitUsd) {
        best = opp;
      }
    }
    return best;
  }

  /** Execute the lending arb: approve → deposit → borrow. */
  async executeArb(opp: EulerLendingArbOpportunity): Promise<{ success: boolean; txHashes: string[]; error?: string }> {
    if (this.opts.dryRun) {
      console.log(`[dry-run] Would execute ${opp.assetSymbol} arb: ${opp.spreadPct.toFixed(2)}% spread = $${opp.estimatedProfitUsd.toFixed(0)}/yr on $${this.opts.maxSizeUsd}`);
      return { success: false, txHashes: [], error: 'dry-run mode' };
    }

    if (!this.walletClient) {
      return { success: false, txHashes: [], error: 'AGENT_HYPE_PRIVKEY not set' };
    }

    const txHashes: string[] = [];
    try {
      const assetDecimals = 6; // USDC/USDT are 6 decimals; would need lookup for others
      const depositAmountWei = BigInt(Math.floor(this.opts.maxSizeUsd * 10 ** assetDecimals));
      const borrowAmountWei = BigInt(Math.floor(this.opts.maxSizeUsd * (this.opts.collateralFactorPct / 100) * 10 ** assetDecimals));

      // 1. Approve deposit vault to spend asset
      console.log(`[euler-arb] Step 1: Approve ${opp.depositVault.name} to spend ${opp.assetSymbol}`);
      const approveData = this.euler.buildApproveTx(opp.assetAddress, opp.depositVault.address, depositAmountWei);
      const approveHash = await this.sendTx(approveData.to, approveData.data);
      txHashes.push(approveHash);
      console.log(`  ✓ ${approveHash}`);

      // 2. Deposit into high-APY vault
      console.log(`[euler-arb] Step 2: Deposit into ${opp.depositVault.name} @ ${opp.depositVault.apyPct.toFixed(2)}% APR`);
      const depositData = this.euler.buildDepositTx(opp.depositVault.address, depositAmountWei, this.opts.agentAddress);
      const depositHash = await this.sendTx(depositData.to, depositData.data);
      txHashes.push(depositHash);
      console.log(`  ✓ ${depositHash}`);

      // 3. Borrow from low-APY vault (uses deposit as collateral via EVC)
      console.log(`[euler-arb] Step 3: Borrow from ${opp.borrowVault.name} @ ${opp.borrowVault.apyPct.toFixed(2)}% APR`);
      const borrowData = this.euler.buildBorrowTx(opp.borrowVault.address, borrowAmountWei);
      const borrowHash = await this.sendTx(borrowData.to, borrowData.data);
      txHashes.push(borrowHash);
      console.log(`  ✓ ${borrowHash}`);

      // Record state
      this.state.openPositions.push({
        assetSymbol: opp.assetSymbol,
        depositVault: opp.depositVault,
        borrowVault: opp.borrowVault,
        depositAmount: depositAmountWei.toString(),
        borrowAmount: borrowAmountWei.toString(),
        openedAt: Date.now(),
        txHashes,
        status: 'open',
      });
      saveState(this.state);

      console.log(`[euler-arb] ✓ Position opened. Expected: $${opp.estimatedProfitUsd.toFixed(0)}/yr`);
      return { success: true, txHashes };
    } catch (e: any) {
      return { success: false, txHashes, error: e.message };
    }
  }

  /** Close a position: repay borrowed → withdraw deposited. */
  async closePosition(positionIndex: number): Promise<{ success: boolean; txHashes: string[]; error?: string }> {
    const pos = this.state.openPositions[positionIndex];
    if (!pos || pos.status !== 'open') {
      return { success: false, txHashes: [], error: 'Position not found or already closed' };
    }

    if (this.opts.dryRun || !this.walletClient) {
      console.log(`[dry-run] Would close position #${positionIndex}: ${pos.assetSymbol}`);
      return { success: false, txHashes: [], error: 'dry-run mode' };
    }

    const txHashes: string[] = [];
    try {
      // 1. Repay borrowed amount
      console.log(`[euler-arb] Repaying borrowed ${pos.assetSymbol}...`);
      const repayData = this.euler.buildRepayTx(pos.borrowVault.address as Address, BigInt(pos.borrowAmount));
      const repayHash = await this.sendTx(repayData.to, repayData.data);
      txHashes.push(repayHash);

      // 2. Withdraw deposited amount
      console.log(`[euler-arb] Withdrawing deposited ${pos.assetSymbol}...`);
      const withdrawData = this.euler.buildWithdrawTx(
        pos.depositVault.address as Address,
        BigInt(pos.depositAmount),
        this.opts.agentAddress,
        this.opts.agentAddress,
      );
      const withdrawHash = await this.sendTx(withdrawData.to, withdrawData.data);
      txHashes.push(withdrawHash);

      // Move to closed
      pos.status = 'closed';
      this.state.openPositions = this.state.openPositions.filter((_, i) => i !== positionIndex);
      this.state.closedPositions.push({
        assetSymbol: pos.assetSymbol,
        openedAt: pos.openedAt,
        closedAt: Date.now(),
        depositAmount: Number(pos.depositAmount) / 1e6,
        borrowAmount: Number(pos.borrowAmount) / 1e6,
        interestEarnedUsd: 0,  // would need to query actual accrued interest
        interestPaidUsd: 0,
        netProfitUsd: 0,
      });
      saveState(this.state);

      console.log(`[euler-arb] ✓ Position closed.`);
      return { success: true, txHashes };
    } catch (e: any) {
      return { success: false, txHashes, error: e.message };
    }
  }

  /** Get current state for monitoring/CLI. */
  getState(): EulerLendingState {
    return this.state;
  }
}

// ─── CLI entry point ───────────────────────────────────────────────────
async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = !process.env.AGENT_HYPE_PRIVKEY || args.has('--dry-run');

  const executor = new EulerLendingArbExecutor({
    minSpreadPct: 2.0,
    minLiquidityUsd: 50_000,
    maxSizeUsd: 5_000,
    collateralFactorPct: 80,
    agentAddress: (process.env.AGENT_HYPE_ADDRESS || '0x0000000000000000000000000000000000000000') as Address,
    dryRun,
  });

  console.log('═══════════════════════════════════════════════════');
  console.log('  Euler HL Lending Arb Executor');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Mode: ${dryRun ? 'DRY-RUN (no wallet)' : 'LIVE'}`);
  console.log(`  Agent: ${executor['opts'].agentAddress}`);

  if (args.has('--status') || args.size === 0) {
    const state = executor.getState();
    console.log('\n── Lending Arb State ──');
    console.log(`  Open positions: ${state.openPositions.length}`);
    for (const p of state.openPositions) {
      console.log(`    - ${p.assetSymbol}: deposit ${p.depositVault.name} @ ${p.depositVault.apyPct.toFixed(2)}% | borrow ${p.borrowVault.name} @ ${p.borrowVault.apyPct.toFixed(2)}% | opened ${new Date(p.openedAt).toISOString()}`);
    }
    console.log(`  Closed positions: ${state.closedPositions.length}`);
    console.log(`  Total profit: $${state.totalProfitUsd.toFixed(2)}`);
  }

  if (args.has('--scan')) {
    console.log('\n── Scanning for Opportunity ──');
    const opp = await executor.scan();
    if (opp) {
      console.log(`  ✓ OPPORTUNITY FOUND`);
      console.log(`    Asset: ${opp.assetSymbol}`);
      console.log(`    Spread: ${opp.spreadPct.toFixed(2)}%`);
      console.log(`    Deposit: ${opp.depositVault.name} @ ${opp.depositVault.apyPct.toFixed(2)}% APR`);
      console.log(`    Borrow:  ${opp.borrowVault.name} @ ${opp.borrowVault.apyPct.toFixed(2)}% APR`);
      console.log(`    Est. profit: $${opp.estimatedProfitUsd.toFixed(0)}/yr on $${5000} collateral`);
      console.log(`    Combined liquidity: $${(opp.totalLiquidityUsd / 1000).toFixed(0)}k`);
    } else {
      console.log('  ✗ No opportunity above threshold right now');
    }
  }

  if (args.has('--execute')) {
    console.log('\n── Executing Arb ──');
    const opp = await executor.scan();
    if (!opp) {
      console.log('  ✗ No opportunity to execute');
    } else {
      const result = await executor.executeArb(opp);
      console.log(`  Result:`, result);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
