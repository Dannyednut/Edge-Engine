/**
 * executor.test.ts — Deterministic unit tests for @edge/executor
 * ─────────────────────────────────────────────────────────────────────
 * Tests cover:
 *   1. ABI encoding (selectors + calldata) via encodeVaultFunctionCall
 *   2. Dynamic arrays + bytes encoding via encodeAbi
 *   3. Encoding failures (invalid function name, wrong arg types)
 *   4. ExecutionResult status semantics (submitted/confirmed/reverted/error)
 *   5. Successful receipt handling
 *   6. Reverted receipt handling
 *   7. RPC/receipt-fetch error handling
 *   8. Receipt timeout (submitted without confirmation)
 *   9. waitForReceipt=false returns immediately
 *  10. Flashbots Protect helper (mocked fetch)
 *
 * No real transactions are broadcast. All viem clients use mocked
 * transports or injected stubs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  encodeVaultFunctionCall,
  encodeAbi,
  AGENT_VAULT_ABI,
  EvmExecutor,
  submitViaFlashbotsProtect,
  AAVE_V3_POOL_ADDRESS,
  BALANCER_VAULT_ADDRESS,
  type ExecutionResult,
} from '../src/index.js';
import { keccak256, encodeFunctionData, encodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ─── Constants ────────────────────────────────────────────────────────

const TEST_PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`;
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY);
const AGENT_VAULT = '0x0000000000000000000000000000000000000123' as `0x${string}`;
const TARGET = '0x0000000000000000000000000000000000000456' as `0x${string}`;
const TOKEN = '0x0000000000000000000000000000000000000789' as `0x${string}`;
const DUMMY_DATA = '0xdeadbeef' as `0x${string}`;

// ─── Helpers ──────────────────────────────────────────────────────────

/** Compute the expected 4-byte selector for a function signature. */
function selectorOf(sig: string): `0x${string}` {
  return keccak256(new TextEncoder().encode(sig)).slice(0, 10) as `0x${string}`;
}

/** Pad an address to 32 bytes hex. */
function padAddress(addr: `0x${string}`): string {
  return addr.toLowerCase().slice(2).padStart(64, '0');
}

