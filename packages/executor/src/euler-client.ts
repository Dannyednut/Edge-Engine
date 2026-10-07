/**
 * EulerClient — Euler V2 client for HyperEVM (chain 999).
 *
 * Verified live Oct 13 2026 via github.com/euler-xyz/euler-interfaces
 *   58 vaults discovered via EVK Factory Perspective.verifiedArray()
 *
 * Top vaults by TVL:
 *   eUSDC-3 (258k USDC), eUSDC-4 (241k USDC), esUSN-6 (200k sUSN)
 *   ekHYPE-3 (7.9k kHYPE), eWHYPE-2 (6.9k WHYPE), esUSDp-1 (50k sUSDp)
 *
 * Each asset has multiple vaults with potentially different IRMs (interest rate models).
 * Lending arb opportunity: deposit in highest-APY vault, borrow from lowest-APY vault.
 */

import type { Address } from 'viem';
import { toFunctionSelector } from 'viem';

// ─── Euler HyperEVM Contract Addresses ────────────────────────────────
export const EULER_EVC                    = '0xceAA7cdCD7dDBee8601127a9Abb17A974d613db4' as Address;
export const EULER_EVAULT_FACTORY         = '0xcF5552580fD364cdBBFcB5Ae345f75674c59273A' as Address;
export const EULER_EVAULT_IMPLEMENTATION  = '0x05de079A28386135E048369cdf0Bc4D326d5EBDF' as Address;
export const EULER_EULER_EARN_FACTORY     = '0x587DD8285c01526769aB4803e4F02433ddbBc00E' as Address;
export const EULER_PROTOCOL_CONFIG        = '0x43144f09896F8759DE2ec6D777391B9F05A51128' as Address;
export const EULER_SEQUENCE_REGISTRY      = '0x47618E4CBDcFBf5f21D6594A7e3a4f4683719994' as Address;
export const EULER_BALANCE_TRACKER        = '0x05d14f4eDFA7Cbfb90711C2EC5505bcbd49b9cD2' as Address;
export const EULER_VAULT_LENS             = '0x46197d64f5B2381c5064B60fc19b089B58180a20' as Address;
export const EULER_IRM_LENS              = '0xdA238b8296730aF885fCd446c054BE48692Dcec1' as Address;
export const EULER_ORACLE_LENS           = '0xb6daA65cf9F4E2834c5652277F70147Cf21b3cB1' as Address;
export const EULER_ACCOUNT_LENS          = '0x27808A1Df554a88F841AEE2E43F63D60E9077152' as Address;
export const EVK_FACTORY_PERSPECTIVE     = '0x7bd1DADB012651606cE70210c9c4d4c94e2480a3' as Address;
export const EULER_EUL_TOKEN             = '0x3A41f426E55ECdE4BC734fA79ccE991b94aFf711' as Address;
export const EULER_SWAP_V2_FACTORY       = '0xFbF2a49CB0cc50F4ccd4eAc826eF1A76D99D29Eb' as Address;
export const EULER_HYPEREVM_RPC          = 'https://rpc.hyperliquid.xyz/evm';

