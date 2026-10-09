/**
 * CoreWriterClient — TypeScript client for Hyperliquid CoreWriter.
 *
 * CoreWriter (0x3333...3333) lets HyperEVM smart contracts send actions to HyperCore.
 * Actions include: place orders, transfer USD, approve builder fees, stake, etc.
 *
 * Action encoding:
 *   Byte 1: Version (0x01)
 *   Bytes 2-4: Action ID (big-endian)
 *   Rest: ABI-encoded action parameters
 *
 * Key actions:
 *   0x01000001: Place limit order on HL perp
 *   0x01000002: Vault transfer
 *   0x0100000c: Approve builder fee
 *
 * This enables ATOMIC arb between HL perps and HyperEVM DEXs:
 *   1. Read HL perp price via precompile (0x...0807)
 *   2. Read HyperSwap price (on-chain)
 *   3. Flashloan USDC from HyperLend
 *   4. Buy on cheaper venue (HyperSwap swap or CoreWriter order)
 *   5. Sell on expensive venue
 *   6. Repay flashloan
 *   7. ALL in one HyperEVM transaction!
 */

import type { Address } from 'viem';

export const COREWRITER_ADDRESS = '0x3333333333333333333333333333333333333333' as Address;

// Action IDs (version 0x01 + 3-byte action ID)
export const ACTIONS = {
  LIMIT_ORDER:         0x01000001,
  VAULT_TRANSFER:      0x01000002,
  TOKEN_DELEGATE:      0x01000003,
  STAKING_DEPOSIT:     0x01000004,
  STAKING_WITHDRAW:    0x01000005,
  SPOT_SEND:           0x01000006,
  USD_CLASS_TRANSFER:  0x01000007,
  FINALIZE_EVM_CONTRACT: 0x01000008,
  ADD_API_WALLET:      0x01000009,
  CANCEL_ORDER_BY_OID: 0x0100000a,
  CANCEL_ORDER_BY_CLOID: 0x0100000b,
  APPROVE_BUILDER_FEE: 0x0100000c,
  SEND_ASSET:          0x0100000d,
  BORROW_LEND_OPERATION: 0x0100000f,
} as const;

export type TimeInForce = 'ALO' | 'GTC' | 'IOC';

const TIF_MAP: Record<TimeInForce, number> = {
  ALO: 1, GTC: 2, IOC: 3,
};

export class CoreWriterClient {
  /**
   * Encode a limit order action for sending to CoreWriter.
   *
   * @param asset Perp asset index (from HL meta universe)
   * @param isBuy Buy (true) or sell (false)
   * @param limitPx Raw limit price in HyperCore units
   * @param sz Raw size in HyperCore units
   * @param reduceOnly Whether this is reduce-only
   * @param tif Time in force (ALO/GTC/IOC)
   * @param cloid Client order ID (0 = none)
   * @returns Encoded bytes for CoreWriter.sendRawAction()
   */
  encodeLimitOrder(
    asset: number,
    isBuy: boolean,
    limitPx: bigint,
    sz: bigint,
    reduceOnly: boolean,
    tif: TimeInForce,
    cloid: bigint = 0n,
  ): `0x${string}` {
    // Action header: 4 bytes (version + action ID)
    const header = ACTIONS.LIMIT_ORDER.toString(16).padStart(8, '0');

    // ABI-encoded parameters:
    // uint32 asset, bool isBuy, uint64 limitPx, uint64 sz,
    // bool reduceOnly, uint8 tif, uint128 cloid
    const assetHex = asset.toString(16).padStart(64, '0');
    const isBuyHex = isBuy ? '1' : '0';
    const isBuyPadded = isBuyHex.padStart(64, '0');
    const limitPxHex = limitPx.toString(16).padStart(64, '0');
    const szHex = sz.toString(16).padStart(64, '0');
    const reduceOnlyHex = (reduceOnly ? '1' : '0').padStart(64, '0');
    const tifHex = TIF_MAP[tif].toString(16).padStart(64, '0');
    const cloidHex = cloid.toString(16).padStart(64, '0');

    return `0x${header}${assetHex}${isBuyPadded}${limitPxHex}${szHex}${reduceOnlyHex}${tifHex}${cloidHex}` as `0x${string}`;
  }

  /**
   * Encode an approve builder fee action.
   *
   * @param builderAddress Builder address to approve
   * @param maxFeeRate Maximum fee rate (in bps, max 10 = 0.1%)
   * @returns Encoded bytes for CoreWriter.sendRawAction()
   */
  encodeApproveBuilderFee(
    builderAddress: Address,
    maxFeeRate: number,
  ): `0x${string}` {
    const header = ACTIONS.APPROVE_BUILDER_FEE.toString(16).padStart(8, '0');
    const addrHex = builderAddress.slice(2).toLowerCase().padStart(64, '0');
    const feeHex = maxFeeRate.toString(16).padStart(64, '0');
    return `0x${header}${addrHex}${feeHex}` as `0x${string}`;
  }

  /**
   * Encode a USD class transfer (move USDC between spot and perp accounts).
   *
   * @param amount Amount to transfer
   * @param toPerp Transfer to perp (true) or to spot (false)
   * @returns Encoded bytes for CoreWriter.sendRawAction()
   */
  encodeUsdClassTransfer(
    amount: bigint,
    toPerp: boolean,
  ): `0x${string}` {
    const header = ACTIONS.USD_CLASS_TRANSFER.toString(16).padStart(8, '0');
    const amountHex = amount.toString(16).padStart(64, '0');
    const toPerpHex = (toPerp ? '1' : '0').padStart(64, '0');
    return `0x${header}${amountHex}${toPerpHex}` as `0x${string}`;
  }

  /**
   * Build the calldata for calling CoreWriter.sendRawAction(encodedAction).
   */
  buildSendRawActionCall(encodedAction: `0x${string}`): { to: Address; data: `0x${string}` } {
    // sendRawAction(bytes) selector = 0xc6b32e63
    // Actually we need to ABI-encode the call: function selector + offset + length + data
    const selector = '0xc6b32e63'; // sendRawAction(bytes)
    const dataLength = (encodedAction.length - 2) / 2;
    const offset = '0000000000000000000000000000000000000000000000000000000000000020';
    const length = dataLength.toString(16).padStart(64, '0');
    const dataPadded = encodedAction.slice(2).padEnd(Math.ceil(dataLength / 32) * 64, '0');
    return {
      to: COREWRITER_ADDRESS,
      data: `${selector}${offset}${length}${dataPadded}` as `0x${string}`,
    };
  }
}
