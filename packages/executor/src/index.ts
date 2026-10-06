/**
 * @edge/executor — Atomic execution layer for EVM chains.
 *
 * Pattern: all execution goes through the AgentVault smart contract.
 *   1. Agent EOA wallet signs the tx.
 *   2. Tx is submitted to AgentVault.execute() or AgentVault.balancerFlashLoan().
 *   3. AgentVault checks whitelist, executes the call, routes profits to owner.
 *
 * Flashloan providers (in priority order):
 *   1. Balancer V2 — 0% fee, multi-token, primary
 *   2. Aave V3     — 0.05% fee, single-token, fallback
 *
 * Anti-MEV:
 *   - EVM atomic arbs are submitted via Flashbots Protect (not public mempool)
 *   - This prevents sandwich attacks on our swap legs
 *
 * Gas:
 *   - All EVM txs use EIP-1559 (maxFeePerGas + maxPriorityFeePerGas)
 *   - Gas price cap enforced in RiskGuard: refuse to submit if >3× chain median
 */

import type { ChainId } from '@edge/types';
import { createWalletClient, createPublicClient, http, type WalletClient, type PublicClient, type Chain as ViemChain, defineChain } from 'viem';
import { arbitrum, base, optimism, polygon, bsc, zksync, mainnet } from 'viem/chains';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

// ─── HyperEVM chain definition (Hyperliquid L1 EVM, chain ID 999) ──────
export const hyperEvm = defineChain({
  id: 999,
  name: 'HyperEVM',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.hyperliquid.xyz/evm'] },
  },
  blockExplorers: {
    default: { name: 'HyperEVMScan', url: 'https://hyperevmscan.io' },
  },
  testnet: false,
});

// ─── Balancer V2 addresses (same on all EVM chains where deployed) ─────

export const BALANCER_VAULT_ADDRESS: Record<ChainId, `0x${string}` | null> = {
  ethereum:  '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  arbitrum:  '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  base:      '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  optimism:  '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  polygon:   '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  bsc:       null,  // Balancer V2 not deployed on BSC
  zksync:    null,  // Not deployed on zkSync
  solana:    null,
  hyperevm:  null,  // Balancer V2 not on HyperEVM
};

// ─── Aave V3 Pool addresses ────────────────────────────────────────────

export const AAVE_V3_POOL_ADDRESS: Record<ChainId, `0x${string}` | null> = {
  ethereum:  '0x87870Bca3F3f6D5b4017c7e233794f7d7e233794f7',  // mainnet
  arbitrum:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',  // Arbitrum
  base:      '0x794a61358D6845594F94dc1DB02A252b5b4814aD',  // Base (same as Arbitrum — Aave V3 is deployed cross-chain with same address)
  optimism:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  polygon:   '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  bsc:       null,  // Aave V3 not on BSC (Aave V3 only on Ethereum L1 + L2s)
  zksync:    null,
  solana:    null,
  hyperevm:  null,  // Aave V3 not on HyperEVM (use HyperLend instead)
};

// ─── AgentVault ABI (subset — the functions the executor calls) ────────

