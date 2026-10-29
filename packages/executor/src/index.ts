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
 *   - A standalone submitViaFlashbotsProtect() helper exists for submitting
 *     signed transactions to the Flashbots Protect relay.
 *   - As of this commit, the Flashbots Protect path is NOT wired into
 *     EvmExecutor.execute() or the flashloan methods. All execution methods
 *     use walletClient.sendTransaction() which submits to the PUBLIC MEMPOOL.
 *     There is no `useFlashbots` option — if Flashbots is needed, the caller
 *     must use the sign-then-submit flow explicitly. See the "Remaining
 *     limitations" section in PR #2 for details.
 *
 * Gas:
 *   - All EVM txs use EIP-1559 (maxFeePerGas + maxPriorityFeePerGas)
 *   - Gas price cap enforced in RiskGuard: refuse to submit if >3× chain median
 *
 * Fail-closed semantics:
 *   - execute() and flashloan methods return an ExecutionResult whose `status`
 *     field is the AUTHORITATIVE indicator of outcome. A tx hash alone is
 *     NEVER reported as success.
 *
 *   Status semantics (exhaustive):
 *     - 'submitted':  sendTransaction returned a tx hash, but the receipt is
 *                     NOT yet available. This happens when:
 *                       (a) waitForReceipt=false (caller chose not to wait), OR
 *                       (b) waitForReceipt=true but the receipt did not arrive
 *                           within receiptTimeoutMs (timeout).
 *                     In both cases the tx MAY still be mined, revert, or be
 *                     dropped. The caller CANNOT assume success. To confirm,
 *                     the caller must separately fetch the receipt.
 *     - 'confirmed':  receipt fetched, status=1. The tx was mined and did NOT
 *                     revert. This is the ONLY status that means "success".
 *     - 'reverted':   receipt fetched, status=0. The tx was mined but reverted.
 *                     gasUsed and blockNumber are populated; reason contains
 *                     a generic "transaction reverted" message (the EVM does
 *                     not return the revert reason in the receipt itself;
 *                     decoding it requires a separate eth_call trace).
 *     - 'error':      sendTransaction itself failed (e.g., insufficient funds,
 *                     RPC error, nonce too low). No tx hash was obtained.
 *                     txHash is null. The tx was NOT submitted.
 *
 *   IMPORTANT: status='submitted' does NOT mean 'confirmed'. It means
 *   "submitted but unconfirmed". A timeout is NOT an error — it is a
 *   'submitted' result with a reason explaining the timeout. An RPC failure
 *   during sendTransaction is an 'error', not a 'submitted'.
 */

import type { ChainId } from '@edge/types';
import { createWalletClient, createPublicClient, http, type WalletClient, type PublicClient, type Chain as ViemChain, defineChain } from 'viem';
import { arbitrum, base, optimism, polygon, bsc, zksync, mainnet } from 'viem/chains';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { encodeFunctionData, encodeAbiParameters, type Abi } from 'viem';
import { assertExecutionAuthorized } from '@edge/risk';

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
// Source: bgd-labs/aave-address-book (canonical Aave governance registry)
// https://github.com/bgd-labs/aave-address-book
//
// NOTE: This map is an AVAILABILITY GATE, not a transaction destination.
// The executor checks `aaveV3PoolAddress !== null` to decide whether the
// Aave flashloan path is available on a given chain. The AgentVault
// contract stores its own `aaveV3Pool` immutable address set at deploy
// time; the executor does NOT send transactions to this address directly.