/** Pad a uint256 to 32 bytes hex. */
function padUint256(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

// ─── 1. ABI encoding: selectors + calldata ────────────────────────────

describe('encodeVaultFunctionCall — selector + calldata encoding', () => {
  it('encodes execute(address,bytes) with correct selector', () => {
    const calldata = encodeVaultFunctionCall('execute', [TARGET, DUMMY_DATA]);
    const expectedSelector = selectorOf('execute(address,bytes)');
    expect(calldata.startsWith(expectedSelector)).toBe(true);
  });

  it('encodes execute with correct parameter layout', () => {
    const calldata = encodeVaultFunctionCall('execute', [TARGET, DUMMY_DATA]);
    // execute(address,bytes): selector(4) + address(32) + offset_to_bytes(32) + len(32) + data(padded)
    const expectedSelector = selectorOf('execute(address,bytes)');
    const expectedOffset = padUint256(64n); // bytes data starts at offset 64 (after address + offset)
    const expectedLen = padUint256(BigInt((DUMMY_DATA.length - 2) / 2));
    const expectedData = (DUMMY_DATA.slice(2) + '0'.repeat(64)).slice(0, 64); // right-pad to 32 bytes
    const expected =
      expectedSelector +
      padAddress(TARGET) +
      expectedOffset +
      expectedLen +
      expectedData;
    expect(calldata.toLowerCase()).toBe(expected.toLowerCase());
  });

  it('encodes balancerFlashLoan(address[],uint256[],bytes) with correct selector', () => {
    const calldata = encodeVaultFunctionCall('balancerFlashLoan', [
      [TOKEN],
      [1000n],
      '0xabcd',
    ]);
    const expectedSelector = selectorOf('balancerFlashLoan(address[],uint256[],bytes)');
    expect(calldata.startsWith(expectedSelector)).toBe(true);
  });

  it('encodes aaveFlashLoan(address,uint256,bytes) with correct selector', () => {
    const calldata = encodeVaultFunctionCall('aaveFlashLoan', [TOKEN, 500n, '0x1234']);
    const expectedSelector = selectorOf('aaveFlashLoan(address,uint256,bytes)');
    expect(calldata.startsWith(expectedSelector)).toBe(true);
  });

  it('encodes operator() with correct selector', () => {
    const calldata = encodeVaultFunctionCall('operator', []);
    const expectedSelector = selectorOf('operator()');
    expect(calldata.toLowerCase()).toBe(expectedSelector.toLowerCase());
  });

  it('encodes paused() with correct selector', () => {
    const calldata = encodeVaultFunctionCall('paused', []);
    const expectedSelector = selectorOf('paused()');
    expect(calldata.toLowerCase()).toBe(expectedSelector.toLowerCase());
  });

  it('encodes whitelistedTargets(address) with correct selector', () => {
    const calldata = encodeVaultFunctionCall('whitelistedTargets', [TARGET]);
    const expectedSelector = selectorOf('whitelistedTargets(address)');
    expect(calldata.startsWith(expectedSelector)).toBe(true);
  });
});

// ─── 2. Dynamic arrays + bytes encoding ──────────────────────────────

describe('encodeAbi — dynamic arrays and bytes', () => {
  it('encodes address[] + bytes[] (flashloan userData pattern)', () => {
    const targets: `0x${string}`[] = [TARGET, TOKEN];
    const calldatas: `0x${string}`[] = ['0xaaaa', '0xbbbbbb'];
    const encoded = encodeAbi(
      [{ type: 'address[]' }, { type: 'bytes[]' }],
      [targets, calldatas]
    );
    // Should be a valid hex string starting with 0x
    expect(encoded.startsWith('0x')).toBe(true);
    // Cross-check with viem's direct encoding
    const expected = encodeAbiParameters(
      [{ type: 'address[]' }, { type: 'bytes[]' }],
      [targets, calldatas]
    );
    expect(encoded.toLowerCase()).toBe(expected.toLowerCase());
  });

  it('encodes empty arrays correctly', () => {
    const encoded = encodeAbi(
      [{ type: 'address[]' }, { type: 'bytes[]' }],
      [[], []]
    );
    expect(encoded.startsWith('0x')).toBe(true);
    // Should contain 2 offsets (one for each dynamic param) + 2 length=0 words
    // Total: 4 * 32 bytes = 128 bytes = 256 hex chars + 0x prefix
    expect(encoded.length).toBe(2 + 256);
  });

  it('encodes a single address[] correctly', () => {
    const encoded = encodeAbi(
      [{ type: 'address[]' }],
      [[TOKEN]]
    );
    const expected = encodeAbiParameters(
      [{ type: 'address[]' }],
      [[TOKEN]]
    );
    expect(encoded.toLowerCase()).toBe(expected.toLowerCase());
  });

  it('encodes a single bytes correctly', () => {
    const encoded = encodeAbi(
      [{ type: 'bytes' }],
      ['0xdeadbeef']
    );
    const expected = encodeAbiParameters(
      [{ type: 'bytes' }],
      ['0xdeadbeef']
    );
    expect(encoded.toLowerCase()).toBe(expected.toLowerCase());
  });

  it('encodes multiple dynamic bytes[] with correct offsets', () => {
    const calldatas: `0x${string}`[] = ['0x01', '0x0203', '0x040506'];
    const encoded = encodeAbi([{ type: 'bytes[]' }], [calldatas]);
    const expected = encodeAbiParameters([{ type: 'bytes[]' }], [calldatas]);
    expect(encoded.toLowerCase()).toBe(expected.toLowerCase());
    // Just verify it matches viem's encoding (exact length depends on ABI spec)
    expect(encoded.length).toBe(expected.length);
  });
});

// ─── 3. Encoding failures ────────────────────────────────────────────

describe('encodeVaultFunctionCall — encoding failures', () => {
  it('throws on unknown function name', () => {
    expect(() => encodeVaultFunctionCall('nonexistentFunction', [])).toThrow();
  });

  it('throws on wrong arg type (number instead of address)', () => {
    expect(() =>
      encodeVaultFunctionCall('execute', [12345 as unknown as `0x${string}`, DUMMY_DATA])
    ).toThrow();
  });

  it('throws on wrong number of args', () => {
    expect(() => encodeVaultFunctionCall('execute', [TARGET])).toThrow();
    expect(() => encodeVaultFunctionCall('execute', [TARGET, DUMMY_DATA, 'extra'])).toThrow();
  });

  it('throws on invalid address format', () => {
    expect(() =>
      encodeVaultFunctionCall('execute', ['0xinvalid' as `0x${string}`, DUMMY_DATA])
    ).toThrow();
  });
});

describe('encodeAbi — encoding failures', () => {
  it('throws on mismatched params/values length', () => {
    expect(() =>
      encodeAbi([{ type: 'address[]' }, { type: 'bytes[]' }], [[TARGET]])
    ).toThrow();
  });

  it('throws on invalid type string', () => {
    expect(() =>
      encodeAbi([{ type: 'invalidtype' }], ['hello'])
    ).toThrow();
  });

  it('throws on wrong value type for address[]', () => {
    expect(() =>
      encodeAbi([{ type: 'address[]' }], ['not-an-array'])
    ).toThrow();
  });
});

// ─── 4-9. ExecutionResult status semantics ───────────────────────────

/**
 * Helper: create an EvmExecutor with mocked walletClient and publicClient.
 * The mocked clients allow us to simulate sendTransaction + getTransactionReceipt
 * outcomes without broadcasting real transactions.
 */
function makeExecutorWithMocks(opts: {
  sendTransaction?: (args: unknown) => Promise<`0x${string}`>;
  getTransactionReceipt?: (args: { hash: `0x${string}` }) => Promise<unknown>;
  waitForReceipt?: boolean;
  receiptTimeoutMs?: number;
  receiptPollMs?: number;
}): { executor: EvmExecutor; walletClient: unknown; publicClient: unknown } {
  // We can't easily mock viem's internal transport, so we create a real
  // executor but override its clients' methods via prototype patching.
  const executor = new EvmExecutor({
    chainId: 'ethereum',
    agentPrivateKey: TEST_PRIVATE_KEY,
    agentVaultAddress: AGENT_VAULT,
    rpcUrl: 'http://localhost:0',  // never actually called — all methods are mocked
    waitForReceipt: opts.waitForReceipt ?? true,
    receiptTimeoutMs: opts.receiptTimeoutMs ?? 1000,
    receiptPollMs: opts.receiptPollMs ?? 10,
  });

  // Patch walletClient.sendTransaction
  const walletClient = executor.walletClient as unknown as {
    sendTransaction: (args: unknown) => Promise<`0x${string}`>;
  };
  if (opts.sendTransaction) {
    walletClient.sendTransaction = opts.sendTransaction;
  }

  // Patch publicClient.getTransactionReceipt
  const publicClient = executor.publicClient as unknown as {
    getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<unknown>;
  };
  if (opts.getTransactionReceipt) {
    publicClient.getTransactionReceipt = opts.getTransactionReceipt;
  }

  return { executor, walletClient, publicClient };
}

describe('EvmExecutor.execute — fail-closed status semantics', () => {
  it('returns status=confirmed on successful receipt (status=1)', async () => {
    const txHash = '0x' + 'ab'.repeat(32) as `0x${string}`;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => txHash,
      getTransactionReceipt: async () => ({
        status: 'success',
        gasUsed: 21000n,
        blockNumber: 100n,
        transactionHash: txHash,
      }),
    });

    const result = await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(result.txHash).toBe(txHash);
    expect(result.status).toBe('confirmed');
    expect(result.gasUsed).toBe(21000n);
    expect(result.blockNumber).toBe(100n);
  });

  it('returns status=reverted on reverted receipt (status=0)', async () => {
    const txHash = '0x' + 'cd'.repeat(32) as `0x${string}`;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => txHash,
      getTransactionReceipt: async () => ({
        status: 'reverted',
        gasUsed: 18000n,
        blockNumber: 101n,
        transactionHash: txHash,
      }),
    });

    const result = await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(result.txHash).toBe(txHash);
    expect(result.status).toBe('reverted');
    expect(result.gasUsed).toBe(18000n);
    expect(result.blockNumber).toBe(101n);
    expect(result.reason).toContain('reverted');
  });

  it('returns status=error when sendTransaction throws', async () => {
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => { throw new Error('insufficient funds for gas'); },
    });

    const result = await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(result.txHash).toBeNull();
    expect(result.status).toBe('error');
    expect(result.reason).toContain('insufficient funds');
  });

  it('returns status=submitted when receipt fetch times out', async () => {
    const txHash = '0x' + 'ef'.repeat(32) as `0x${string}`;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => txHash,
      getTransactionReceipt: async () => {
        throw new Error('transaction not found');
      },
      receiptTimeoutMs: 50,
      receiptPollMs: 10,
    });

    const result = await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(result.txHash).toBe(txHash);
    expect(result.status).toBe('submitted');
    expect(result.reason).toContain('timeout');
  });

  it('returns status=submitted immediately when waitForReceipt=false', async () => {
    const txHash = '0x' + '11'.repeat(32) as `0x${string}`;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => txHash,
      getTransactionReceipt: async () => {
        throw new Error('should not be called');
      },
      waitForReceipt: false,
    });

    const result = await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(result.txHash).toBe(txHash);
    expect(result.status).toBe('submitted');
    expect(result.gasUsed).toBeUndefined();
  });

  it('never reports success based on tx hash alone', async () => {
    // Even if sendTransaction returns a hash, without a successful receipt
    // the status must NOT be 'confirmed'.
    const txHash = '0x' + '22'.repeat(32) as `0x${string}`;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => txHash,
      getTransactionReceipt: async () => {
        throw new Error('not yet mined');
      },
      receiptTimeoutMs: 30,
      receiptPollMs: 5,
    });

    const result = await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(result.txHash).toBe(txHash);
    expect(result.status).not.toBe('confirmed');
    expect(result.status).toBe('submitted');
  });
});