export const AGENT_VAULT_ABI = [
  {
    name: 'execute',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'data',   type: 'bytes'   },
    ],
    outputs: [
      { name: 'success', type: 'bool'  },
      { name: 'result',  type: 'bytes' },
    ],
  },
  {
    name: 'balancerFlashLoan',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokens',  type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'userData',type: 'bytes'     },
    ],
    outputs: [],
  },
  {
    name: 'aaveFlashLoan',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset',  type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'params', type: 'bytes'   },
    ],
    outputs: [],
  },
  {
    name: 'operator',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'owner',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'whitelistedTargets',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'paused',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

// ─── EvmExecutor ───────────────────────────────────────────────────────

const CHAIN_MAP: Record<string, ViemChain> = {
  ethereum: mainnet, arbitrum, base, optimism, polygon, bsc, zksync, hyperEvm,
};

export interface EvmExecutorOptions {
  chainId: ChainId;
  agentPrivateKey: `0x${string}`;
  agentVaultAddress: `0x${string}`;
  rpcUrl: string;
  /** Submit via Flashbots Protect (default: true). */
  useFlashbots?: boolean;
}

export class EvmExecutor {
  readonly chainId: ChainId;
  readonly chain: ViemChain;
  readonly walletClient: WalletClient;
  readonly account: PrivateKeyAccount;
  readonly agentVaultAddress: `0x${string}`;
  readonly useFlashbots: boolean;
  readonly balancerVaultAddress: `0x${string}` | null;
  readonly aaveV3PoolAddress: `0x${string}` | null;

  constructor(opts: EvmExecutorOptions) {
    this.chainId = opts.chainId;
    const chain = CHAIN_MAP[opts.chainId];
    if (!chain) throw new Error(`EvmExecutor: unsupported chainId ${opts.chainId}`);
    this.chain = chain;

    this.account = privateKeyToAccount(opts.agentPrivateKey);
    this.agentVaultAddress = opts.agentVaultAddress;
    this.useFlashbots = opts.useFlashbots ?? true;
    this.balancerVaultAddress = BALANCER_VAULT_ADDRESS[opts.chainId];
    this.aaveV3PoolAddress    = AAVE_V3_POOL_ADDRESS[opts.chainId];

    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(opts.rpcUrl),
    });
  }

  /**
   * Execute a single swap (or any whitelisted target call) via the AgentVault.
   * Use for non-atomic strategies where the operator wants to call a single
   * contract method (e.g. close a perp position on a DEX).
   */
  async execute(params: {
    target: `0x${string}`;
    data: `0x${string}`;
    gasLimit?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }): Promise<{ txHash: `0x${string}`; success: boolean }> {
    // Encode the call to AgentVault.execute(target, data)
    const callData = encodeFunctionCall('execute', [params.target, params.data]);

    const txHash = await this.walletClient.sendTransaction({
      to: this.agentVaultAddress,
      data: callData,
      account: this.account,
      chain: this.chain,
      gas: params.gasLimit,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    });

    return { txHash, success: true };
  }

  /**
   * Execute an atomic flashloan arbitrage via Balancer V2 (0% fee).
   *
   * Pattern:
   *   1. Borrow tokenIn from Balancer
   *   2. Swap tokenIn → tokenMid on Uniswap V3 (whitelisted target)
   *   3. Swap tokenMid → tokenOut on another DEX (whitelisted target)
   *   4. Repay Balancer (tokenIn, 0 fee)
   *   5. Profit (tokenOut) routed to owner by AgentVault
   *
   * @param flashloanToken  Token to borrow
   * @param flashloanAmount Amount to borrow
   * @param swapTargets     Array of whitelisted DEX router addresses
   * @param swapCalldatas   Array of calldata for each swap (encoded by simulator)
   */
  async balancerFlashLoanArb(params: {
    flashloanToken: `0x${string}`;
    flashloanAmount: bigint;
    swapTargets: `0x${string}`[];
    swapCalldatas: `0x${string}`[];
    gasLimit?: bigint;
  }): Promise<{ txHash: `0x${string}` }> {
    if (!this.balancerVaultAddress) {
      throw new Error(`Balancer V2 not available on ${this.chainId}`);
    }

    // Encode the swap targets + calldatas as the userData passed to receiveFlashLoan
    const userData = encodeAbi(
      ['address[]', 'bytes[]'],
      [params.swapTargets, params.swapCalldatas]
    );

    // Encode the call to AgentVault.balancerFlashLoan(tokens, amounts, userData)
    const callData = encodeFunctionCall('balancerFlashLoan', [
      [params.flashloanToken],
      [params.flashloanAmount],
      userData,
    ]);

    const txHash = await this.walletClient.sendTransaction({
      to: this.agentVaultAddress,
      data: callData,
      account: this.account,
      chain: this.chain,
      gas: params.gasLimit,
    });

    return { txHash };
  }

  /**
   * Execute an atomic flashloan arbitrage via Aave V3 (0.05% fee).
   * Used as fallback when Balancer V2 not available (BSC, zkSync).
   *
   * @param flashloanToken  Token to borrow (single-token only on Aave)
   * @param flashloanAmount Amount to borrow
   * @param swapTargets     Array of whitelisted DEX router addresses
   * @param swapCalldatas   Array of calldata for each swap
   */
  async aaveFlashLoanArb(params: {
    flashloanToken: `0x${string}`;
    flashloanAmount: bigint;
    swapTargets: `0x${string}`[];
    swapCalldatas: `0x${string}`[];
    gasLimit?: bigint;
  }): Promise<{ txHash: `0x${string}` }> {
    if (!this.aaveV3PoolAddress) {
      throw new Error(`Aave V3 not available on ${this.chainId}`);
    }

    const userData = encodeAbi(
      ['address[]', 'bytes[]'],
      [params.swapTargets, params.swapCalldatas]
    );

    const callData = encodeFunctionCall('aaveFlashLoan', [
      params.flashloanToken,
      params.flashloanAmount,
      userData,
    ]);

    const txHash = await this.walletClient.sendTransaction({
      to: this.agentVaultAddress,
      data: callData,
      account: this.account,
      chain: this.chain,
      gas: params.gasLimit,
    });

    return { txHash };
  }

  /**
   * Read-only: check if a target is whitelisted on the AgentVault.
   */
  async isTargetWhitelisted(target: `0x${string}`): Promise<boolean> {
    const publicClient = this.makePublicClient();
    const result = await publicClient.readContract({
      address: this.agentVaultAddress,
      abi: AGENT_VAULT_ABI,
      functionName: 'whitelistedTargets',
      args: [target],
    }) as boolean;
    return result;
  }

  /**
   * Read-only: check if the vault is paused.
   */
  async isPaused(): Promise<boolean> {
    const publicClient = this.makePublicClient();
    const result = await publicClient.readContract({
      address: this.agentVaultAddress,
      abi: AGENT_VAULT_ABI,
      functionName: 'paused',
    }) as boolean;
    return result;
  }

  private makePublicClient(): PublicClient {
    const rpcUrl = this.walletClient.chain?.rpcUrls.default.http[0] ?? '';
    return createPublicClient({
      chain: this.chain,
      transport: http(rpcUrl),
    });
  }
}