export const AAVE_V3_POOL_ADDRESS: Record<ChainId, `0x${string}` | null> = {
  ethereum:  '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',  // AaveV3Ethereum.sol
  arbitrum:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',  // AaveV3Arbitrum.sol
  base:      '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',  // AaveV3Base.sol (NOT same as Arbitrum)
  optimism:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',  // AaveV3Optimism.sol
  polygon:   '0x794a61358D6845594F94dc1DB02A252b5b4814aD',  // AaveV3Polygon.sol
  bsc:       '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',  // AaveV3BNB.sol
  zksync:    '0x78e30497a3c7527d953c6B1E3541b021A98Ac43c',  // AaveV3ZkSync.sol
  solana:    null,   // not an EVM chain
  hyperevm:  null,   // Aave V3 not on HyperEVM (use HyperLend instead)
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

// ─── Fail-closed execution result ──────────────────────────────────────

/**
 * Result of an executor transaction. The `status` field is the authoritative
 * indicator of outcome — a tx hash alone is NEVER sufficient.
 *
 * - 'submitted':  tx hash obtained from sendTransaction, but receipt not yet
 *                 available. The tx may still revert, be dropped, or be
 *                 replaced. Treat as pending.
 * - 'confirmed':  receipt fetched, status=1 (success). The tx was mined and
 *                 did not revert.
 * - 'reverted':   receipt fetched, status=0. The tx was mined but reverted.
 * - 'error':      RPC or receipt-fetch failure. The tx may or may not have
 *                 been submitted; the caller should check the error message.
 */
export type ExecutionStatus = 'submitted' | 'confirmed' | 'reverted' | 'error';

export interface ExecutionResult {
  /** Tx hash (always populated when status is submitted/confirmed/reverted). */
  txHash: `0x${string}` | null;
  /** Authoritative outcome. Never rely on txHash alone. */
  status: ExecutionStatus;
  /** Gas used (only when status is confirmed/reverted). */
  gasUsed?: bigint;
  /** Revert reason or error message (only when status is reverted/error). */
  reason?: string;
  /** Block number the tx was included in (only when status is confirmed/reverted). */
  blockNumber?: bigint;
  /** Raw error object if status is 'error'. */
  error?: unknown;
}

// ─── EvmExecutor ───────────────────────────────────────────────────────

const CHAIN_MAP: Record<string, ViemChain> = {
  ethereum: mainnet,
  arbitrum,
  base,
  optimism,
  polygon,
  bsc,
  zksync,
  hyperevm: hyperEvm,
};

export interface EvmExecutorOptions {
  chainId: ChainId;
  agentPrivateKey: `0x${string}`;
  agentVaultAddress: `0x${string}`;
  rpcUrl: string;
  /** Whether to block until the tx receipt is available (default: true). */
  waitForReceipt?: boolean;
  /** Receipt fetch timeout in ms (default: 60000 = 60s). */
  receiptTimeoutMs?: number;
  /** Polling interval for receipt fetch in ms (default: 2000). */
  receiptPollMs?: number;
}

export class EvmExecutor {
  readonly chainId: ChainId;
  readonly chain: ViemChain;
  readonly publicClient: PublicClient;
  readonly agentVaultAddress: `0x${string}`;
  readonly waitForReceipt: boolean;
  readonly receiptTimeoutMs: number;
  readonly receiptPollMs: number;
  readonly balancerVaultAddress: `0x${string}` | null;
  readonly aaveV3PoolAddress: `0x${string}` | null;

  // ─── HARD-PRIVATE signer material (Phase-0.5, work order A) ────────────
  //
  // These were previously `readonly walletClient` / `readonly account` —
  // PUBLIC properties. Any caller holding an executor instance could call
  // `executor.walletClient.sendTransaction({ to: any, data: any })`
  // directly, bypassing the per-submission 'evm-executor:send-transaction'
  // guard after satisfying the constructor guard only once. TypeScript
  // `private` would NOT fix this: it is compile-time only, and the compiled
  // JS keeps the property as a normal runtime own-property reachable via
  // untyped callers or reflection.
  //
  // ECMAScript `#` private fields are genuinely private at runtime: they
  // are not own properties of the instance (Object.getOwnPropertyNames /
  // JSON / reflection cannot see them) and are lexically unreachable from
  // outside this class body. The raw viem WalletClient and the
  // key-derived PrivateKeyAccount are therefore no longer obtainable from
  // any caller; the ONLY way to submit is through the guarded methods
  // below, each of which re-checks its scope (and expiry) per call.
  #walletClient: WalletClient;
  #account: PrivateKeyAccount;

  constructor(opts: EvmExecutorOptions) {
    // EM-STRAT-012 Phase-0: fail-closed gate BEFORE any signer/key material
    // is touched. Construction enables submission, so it requires the
    // 'evm-executor:construct-signer' scope.
    assertExecutionAuthorized('evm-executor:construct-signer');

    this.chainId = opts.chainId;
    const chain = CHAIN_MAP[opts.chainId];
    if (!chain) throw new Error(`EvmExecutor: unsupported chainId ${opts.chainId}`);
    this.chain = chain;

    this.#account = privateKeyToAccount(opts.agentPrivateKey);
    this.agentVaultAddress = opts.agentVaultAddress;
    this.waitForReceipt = opts.waitForReceipt ?? true;
    this.receiptTimeoutMs = opts.receiptTimeoutMs ?? 60_000;
    this.receiptPollMs = opts.receiptPollMs ?? 2_000;
    this.balancerVaultAddress = BALANCER_VAULT_ADDRESS[opts.chainId];
    this.aaveV3PoolAddress    = AAVE_V3_POOL_ADDRESS[opts.chainId];

    this.#walletClient = createWalletClient({
      account: this.#account,
      chain,
      transport: http(opts.rpcUrl),
    });
    this.publicClient = createPublicClient({
      chain,
      transport: http(opts.rpcUrl),
    });
  }

  /**
   * Execute a single swap (or any whitelisted target call) via the AgentVault.
   * Use for non-atomic strategies where the operator wants to call a single
   * contract method (e.g. close a perp position on a DEX).
   *
   * Fail-closed: returns status='confirmed' only if the receipt shows status=1.
   */
  async execute(params: {
    target: `0x${string}`;
    data: `0x${string}`;
    gasLimit?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }): Promise<ExecutionResult> {
    // EM-STRAT-012 Phase-0: re-checked per submission so an existing instance
    // cannot submit after authorization expires. Preserved from main — the
    // per-submission guard is mandatory on EVERY submission path.
    assertExecutionAuthorized('evm-executor:send-transaction');
    // Encode the call to AgentVault.execute(target, data)
    const callData = encodeVaultFunctionCall('execute', [params.target, params.data]);

    return this.submitAndWait({
      to: this.agentVaultAddress,
      data: callData,
      gas: params.gasLimit,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    });
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
  }): Promise<ExecutionResult> {
    // EM-STRAT-012 Phase-0: re-checked per submission, before any validation,
    // encoding, or transport work. Preserved from main.
    assertExecutionAuthorized('evm-executor:send-transaction');
    if (!this.balancerVaultAddress) {
      throw new Error(`Balancer V2 not available on ${this.chainId}`);
    }

    // Encode the swap targets + calldatas as the userData passed to receiveFlashLoan
    const userData = encodeAbi(
      [{ type: 'address[]' }, { type: 'bytes[]' }],
      [params.swapTargets, params.swapCalldatas]
    );

    // Encode the call to AgentVault.balancerFlashLoan(tokens, amounts, userData)
    const callData = encodeVaultFunctionCall('balancerFlashLoan', [
      [params.flashloanToken],
      [params.flashloanAmount],
      userData,
    ]);

    return this.submitAndWait({
      to: this.agentVaultAddress,
      data: callData,
      gas: params.gasLimit,
    });
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
  }): Promise<ExecutionResult> {
    // EM-STRAT-012 Phase-0: re-checked per submission, before any validation,
    // encoding, or transport work. Preserved from main.
    assertExecutionAuthorized('evm-executor:send-transaction');
    if (!this.aaveV3PoolAddress) {
      throw new Error(`Aave V3 not available on ${this.chainId}`);
    }

    const userData = encodeAbi(
      [{ type: 'address[]' }, { type: 'bytes[]' }],
      [params.swapTargets, params.swapCalldatas]
    );

    const callData = encodeVaultFunctionCall('aaveFlashLoan', [
      params.flashloanToken,
      params.flashloanAmount,
      userData,
    ]);

    return this.submitAndWait({
      to: this.agentVaultAddress,
      data: callData,
      gas: params.gasLimit,
    });
  }

  /**
   * Read-only: check if a target is whitelisted on the AgentVault.
   */
  async isTargetWhitelisted(target: `0x${string}`): Promise<boolean> {
    const result = await this.publicClient.readContract({
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
    const result = await this.publicClient.readContract({
      address: this.agentVaultAddress,
      abi: AGENT_VAULT_ABI,
      functionName: 'paused',
    }) as boolean;
    return result;
  }

  // ─── Internal: submit + wait for receipt (fail-closed) ───────────────

  /**
   * Submit a transaction and (optionally) wait for its receipt.
   * Returns a fail-closed ExecutionResult. A tx hash alone is NEVER reported
   * as success — status='confirmed' requires a receipt with status=1.
   */
  private async submitAndWait(params: {
    to: `0x${string}`;
    data: `0x${string}`;
    gas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }): Promise<ExecutionResult> {
    // Defense-in-depth (reconciliation of PR #2 with main's guard): the sink
    // itself re-checks the scope, even though every public entry point
    // (execute / balancerFlashLoanArb / aaveFlashLoanArb) already asserts
    // 'evm-executor:send-transaction' before calling this method. Containment
    // at the sink means the raw sendTransaction call can never be reached
    // without a currently-valid authorization, regardless of future callers.
    assertExecutionAuthorized('evm-executor:send-transaction');
    let txHash: `0x${string}`;
    try {
      txHash = await this.#walletClient.sendTransaction({
        to: params.to,
        data: params.data,
        account: this.#account,
        chain: this.chain,
        gas: params.gas,
        maxFeePerGas: params.maxFeePerGas,
        maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      });
    } catch (err: unknown) {
      return {
        txHash: null,
        status: 'error',
        reason: err instanceof Error ? err.message : String(err),
        error: err,
      };
    }

    if (!this.waitForReceipt) {
      return { txHash, status: 'submitted' };
    }

    // Wait for receipt with timeout
    const deadline = Date.now() + this.receiptTimeoutMs;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
        if (receipt) {
          if (receipt.status === 'success') {
            return {
              txHash,
              status: 'confirmed',
              gasUsed: receipt.gasUsed,
              blockNumber: receipt.blockNumber,
            };
          } else {
            return {
              txHash,
              status: 'reverted',
              gasUsed: receipt.gasUsed,
              blockNumber: receipt.blockNumber,
              reason: 'transaction reverted (status=0)',
            };
          }
        }
      } catch (err: unknown) {
        lastErr = err;
        // Receipt not yet available — keep polling
      }
      await sleep(this.receiptPollMs);
    }

    // Timeout — tx was submitted but receipt not obtained
    return {
      txHash,
      status: 'submitted',
      reason: lastErr instanceof Error
        ? `receipt timeout after ${this.receiptTimeoutMs}ms; last error: ${lastErr.message}`
        : `receipt timeout after ${this.receiptTimeoutMs}ms`,
    };
  }
}