// ─── Flashloan methods also use fail-closed semantics ─────────────────

describe('EvmExecutor.balancerFlashLoanArb — fail-closed', () => {
  it('throws on chain without Balancer V2 (hyperevm)', async () => {
    // hyperevm is in CHAIN_MAP (constructor succeeds) but has no Balancer V2
    const executor = new EvmExecutor({
      chainId: 'hyperevm',
      agentPrivateKey: TEST_PRIVATE_KEY,
      agentVaultAddress: AGENT_VAULT,
      rpcUrl: 'http://localhost:0',
      waitForReceipt: false,
    });
    expect(executor.balancerVaultAddress).toBeNull();
    await expect(
      executor.balancerFlashLoanArb({
        flashloanToken: TOKEN,
        flashloanAmount: 1000n,
        swapTargets: [TARGET],
        swapCalldatas: [DUMMY_DATA],
      })
    ).rejects.toThrow('Balancer V2 not available on hyperevm');
  });

  it('returns ExecutionResult (not just txHash) on success', async () => {
    const txHash = '0x' + '33'.repeat(32) as `0x${string}`;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => txHash,
      getTransactionReceipt: async () => ({
        status: 'success',
        gasUsed: 500000n,
        blockNumber: 200n,
      }),
    });

    const result = await executor.balancerFlashLoanArb({
      flashloanToken: TOKEN,
      flashloanAmount: 1000n,
      swapTargets: [TARGET],
      swapCalldatas: [DUMMY_DATA],
    });

    expect(result.status).toBe('confirmed');
    expect(result.txHash).toBe(txHash);
    expect(result.gasUsed).toBe(500000n);
  });
});

