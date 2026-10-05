/**
 * HyperLend Flashloan Client — wrapper for HyperLend Pool on HyperEVM.
 *
 * HyperLend is an Aave V3 fork on the Hyperliquid L1 blockchain.
 * Pool address: 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b
 * Flashloan fee: 0.04% (verified from Aave V3 fork parameters)
 *
 * Supports two flashloan methods:
 *   1. flashLoanSimple(receiverAddress, asset, amount, params, referralCode)
 *      Single-asset flashloan. Gas-efficient. Receiver must implement
 *      executeOperation() and repay amount + premium.
 *
 *   2. flashLoan(receiverAddress, assets, amounts, interestRateModes, params, referralCode)
 *      Multi-asset flashloan. More flexible but higher gas.
 *
 * USE CASE:
 *   Flashloan WHYPE from HyperLend → swap on HyperSwap V3 → swap back → repay.
 *   All atomic in one HyperEVM block. No bridge, no CEX.
 *
 * NOTE: This client builds the calldata for the flashloan. Actual execution
 * requires a smart contract on HyperEVM that implements IFlashLoanSimpleReceiver
 * (like AgentVault but for HyperEVM). That contract is TBD.
 */

import type { Address } from 'viem';

export const HYPERLEND_POOL_ABI = [
  {
    name: 'flashLoanSimple',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'receiverAddress', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'params', type: 'bytes' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    name: 'flashLoan',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'receiverAddress', type: 'address' },
      { name: 'assets', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'interestRateModes', type: 'uint8[]' },
      { name: 'params', type: 'bytes' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    name: 'getReserveData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'unbacked', type: 'uint256' },
      { name: ' accruedToTreasuryScaled', type: 'uint256' },
      { name: 'totalAToken', type: 'uint256' },
      { name: 'totalStableDebt', type: 'uint256' },
      { name: 'totalVariableDebt', type: 'uint256' },
      { name: 'liquidityRate', type: 'uint256' },
      { name: 'variableBorrowRate', type: 'uint256' },
      { name: 'stableBorrowRate', type: 'uint256' },
      { name: 'liquidityIndex', type: 'uint256' },
      { name: 'variableBorrowIndex', type: 'uint256' },
      { name: 'lastUpdateTimestamp', type: 'uint40' },
    ],
  },
] as const;

export interface FlashloanParams {
  receiverAddress: Address;   // contract that will receive + repay
  asset: Address;             // token to borrow (e.g. WHYPE)
  amount: bigint;             // amount in raw units
  params: `0x${string}`;      // arbitrary data passed to receiver
  referralCode?: number;      // default 0
}

export interface MultiFlashloanParams {
  receiverAddress: Address;
  assets: Address[];           // multiple tokens to borrow
  amounts: bigint[];
  interestRateModes: number[]; // 0 = none, 1 = stable, 2 = variable
  params: `0x${string}`;
  referralCode?: number;
}

export class HyperLendClient {
  readonly poolAddress: Address;
  readonly flashloanFeePct: number = 0.04;  // 0.04%

  constructor(
    poolAddress: Address = '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b' as Address,
  ) {
    this.poolAddress = poolAddress;
  }

  /**
   * Compute the flashloan fee for a given amount.
   * HyperLend charges 0.04% (4 basis points).
   */
  computeFee(amount: bigint): bigint {
    return (amount * 4n) / 10000n;
  }

  /**
   * Compute the total repayment amount (principal + fee).
   */
  computeRepayment(amount: bigint): bigint {
    return amount + this.computeFee(amount);
  }

  /**
   * Build the calldata for a flashLoanSimple call.
   * This is what you send to the HyperLend Pool contract.
   *
   * The receiver contract must implement:
   *   function executeOperation(
   *     address asset,
   *     uint256 amount,
   *     uint256 premium,
   *     address initiator,
   *     bytes params
   *   ) external returns (bool);
   *
   * And repay (amount + premium) to the Pool before returning.
   */
  buildFlashloanSimpleCalldata(params: FlashloanParams): `0x${string}` {
    // flashLoanSimple selector = 0xab9c4b5d
    const selector = '0xab9c4b5d';
    const receiver = params.receiverAddress.slice(2).toLowerCase().padStart(64, '0');
    const asset = params.asset.slice(2).toLowerCase().padStart(64, '0');
    const amount = params.amount.toString(16).padStart(64, '0');
    const paramsOffset = '0000000000000000000000000000000000000000000000000000000000000100'; // offset = 256 bytes
    const referralCode = (params.referralCode ?? 0).toString(16).padStart(8, '0').padStart(64, '0');
    const paramsLength = (Math.floor((params.params.length - 2) / 2)).toString(16).padStart(64, '0');
    const paramsData = params.params.slice(2).padEnd(Math.ceil((params.params.length - 2) / 2) * 2 * 64, '0');

    return `${selector}${receiver}${asset}${amount}${paramsOffset}${referralCode}${paramsLength}${paramsData}` as `0x${string}`;
  }

  /**
   * Check if a specific asset is available for flashloaning
   * by querying getReserveData.
   */
  async isAssetAvailable(
    asset: Address,
    hyperEvmRpc: string = 'https://rpc.hyperliquid.xyz/evm'
  ): Promise<boolean> {
    try {
      // getReserveData selector = 0x35ea7eb2
      const data = `0x35ea7eb2${asset.slice(2).toLowerCase().padStart(64, '0')}`;
      const res = await fetch(hyperEvmRpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to: this.poolAddress, data }, 'latest'],
          id: 1,
        }),
      });
      const json = await res.json() as { result?: string };
      const result = json.result || '0x';
      // If we get a non-empty result with totalAToken > 0, asset is available
      if (result.length >= 194) {
        const totalAToken = BigInt('0x' + result.slice(2, 66));
        return totalAToken > 0n;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get the current liquidity available for a specific asset.
   * This is the total aToken supply = total flashloanable amount.
   */
  async getAvailableLiquidity(
    asset: Address,
    hyperEvmRpc: string = 'https://rpc.hyperliquid.xyz/evm'
  ): Promise<bigint> {
    try {
      const data = `0x35ea7eb2${asset.slice(2).toLowerCase().padStart(64, '0')}`;
      const res = await fetch(hyperEvmRpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to: this.poolAddress, data }, 'latest'],
          id: 1,
        }),
      });
      const json = await res.json() as { result?: string };
      const result = json.result || '0x';
      if (result.length >= 194) {
        // totalAToken is the 3rd return value (offset 128-192)
        return BigInt('0x' + result.slice(130, 194));
      }
      return 0n;
    } catch {
      return 0n;
    }
  }
}