// ─── eVault ABI (subset) ────────────────────────────────────────────────
export const EVAULT_READ_ABI = [
  { name: 'name',          type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { name: 'symbol',        type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { name: 'decimals',      type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { name: 'asset',         type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'totalAssets',   type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'totalSupply',   type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'totalBorrows',  type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'totalSupplyShares',   type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'totalBorrowShares',   type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'interestRate',  type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'interestAccrual', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'cash',          type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'interestData',  type: 'function', stateMutability: 'view', inputs: [], outputs: [
    { name: 'interestAccumulator', type: 'uint256' },
    { name: 'interestRate',        type: 'uint256' },
    { name: 'updatedAt',           type: 'uint256' },
  ]},
  { name: 'configData',    type: 'function', stateMutability: 'view', inputs: [], outputs: [
    { name: 'borrowable', type: 'bool' },
    { name: 'collateral', type: 'bool' },
    { name: 'hook', type: 'address' },
    { name: 'sc', type: 'address' },
    { name: 'oracle', type: 'address' },
    { name: 'irm', type: 'address' },
    { name: 'ltv', type: 'uint16' },
    { name: 'hookedOps', type: 'uint8' },
  ]},
] as const;

export const EVK_FACTORY_PERSPECTIVE_ABI = [
  { name: 'verifiedArray',  type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address[]' }] },
  { name: 'verifiedLength', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'isVerified',     type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

// ─── Types ──────────────────────────────────────────────────────────────
export interface EulerVaultInfo {
  address: Address;
  name: string;
  symbol: string;
  asset: Address;
  assetSymbol: string;
  assetDecimals: number;
  totalAssets: number;       // human-readable
  totalBorrows: number;      // human-readable
  totalSupply: number;       // vault shares (human-readable)
  cash: number;              // un lent assets (human-readable)
  interestRate: number;      // APR in bps (1e4 = 100%)
  interestRatePct: number;   // APR as %
  utilizationPct: number;    // totalBorrows / totalAssets * 100
  borrowable: boolean;
  collateral: boolean;
  ts: number;
}

export class EulerClient {
  private rpc: string;

  constructor(rpcUrl: string = EULER_HYPEREVM_RPC) {
    this.rpc = rpcUrl;
  }

  /** Get all verified vault addresses */
  async getAllVaultAddresses(): Promise<Address[]> {
    const r = await this.ethCall(EVK_FACTORY_PERSPECTIVE, toFunctionSelector('verifiedArray()'));
    if (r === '0x' || r.length < 130) return [];

    const data = r.slice(2);
    const arrLen = parseInt(data.slice(64, 128), 16);

    const vaults: Address[] = [];
    for (let i = 0; i < arrLen; i++) {
      const start = 128 + i * 64;
      const addrHex = data.slice(start + 24, start + 64);
      vaults.push('0x' + addrHex.toLowerCase() as Address);
    }
    return vaults;
  }

  /** Read full info for a single vault (multiple RPCs in parallel) */
  async getVaultInfo(vault: Address): Promise<EulerVaultInfo | null> {
    try {
      // Cache symbol + decimals per asset
      const [nameR, symR, assetR, totalAssetsR, totalBorrowsR, totalSupplyR, cashR, interestRateR, configR] = await Promise.all([
        this.ethCall(vault, toFunctionSelector('name()')),
        this.ethCall(vault, toFunctionSelector('symbol()')),
        this.ethCall(vault, toFunctionSelector('asset()')),
        this.ethCall(vault, toFunctionSelector('totalAssets()')),
        this.ethCall(vault, toFunctionSelector('totalBorrows()')),
        this.ethCall(vault, toFunctionSelector('totalSupply()')),
        this.ethCall(vault, toFunctionSelector('cash()')),
        this.ethCall(vault, toFunctionSelector('interestRate()')),
        this.ethCall(vault, toFunctionSelector('configData()')),
      ]);

      const name = this.decodeString(nameR);
      const symbol = this.decodeString(symR);
      const asset = assetR !== '0x' && assetR.length >= 66
        ? ('0x' + assetR.slice(26)) as Address
        : '0x0000000000000000000000000000000000000000' as Address;

      // Read asset metadata
      let assetSymbol = '?';
      let assetDecimals = 18;
      if (asset !== '0x0000000000000000000000000000000000000000') {
        const [aSymR, aDecR] = await Promise.all([
          this.ethCall(asset, toFunctionSelector('symbol()')),
          this.ethCall(asset, toFunctionSelector('decimals()')),
        ]);
        assetSymbol = this.decodeString(aSymR);
        assetDecimals = aDecR !== '0x' && aDecR.length >= 10 ? parseInt(BigInt(aDecR).toString()) : 18;
      }

      const divisor = 10 ** assetDecimals;
      const totalAssets = totalAssetsR !== '0x' ? Number(BigInt(totalAssetsR)) / divisor : 0;
      const totalBorrows = totalBorrowsR !== '0x' ? Number(BigInt(totalBorrowsR)) / divisor : 0;
      const totalSupply = totalSupplyR !== '0x' ? Number(BigInt(totalSupplyR)) / divisor : 0;
      const cash = cashR !== '0x' ? Number(BigInt(cashR)) / divisor : 0;
      const interestRate = interestRateR !== '0x' ? Number(BigInt(interestRateR)) : 0;
      // Euler V2 interestRate is in RAY (1e27) per second. Convert to APR %.
      // APR = rate_per_sec × seconds_per_year (31_556_952) / 1e27 × 100
      const interestRatePct = (interestRate / 1e27) * 31_556_952 * 100;

      const utilizationPct = totalAssets > 0 ? (totalBorrows / totalAssets) * 100 : 0;

      // Parse configData tuple (static layout):
      //   [0..32)   borrowable (bool — last byte)
      //   [32..64)  collateral (bool — last byte)
      //   [64..96)  hook (address — last 20 bytes)
      //   [96..128) sc (address — last 20 bytes)
      //   [128..160) oracle (address — last 20 bytes)
      //   [160..192) irm (address — last 20 bytes)
      //   [192..224) ltv (uint16) + hookedOps (uint8) packed
      const cfgData = configR !== '0x' ? configR.slice(2) : '';
      const borrowable = cfgData.length >= 64 ? parseInt(cfgData.slice(62, 64), 16) === 1 : false;
      const collateral = cfgData.length >= 128 ? parseInt(cfgData.slice(126, 128), 16) === 1 : false;

      return {
        address: vault,
        name, symbol, asset, assetSymbol, assetDecimals,
        totalAssets, totalBorrows, totalSupply, cash,
        interestRate, interestRatePct, utilizationPct,
        borrowable, collateral,
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /** Get info for all verified vaults (parallelized) */
  async getAllVaults(): Promise<EulerVaultInfo[]> {
    const addresses = await this.getAllVaultAddresses();
    // Process in batches of 10 to avoid RPC overload
    const results: EulerVaultInfo[] = [];
    for (let i = 0; i < addresses.length; i += 10) {
      const batch = addresses.slice(i, i + 10);
      const infos = await Promise.all(batch.map(a => this.getVaultInfo(a)));
      for (const info of infos) {
        if (info) results.push(info);
      }
    }
    return results;
  }

  // ─── Internal helpers ──────────────────────────────────────────────
  private async ethCall(to: Address, data: string): Promise<string> {
    try {
      const res = await fetch(this.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'eth_call',
          params: [{ to, data }, 'latest'], id: 1,
        }),
      });
      const j = await res.json() as { result?: string };
      return j.result || '0x';
    } catch { return '0x'; }
  }

  private decodeString(r: string): string {
    if (r === '0x' || r.length < 10) return '?';
    const data = r.slice(2);
    if (data.length < 128) return '?';
    const len = parseInt(data.slice(64, 128), 16);
    if (len === 0 || len > 200) return '?';
    try {
      return Buffer.from(data.slice(128, 128 + len * 2), 'hex').toString('utf8');
    } catch {
      return '?';
    }
  }

  // ─── Write Methods (calldata builders) ────────────────────────────

  /**
   * Build calldata for ERC4626 deposit(uint256 assets, address receiver).
   * Caller must approve vault to spend `assets` first.
   */
  buildDepositTx(vault: Address, assetsWei: bigint, receiver: Address): { to: Address; data: `0x${string}` } {
    const sel = toFunctionSelector('deposit(uint256,address)');
    const assetsHex = assetsWei.toString(16).padStart(64, '0');
    const receiverHex = receiver.slice(2).toLowerCase().padStart(64, '0');
    return { to: vault, data: `0x${sel.slice(2)}${assetsHex}${receiverHex}` as `0x${string}` };
  }

  /**
   * Build calldata for ERC4626 withdraw(uint256 assets, address receiver, address owner).
   * Withdraws `assets` worth of shares from the vault.
   */
  buildWithdrawTx(vault: Address, assetsWei: bigint, receiver: Address, owner: Address): { to: Address; data: `0x${string}` } {
    const sel = toFunctionSelector('withdraw(uint256,address,address)');
    const assetsHex = assetsWei.toString(16).padStart(64, '0');
    const receiverHex = receiver.slice(2).toLowerCase().padStart(64, '0');
    const ownerHex = owner.slice(2).toLowerCase().padStart(64, '0');
    return { to: vault, data: `0x${sel.slice(2)}${assetsHex}${receiverHex}${ownerHex}` as `0x${string}` };
  }

  /**
   * Build calldata for ERC20 borrow(uint256 assets).
   * Requires collateral deposited in another vault via EVC.
   */
  buildBorrowTx(vault: Address, assetsWei: bigint): { to: Address; data: `0x${string}` } {
    const sel = toFunctionSelector('borrow(uint256)');
    const assetsHex = assetsWei.toString(16).padStart(64, '0');
    return { to: vault, data: `0x${sel.slice(2)}${assetsHex}` as `0x${string}` };
  }

  /**
   * Build calldata for ERC20 repay(uint256 assets).
   * Repays borrowed assets (reduces borrower's debt).
   */
  buildRepayTx(vault: Address, assetsWei: bigint): { to: Address; data: `0x${string}` } {
    const sel = toFunctionSelector('repay(uint256)');
    const assetsHex = assetsWei.toString(16).padStart(64, '0');
    return { to: vault, data: `0x${sel.slice(2)}${assetsHex}` as `0x${string}` };
  }

  /**
   * Build calldata for ERC20.approve(vault, amount).
   * Required before deposit() or repay().
   */
  buildApproveTx(token: Address, spender: Address, amountWei: bigint): { to: Address; data: `0x${string}` } {
    const sel = toFunctionSelector('approve(address,uint256)');
    const spenderHex = spender.slice(2).toLowerCase().padStart(64, '0');
    const amountHex = amountWei.toString(16).padStart(64, '0');
    return { to: token, data: `0x${sel.slice(2)}${spenderHex}${amountHex}` as `0x${string}` };
  }

  /**
   * Build the full lending arb cycle:
   *   1. Approve asset → deposit vault
   *   2. Deposit into high-APY vault (earn yield)
   *   3. Borrow from low-APY vault (pay lower rate)
   *   4. (Optional) Use borrowed asset for another opportunity
   *
   * Returns an array of { to, data } transactions to be executed in sequence.
   * Caller must sign and submit each tx, waiting for confirmation between.
   */
  buildLendingArbCycle(params: {
    asset: Address;
    depositVault: Address;
    borrowVault: Address;
    depositAmountWei: bigint;
    borrowAmountWei: bigint;
    agentAddress: Address;
  }): Array<{ to: Address; data: `0x${string}`; value?: bigint; description: string }> {
    const { asset, depositVault, borrowVault, depositAmountWei, borrowAmountWei, agentAddress } = params;
    return [
      // 1. Approve deposit vault to spend asset
      { ...this.buildApproveTx(asset, depositVault, depositAmountWei),
        description: `Approve ${depositVault} to spend ${depositAmountWei} asset` },
      // 2. Deposit into high-APY vault
      { ...this.buildDepositTx(depositVault, depositAmountWei, agentAddress),
        description: `Deposit ${depositAmountWei} into ${depositVault}` },
      // 3. Borrow from low-APY vault (uses deposit as collateral via EVC)
      { ...this.buildBorrowTx(borrowVault, borrowAmountWei),
        description: `Borrow ${borrowAmountWei} from ${borrowVault}` },
    ];
  }
}