describe('EvmExecutor.aaveFlashLoanArb — fail-closed', () => {
  it('throws on chain without Aave V3 (hyperevm)', async () => {
    // hyperevm is in CHAIN_MAP (constructor succeeds) but has no Aave V3
    const executor = new EvmExecutor({
      chainId: 'hyperevm',
      agentPrivateKey: TEST_PRIVATE_KEY,
      agentVaultAddress: AGENT_VAULT,
      rpcUrl: 'http://localhost:0',
      waitForReceipt: false,
    });
    expect(executor.aaveV3PoolAddress).toBeNull();
    await expect(
      executor.aaveFlashLoanArb({
        flashloanToken: TOKEN,
        flashloanAmount: 1000n,
        swapTargets: [TARGET],
        swapCalldatas: [DUMMY_DATA],
      })
    ).rejects.toThrow('Aave V3 not available on hyperevm');
  });
});

// ─── 10. Flashbots Protect helper (mocked fetch) ──────────────────────

describe('submitViaFlashbotsProtect — mocked fetch', () => {
  it('returns txHash on successful submission', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ result: '0x' + 'aa'.repeat(32) }),
    }) as unknown as typeof fetch;
    const result = await submitViaFlashbotsProtect('0xsigned', mockFetch);
    expect(result.txHash).toBe('0x' + 'aa'.repeat(32));
    expect(mockFetch).toHaveBeenCalledWith(
      'https://rpc.flashbots.net/fast',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('throws on error response from Flashbots', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ error: { message: 'bundle not included' } }),
    }) as unknown as typeof fetch;
    await expect(submitViaFlashbotsProtect('0xsigned', mockFetch)).rejects.toThrow(
      'Flashbots Protect: bundle not included'
    );
  });
});

