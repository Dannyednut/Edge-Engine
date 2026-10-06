/**
 * KinetiqClient — Kinetiq Liquid Staking client for HyperEVM.
 *
 * Contract addresses (verified from kinetiq.xyz/docs/integration on Oct 13 2026):
 *   KHYPE_TOKEN          = 0xfD739d4e423301CE9385c1fb8850539D657C296D  (the LST ERC20)
 *   STAKING_MANAGER      = 0x393D0B87Ed38fc779FD9611144aE649BA6082109  (stake/unstake)
 *   STAKING_ACCOUNTANT   = 0x9209648Ec9D448EF57116B73A2f081835643dc7A  (accounting/exchange rate)
 *   VALIDATOR_MANAGER    = 0x4b797A93DfC3D18Cf98B7322a2b142FA8007508f  (validator registry)
 *
 * VERIFIED ON-CHAIN (Oct 13 2026):
 *   minStakeAmount()       = 5 HYPE         (0x4563918244f40000)
 *   withdrawalDelay()      = 604,800 s = 7 days  (0x93a80)
 *   totalStaked()          = ~48.95M HYPE   (matches kHYPE totalSupply ~48.94M)
 *   unstakeFeeRate()       = 0.10%          (per Kinetiq docs)
 *
 * STAKE FLOW:
 *   Call STAKING_MANAGER.stake{value: msg.value}()  — payable, returns kHYPE to caller
 *
 * UNSTAKE FLOW (TWO-PHASE WITHDRAWAL):
 *   1. Approve kHYPE → STAKING_MANAGER
 *   2. Call unstake(uint256 kHypeAmount)  → queues withdrawal, returns withdrawalId
 *   3. Wait 7 days (withdrawalDelay)
 *   4. Call claimWithdrawal(withdrawalId)  → returns HYPE to caller
 *
 * The 4byte.directory doesn't index all Kinetiq selectors, so some functions
 * use selector lookup by direct keccak computation.
 */

import type { Address } from 'viem';
import { toFunctionSelector, encodeFunctionData } from 'viem';

// ─── Contract Addresses (HyperEVM chain 999) ───────────────────────────
export const KHYPE_TOKEN          = '0xfD739d4e423301CE9385c1fb8850539D657C296D' as Address;
export const STAKING_MANAGER      = '0x393D0B87Ed38fc779FD9611144aE649BA6082109' as Address;
export const STAKING_ACCOUNTANT   = '0x9209648Ec9D448EF57116B73A2f081835643dc7A' as Address;
export const VALIDATOR_MANAGER    = '0x4b797A93DfC3D18Cf98B7322a2b142FA8007508f' as Address;
export const HYPEREVM_RPC         = 'https://rpc.hyperliquid.xyz/evm';
export const HYPEREVM_CHAIN_ID    = 999;
export const NATIVE_HYPE_DECIMALS = 18;

// ─── Known Function Selectors (verified on-chain) ──────────────────────
// STAKING_MANAGER view functions (verified Oct 13 2026)
export const KINETIQ_STAKING_MANAGER_ABI = [
  // Views
  { name: 'minStakeAmount',       type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'maxStakeAmount',       type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'stakingLimit',         type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'totalStaked',          type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'totalQueuedWithdrawals', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'unstakeFeeRate',       type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'minWithdrawalAmount',  type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'withdrawalDelay',      type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'oracleManager',        type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'treasury',             type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'tokenAddress',         type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'whitelistEnabled',     type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: 'bool' }] },
  // Write
  { name: 'stake',                type: 'function', stateMutability: 'payable',
    inputs: [], outputs: [] },
  { name: 'unstake',              type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }], outputs: [{ name: 'withdrawalId', type: 'uint256' }] },
  { name: 'claimWithdrawal',      type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'withdrawalId', type: 'uint256' }], outputs: [{ name: 'amount', type: 'uint256' }] },
  { name: 'claimWithdrawals',     type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'withdrawalIds', type: 'uint256[]' }], outputs: [{ name: 'amount', type: 'uint256' }] },
] as const;