// ─── Helpers (viem-based ABI encoding) ─────────────────────────────────

/**
 * Encode a function call to the AgentVault using viem's encodeFunctionData.
 * Throws if the function name is not in AGENT_VAULT_ABI or if the args
 * don't match the expected types.
 */
export function encodeVaultFunctionCall(functionName: string, args: readonly unknown[]): `0x${string}` {
  return encodeFunctionData({
    abi: AGENT_VAULT_ABI as Abi,
    functionName,
    args: args as readonly unknown[],
  });
}

/**
 * Encode ABI parameters using viem's encodeAbiParameters.
 * Each param is { type: string } paired with a value.
 * Throws if the types/values don't match.
 */
export function encodeAbi(
  params: { type: string }[],
  values: readonly unknown[]
): `0x${string}` {
  return encodeAbiParameters(
    params as Parameters<typeof encodeAbiParameters>[0],
    values as Parameters<typeof encodeAbiParameters>[1],
  );
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
 *
 * NOTE (PR #2): as of this commit, this function is standalone and is NOT
 * wired into EvmExecutor.execute() or the flashloan methods. Those methods
 * submit via submitAndWait() which goes to the public mempool. Wiring
 * Flashbots into the executor requires a sign-then-submit flow:
 *   1. walletClient.signTransaction(...) to get a signed raw tx
 *   2. submitViaFlashbotsProtect(signedTx) to submit to the relay
 * This is left as a future task.
 *
 * EM-STRAT-012 Phase-0.5 (work order A/E, from main): this IS a submission
 * sink — it broadcasts a real signed transaction (`eth_sendRawTransaction`).
 * It was previously ungated: although the caller must supply an
 * already-signed tx, broadcasting is the capital-moving step. It requires
 * the same 'evm-executor:send-transaction' scope as every other EVM
 * submission and is inventoried in the submission-sink census.
 */
export async function submitViaFlashbotsProtect(
  signedTx: `0x${string}`,
  fetchImpl: typeof fetch = fetch
): Promise<{ txHash: `0x${string}` }> {
  // Fail-closed BEFORE any network request.
  assertExecutionAuthorized('evm-executor:send-transaction');
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
export * from './builder-code-client.js';
export * from './corewriter-client.js';