// ─── ABI correctness vs contract source ──────────────────────────────

describe('AGENT_VAULT_ABI — matches contract source', () => {
  it('contains execute(address,bytes)', () => {
    const fn = AGENT_VAULT_ABI.find(f => f.name === 'execute');
    expect(fn).toBeDefined();
    expect(fn?.inputs.map(i => i.type)).toEqual(['address', 'bytes']);
    expect(fn?.outputs.map(o => o.type)).toEqual(['bool', 'bytes']);
    expect(fn?.stateMutability).toBe('nonpayable');
  });

  it('contains balancerFlashLoan(address[],uint256[],bytes)', () => {
    const fn = AGENT_VAULT_ABI.find(f => f.name === 'balancerFlashLoan');
    expect(fn).toBeDefined();
    expect(fn?.inputs.map(i => i.type)).toEqual(['address[]', 'uint256[]', 'bytes']);
    expect(fn?.stateMutability).toBe('nonpayable');
  });

  it('contains aaveFlashLoan(address,uint256,bytes)', () => {
    const fn = AGENT_VAULT_ABI.find(f => f.name === 'aaveFlashLoan');
    expect(fn).toBeDefined();
    expect(fn?.inputs.map(i => i.type)).toEqual(['address', 'uint256', 'bytes']);
    expect(fn?.stateMutability).toBe('nonpayable');
  });

  it('contains operator() view', () => {
    const fn = AGENT_VAULT_ABI.find(f => f.name === 'operator');
    expect(fn).toBeDefined();
    expect(fn?.stateMutability).toBe('view');
  });

  it('contains owner() view', () => {
    const fn = AGENT_VAULT_ABI.find(f => f.name === 'owner');
    expect(fn).toBeDefined();
    expect(fn?.stateMutability).toBe('view');
  });

  it('contains whitelistedTargets(address) view', () => {
    const fn = AGENT_VAULT_ABI.find(f => f.name === 'whitelistedTargets');
    expect(fn).toBeDefined();
    expect(fn?.inputs.map(i => i.type)).toEqual(['address']);
    expect(fn?.outputs.map(o => o.type)).toEqual(['bool']);
    expect(fn?.stateMutability).toBe('view');
  });

  it('contains paused() view', () => {
    const fn = AGENT_VAULT_ABI.find(f => f.name === 'paused');
    expect(fn).toBeDefined();
    expect(fn?.outputs.map(o => o.type)).toEqual(['bool']);
    expect(fn?.stateMutability).toBe('view');
  });
});

// ─── Aave V3 Pool address registry — per-chain correctness ───────────