// STAKING_ACCOUNTANT view functions
export const KINETIQ_STAKING_ACCOUNTANT_ABI = [
  { name: 'totalStaked',          type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'totalRewards',         type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'totalClaimed',         type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'validatorManager',     type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

// ─── KinetiqClient ─────────────────────────────────────────────────────
export interface KinetiqConfig {
  rpcUrl?: string;
}

export interface KinetiqStatus {
  minStakeAmountHype: number;
  maxStakeAmountHype: number;
  stakingLimitHype: number;
  unstakeFeeRatePct: number;
  minWithdrawalAmountHype: number;
  withdrawalDelaySec: number;
  withdrawalDelayDays: number;
  totalStakedHype: number;
  totalQueuedWithdrawals: number;
  whitelistEnabled: boolean;
  khypeTokenAddress: Address;
  oracleManager: Address;
  treasury: Address;
}

export class KinetiqClient {
  private rpc: string;

  constructor(cfg: KinetiqConfig = {}) {
    this.rpc = cfg.rpcUrl || HYPEREVM_RPC;
  }

  /** Get comprehensive staking status (all view functions in one round trip) */
  async getStatus(): Promise<KinetiqStatus> {
    const [
      minStake, maxStake, stakingLimit, unstakeFeeRate,
      minWithdrawal, withdrawalDelay, totalStaked, totalQueued,
      whitelistEnabled, khypeToken, oracleManager, treasury,
    ] = await Promise.all([
      this.callView(STAKING_MANAGER, 'minStakeAmount()'),
      this.callView(STAKING_MANAGER, 'maxStakeAmount()'),
      this.callView(STAKING_MANAGER, 'stakingLimit()'),
      this.callView(STAKING_MANAGER, 'unstakeFeeRate()'),
      this.callView(STAKING_MANAGER, 'minWithdrawalAmount()'),
      this.callView(STAKING_MANAGER, 'withdrawalDelay()'),
      this.callView(STAKING_MANAGER, 'totalStaked()'),
      this.callView(STAKING_MANAGER, 'totalQueuedWithdrawals()'),
      this.callView(STAKING_MANAGER, 'whitelistEnabled()'),
      this.callView(STAKING_MANAGER, 'tokenAddress()'),
      this.callView(STAKING_MANAGER, 'oracleManager()'),
      this.callView(STAKING_MANAGER, 'treasury()'),
    ]);

    const toHype = (hex: string) => Number(BigInt(hex)) / 1e18;
    const toAddr = (hex: string) => ('0x' + hex.slice(26)) as Address;

    return {
      minStakeAmountHype: toHype(minStake),
      maxStakeAmountHype: toHype(maxStake),
      stakingLimitHype: toHype(stakingLimit),
      unstakeFeeRatePct: Number(BigInt(unstakeFeeRate)) / 100, // assumes bps
      minWithdrawalAmountHype: toHype(minWithdrawal),
      withdrawalDelaySec: Number(BigInt(withdrawalDelay)),
      withdrawalDelayDays: Number(BigInt(withdrawalDelay)) / 86400,
      totalStakedHype: toHype(totalStaked),
      totalQueuedWithdrawals: toHype(totalQueued),
      whitelistEnabled: BigInt(whitelistEnabled) === 1n,
      khypeTokenAddress: toAddr(khypeToken),
      oracleManager: toAddr(oracleManager),
      treasury: toAddr(treasury),
    };
  }

  /** Get total kHYPE supply */
  async getKhypeTotalSupply(): Promise<number> {
    const r = await this.callView(KHYPE_TOKEN, 'totalSupply()');
    return Number(BigInt(r)) / 1e18;
  }

  /** Get kHYPE balance of an address */
  async getKhypeBalance(addr: Address): Promise<number> {
    const sel = toFunctionSelector('balanceOf(address)');
    const data = sel + addr.slice(2).toLowerCase().padStart(64, '0');
    const r = await this.callRaw(KHYPE_TOKEN, data);
    return Number(BigInt(r)) / 1e18;
  }

  /** Get native HYPE balance of an address */
  async getHypeBalance(addr: Address): Promise<number> {
    const res = await fetch(this.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBalance', params: [addr, 'latest'], id: 1 }),
    });
    const j = await res.json() as { result?: string };
    return Number(BigInt(j.result || '0x0')) / 1e18;
  }

  /**
   * Compute the implied kHYPE exchange rate (kHYPE per HYPE).
   * Should be ~1.0 for a new LST, slightly > 1.0 as validator rewards accrue.
   */
  async getExchangeRate(): Promise<{ khypePerHype: number; hypePerKhype: number; totalStakedHype: number; totalKhypeSupply: number }> {
    const [totalStaked, totalKhype] = await Promise.all([
      this.callView(STAKING_MANAGER, 'totalStaked()'),
      this.callView(KHYPE_TOKEN, 'totalSupply()'),
    ]);
    const staked = Number(BigInt(totalStaked));
    const supply = Number(BigInt(totalKhype));
    return {
      khypePerHype: staked > 0 ? supply / staked : 1,
      hypePerKhype: supply > 0 ? staked / supply : 1,
      totalStakedHype: staked / 1e18,
      totalKhypeSupply: supply / 1e18,
    };
  }

  /**
   * Build calldata for stake() — call with msg.value = HYPE amount.
   * Returns { to, data, value } ready to be signed + sent.
   */
  buildStakeTx(hypeAmountWei: bigint): { to: Address; data: `0x${string}`; value: bigint } {
    const data = encodeFunctionData({
      abi: KINETIQ_STAKING_MANAGER_ABI,
      functionName: 'stake',
    });
    return { to: STAKING_MANAGER, data, value: hypeAmountWei };
  }

  /**
   * Build calldata for unstake(uint256 amount).
   * Caller must approve kHYPE → STAKING_MANAGER first.
   */
  buildUnstakeTx(khypeAmountWei: bigint): { to: Address; data: `0x${string}` } {
    const data = encodeFunctionData({
      abi: KINETIQ_STAKING_MANAGER_ABI,
      functionName: 'unstake',
      args: [khypeAmountWei],
    });
    return { to: STAKING_MANAGER, data };
  }

  /**
   * Build calldata for claimWithdrawal(uint256 withdrawalId).
   * Called after withdrawalDelay has passed since unstake.
   */
  buildClaimTx(withdrawalId: bigint): { to: Address; data: `0x${string}` } {
    const data = encodeFunctionData({
      abi: KINETIQ_STAKING_MANAGER_ABI,
      functionName: 'claimWithdrawal',
      args: [withdrawalId],
    });
    return { to: STAKING_MANAGER, data };
  }

  /** Build calldata for batch claimWithdrawals(uint256[]). */
  buildClaimManyTx(withdrawalIds: bigint[]): { to: Address; data: `0x${string}` } {
    const data = encodeFunctionData({
      abi: KINETIQ_STAKING_MANAGER_ABI,
      functionName: 'claimWithdrawals',
      args: [withdrawalIds],
    });
    return { to: STAKING_MANAGER, data };
  }

  /** Build calldata for ERC20.approve(kHYPE → STAKING_MANAGER, amount). */
  buildApproveTx(khypeAmountWei: bigint): { to: Address; data: `0x${string}` } {
    const sel = toFunctionSelector('approve(address,uint256)');
    const addrArg = STAKING_MANAGER.slice(2).toLowerCase().padStart(64, '0');
    const amtArg = khypeAmountWei.toString(16).padStart(64, '0');
    return { to: KHYPE_TOKEN, data: `0x${sel.slice(2)}${addrArg}${amtArg}` as `0x${string}` };
  }

  // ─── Internal RPC helpers ──────────────────────────────────────────
  private async callView(target: Address, sig: string): Promise<string> {
    const sel = toFunctionSelector(sig);
    return this.callRaw(target, sel);
  }

  private async callRaw(target: Address, data: string): Promise<string> {
    const res = await fetch(this.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'eth_call',
        params: [{ to: target, data }, 'latest'], id: 1,
      }),
    });
    const j = await res.json() as { result?: string };
    return j.result || '0x';
  }
}