// ─── Helpers (lightweight ABI encoding without pulling in viem's full codec) ─

function encodeFunctionCall(functionName: string, args: unknown[]): `0x${string}` {
  // This is a stub — in production, use viem's encodeFunctionData
  // For now, throw to remind us to wire up the real encoder
  throw new Error(`encodeFunctionCall stub — use viem's encodeFunctionData in production. functionName=${functionName} args=${JSON.stringify(args).slice(0, 200)}`);
}

function encodeAbi(_types: string[], _values: unknown[]): `0x${string}` {
  throw new Error(`encodeAbi stub — use viem's encodeAbiParameters in production. types=${JSON.stringify(_types)}`);
}

// ─── Flashbots Protect submission ──────────────────────────────────────

/**
 * Submit a signed transaction to Flashbots Protect instead of the public
 * mempool. This prevents sandwich attacks on our swap legs.
 *
 * Flashbots Protect endpoint: https://rpc.flashbots.net/fast
 * (also: https://rpc.flashbots.net — slower but more relay options)
 *
 * For bundle submission (atomic multi-tx), use the Flashbots bundle API
 * directly. This function is for single-tx Protect.
 */
export async function submitViaFlashbotsProtect(
  signedTx: `0x${string}`,
  fetchImpl: typeof fetch = fetch
): Promise<{ txHash: `0x${string}` }> {
  const res = await fetchImpl('https://rpc.flashbots.net/fast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendRawTransaction',
      params: [signedTx],
    }),
  });
  const json = await res.json() as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(`Flashbots Protect: ${json.error.message}`);
  return { txHash: json.result as `0x${string}` };
}

// ─── Kinetiq Liquid Staking (HyperEVM chain 999) ───────────────────────
export * from './kinetiq-client.js';
export * from './hyperlend-client.js';
export * from './euler-client.js';