describe('AAVE_V3_POOL_ADDRESS — per-chain registry (bgd-labs/aave-address-book)', () => {
  // Source: https://github.com/bgd-labs/aave-address-book
  // These are the canonical Pool addresses from Aave's governance registry.

  it('ethereum has correct Pool address', () => {
    expect(AAVE_V3_POOL_ADDRESS.ethereum).toBe('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');
  });

  it('arbitrum has correct Pool address', () => {
    expect(AAVE_V3_POOL_ADDRESS.arbitrum).toBe('0x794a61358D6845594F94dc1DB02A252b5b4814aD');
  });

  it('base has its OWN Pool address (NOT Arbitrum\'s)', () => {
    // Base has a DIFFERENT Pool address from Arbitrum — this was a bug in
    // the previous version which used Arbitrum's address for Base.
    expect(AAVE_V3_POOL_ADDRESS.base).toBe('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5');
    expect(AAVE_V3_POOL_ADDRESS.base).not.toBe(AAVE_V3_POOL_ADDRESS.arbitrum);
  });

  it('optimism has correct Pool address', () => {
    expect(AAVE_V3_POOL_ADDRESS.optimism).toBe('0x794a61358D6845594F94dc1DB02A252b5b4814aD');
  });

  it('polygon has correct Pool address', () => {
    expect(AAVE_V3_POOL_ADDRESS.polygon).toBe('0x794a61358D6845594F94dc1DB02A252b5b4814aD');
  });

  it('bsc (BNB Chain) has correct Pool address (was incorrectly null)', () => {
    // Aave V3 IS deployed on BNB Chain. Previous version incorrectly marked it null.
    expect(AAVE_V3_POOL_ADDRESS.bsc).toBe('0x6807dc923806fE8Fd134338EABCA509979a7e0cB');
    expect(AAVE_V3_POOL_ADDRESS.bsc).not.toBeNull();
  });

  it('zksync has correct Pool address (was incorrectly null)', () => {
    // Aave V3 IS deployed on zkSync Era. Previous version incorrectly marked it null.
    expect(AAVE_V3_POOL_ADDRESS.zksync).toBe('0x78e30497a3c7527d953c6B1E3541b021A98Ac43c');
    expect(AAVE_V3_POOL_ADDRESS.zksync).not.toBeNull();
  });

  it('solana is null (not an EVM chain)', () => {
    expect(AAVE_V3_POOL_ADDRESS.solana).toBeNull();
  });

  it('hyperevm is null (Aave V3 not deployed on HyperEVM)', () => {
    expect(AAVE_V3_POOL_ADDRESS.hyperevm).toBeNull();
  });

  it('all addresses are valid 20-byte hex or null', () => {
    for (const [chain, addr] of Object.entries(AAVE_V3_POOL_ADDRESS)) {
      if (addr === null) continue;
      expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});

// ─── Balancer V2 address registry — per-chain correctness ────────────

describe('BALANCER_VAULT_ADDRESS — per-chain registry', () => {
  it('ethereum has correct Balancer Vault address', () => {
    expect(BALANCER_VAULT_ADDRESS.ethereum).toBe('0xBA12222222228d8Ba445958a75a0704d566BF2C8');
  });

  it('bsc is null (Balancer V2 not on BSC)', () => {
    expect(BALANCER_VAULT_ADDRESS.bsc).toBeNull();
  });

  it('hyperevm is null (Balancer V2 not on HyperEVM)', () => {
    expect(BALANCER_VAULT_ADDRESS.hyperevm).toBeNull();
  });
});

// ─── Receipt status distinction: submission vs timeout vs RPC failure ─

describe('ExecutionResult status distinction — submission vs timeout vs RPC failure', () => {
  it('status=submitted when waitForReceipt=false (explicit submission, no wait)', async () => {
    const txHash = '0x' + 'aa'.repeat(32) as `0x${string}`;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => txHash,
      waitForReceipt: false,
    });

    const result = await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(result.txHash).toBe(txHash);
    expect(result.status).toBe('submitted');
    // No 'reason' field when waitForReceipt=false (it's an explicit choice, not a timeout)
    expect(result.reason).toBeUndefined();
  });

  it('status=submitted with reason when receipt times out (timeout, not error)', async () => {
    const txHash = '0x' + 'bb'.repeat(32) as `0x${string}`;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => txHash,
      getTransactionReceipt: async () => {
        throw new Error('transaction not found');
      },
      receiptTimeoutMs: 30,
      receiptPollMs: 5,
    });

    const result = await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(result.txHash).toBe(txHash);
    expect(result.status).toBe('submitted');
    // 'reason' IS populated on timeout to explain why it's 'submitted' not 'confirmed'
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('timeout');
    // txHash is non-null because sendTransaction succeeded
    expect(result.txHash).not.toBeNull();
  });

  it('status=error when sendTransaction fails (RPC failure, not submission)', async () => {
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => {
        throw new Error('insufficient funds for gas * price + value');
      },
    });

    const result = await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(result.status).toBe('error');
    // txHash is null because sendTransaction never returned a hash
    expect(result.txHash).toBeNull();
    expect(result.reason).toContain('insufficient funds');
  });

  it('status=error is distinct from status=submitted — no tx hash on error', async () => {
    const { executor: errExecutor } = makeExecutorWithMocks({
      sendTransaction: async () => { throw new Error('nonce too low'); },
    });
    const txHash = '0x' + 'cc'.repeat(32) as `0x${string}`;
    const { executor: subExecutor } = makeExecutorWithMocks({
      sendTransaction: async () => txHash,
      waitForReceipt: false,
    });

    const errResult = await errExecutor.execute({ target: TARGET, data: DUMMY_DATA });
    const subResult = await subExecutor.execute({ target: TARGET, data: DUMMY_DATA });

    // Error: no tx hash, status='error'
    expect(errResult.txHash).toBeNull();
    expect(errResult.status).toBe('error');

    // Submitted: has tx hash, status='submitted'
    expect(subResult.txHash).toBe(txHash);
    expect(subResult.status).toBe('submitted');

    // The two are distinct
    expect(errResult.status).not.toBe(subResult.status);
  });

  it('status=confirmed is the ONLY status that means success', async () => {
    const txHash = '0x' + 'dd'.repeat(32) as `0x${string}`;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => txHash,
      getTransactionReceipt: async () => ({
        status: 'success',
        gasUsed: 21000n,
        blockNumber: 100n,
      }),
    });

    const result = await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(result.status).toBe('confirmed');
    // Only 'confirmed' has gasUsed + blockNumber without a 'reason'
    expect(result.gasUsed).toBe(21000n);
    expect(result.blockNumber).toBe(100n);
    expect(result.reason).toBeUndefined();
  });

  it('status=reverted has gasUsed + blockNumber + reason (not just a hash)', async () => {
    const txHash = '0x' + 'ee'.repeat(32) as `0x${string}`;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => txHash,
      getTransactionReceipt: async () => ({
        status: 'reverted',
        gasUsed: 18000n,
        blockNumber: 101n,
      }),
    });

    const result = await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(result.status).toBe('reverted');
    expect(result.gasUsed).toBe(18000n);
    expect(result.blockNumber).toBe(101n);
    expect(result.reason).toContain('reverted');
    // A reverted tx still has a hash — it was mined, just failed
    expect(result.txHash).toBe(txHash);
  });
});

// ─── useFlashbots option has been removed ─────────────────────────────

describe('EvmExecutor — no useFlashbots option', () => {
  it('constructor does not accept useFlashbots', () => {
    // The useFlashbots option was removed because it was misleading — it
    // stored the flag but never changed execution behavior. All execution
    // uses walletClient.sendTransaction() (public mempool).
    const executor = new EvmExecutor({
      chainId: 'ethereum',
      agentPrivateKey: TEST_PRIVATE_KEY,
      agentVaultAddress: AGENT_VAULT,
      rpcUrl: 'http://localhost:0',
    });
    // useFlashbots is not a property on the executor
    expect((executor as unknown as { useFlashbots?: boolean }).useFlashbots).toBeUndefined();
  });
});
