/**
 * executor.test.ts — Deterministic unit tests for @edge/executor
 * ─────────────────────────────────────────────────────────────────────
 * Tests cover:
 *   1. ABI encoding (selectors + calldata) via encodeVaultFunctionCall
 *   2. Dynamic arrays + bytes encoding via encodeAbi
 *   3. Encoding failures (invalid function name, wrong arg types)
 *   4. ExecutionResult status semantics (submitted/confirmed/reverted/ambiguous)
 *   5. Successful receipt handling
 *   6. Reverted receipt handling
 *   7. Ambiguous send-failure handling (NOT proof of non-submission)
 *   8. Receipt timeout (submitted without confirmation)
 *   9. waitForReceipt=false returns immediately
 *  10. Flashbots Protect helper (mocked fetch, fail-closed HTTP/JSON/hash validation)
 *  11. Runtime privacy of #submitAndWait (supervisor follow-up #1) — the
 *      submission helper is ECMAScript-private and unreachable at runtime;
 *      public submissions route through agentVaultAddress only.
 *  12. Census ratification perimeter (follow-up #4) — the single raw
 *      sendTransaction site is provably unreachable without the guard and
 *      without vault routing.
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
import {
  EXECUTION_AUTH_ENV_VAR,
  setExecutionClockForTesting,
  resetExecutionClockForTesting,
} from '@edge/risk';

// ─── Guard provisioning (reconciliation with main's execution guard) ──
//
// main hardened EvmExecutor with fail-closed scope gates: the constructor
// requires 'evm-executor:construct-signer' and every submission path
// requires 'evm-executor:send-transaction'. These tests therefore provision
// a deterministic, test-only authorization descriptor through the same
// env-var mechanism the production guard reads — the same pattern the
// CexExecutor containment tests use. No real .env file is read, and no
// network call is possible (all viem clients are mocked below).

const FIXED_NOW = 1_700_000_000_000;

/** Stub a valid test-only authorization descriptor into the guard env var. */
function grant(scopes: readonly string[], expiresAtMs: number = FIXED_NOW + 60_000): void {
  vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({ authId: 'em-strat-014-b2-reconcile-test', expiresAtMs, scopes: [...scopes] }));
}

beforeEach(() => {
  setExecutionClockForTesting(() => FIXED_NOW);
  grant(['evm-executor:construct-signer', 'evm-executor:send-transaction']);
});

afterEach(() => {
  resetExecutionClockForTesting();
  vi.unstubAllEnvs();
});

// ─── viem client mocks (reconciliation with main's hard-private signer) ─
//
// main moved walletClient/account into ECMAScript #private fields, so the
// previous approach (patching executor.walletClient) can no longer reach
// the signer — by design. Instead the viem client FACTORIES are partially
// mocked: createWalletClient/createPublicClient/http return configurable
// fakes while everything else in viem (ABI encoding, chains, accounts)
// stays real. The class still stores its clients in #private fields; the
// fakes merely make offline, deterministic behavior injectable without any
// backdoor into the instance.

const fakeViemClients = vi.hoisted(() => {
  // Each EvmExecutor construction creates FRESH fakes (one wallet + one
  // public client); the holder records the most recent pair so the factory
  // helper can configure the behavior of the executor it just built.
  // Independent executors therefore get independent mock behavior.
  const holder: {
    lastWallet: { state: { sendTransaction?: (args: unknown) => Promise<`0x${string}`> }; walletClient: Record<string, unknown> } | null;
    lastPublic: { state: { getTransactionReceipt?: (args: unknown) => Promise<unknown> }; publicClient: Record<string, unknown> } | null;
  } = { lastWallet: null, lastPublic: null };
  return { holder };
});

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createWalletClient: ((config: unknown) => {
      const state: { sendTransaction?: (args: unknown) => Promise<`0x${string}`> } = {};
      const walletClient = {
        ...(typeof config === 'object' && config !== null ? config : {}),
        sendTransaction: (args: unknown) => {
          if (!state.sendTransaction) throw new Error('mock sendTransaction not configured');
          return state.sendTransaction(args);
        },
      };
      fakeViemClients.holder.lastWallet = { state, walletClient };
      return walletClient;
    }) as unknown as typeof actual.createWalletClient,
    createPublicClient: ((_config: unknown) => {
      const state: { getTransactionReceipt?: (args: unknown) => Promise<unknown> } = {};
      const publicClient = {
        getTransactionReceipt: (args: unknown) => {
          if (!state.getTransactionReceipt) throw new Error('mock getTransactionReceipt not configured');
          return state.getTransactionReceipt(args);
        },
      };
      fakeViemClients.holder.lastPublic = { state, publicClient };
      return publicClient;
    }) as unknown as typeof actual.createPublicClient,
    http: (() => 'mock-transport') as unknown as typeof actual.http,
  };
});

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
 * Helper: create an EvmExecutor with mocked viem clients.
 * The mocked clients allow us to simulate sendTransaction + getTransactionReceipt
 * outcomes without broadcasting real transactions.
 *
 * Reconciliation note: main's EvmExecutor keeps its viem clients in
 * ECMAScript #private fields (hard-private signer material — no instance
 * property is reachable from outside), so the previous approach of patching
 * `executor.walletClient` cannot work. The viem factories are partially
 * mocked at module level instead; behavior is injected through the shared
 * state holder below. The guard is provisioned by the file-level beforeEach.
 */
function makeExecutorWithMocks(opts: {
  sendTransaction?: (args: unknown) => Promise<`0x${string}`>;
  getTransactionReceipt?: (args: { hash: `0x${string}` }) => Promise<unknown>;
  waitForReceipt?: boolean;
  receiptTimeoutMs?: number;
  receiptPollMs?: number;
}): { executor: EvmExecutor; walletClient: unknown; publicClient: unknown } {
  const executor = new EvmExecutor({
    chainId: 'ethereum',
    agentPrivateKey: TEST_PRIVATE_KEY,
    agentVaultAddress: AGENT_VAULT,
    rpcUrl: 'http://localhost:0',  // never actually called — all methods are mocked
    waitForReceipt: opts.waitForReceipt ?? true,
    receiptTimeoutMs: opts.receiptTimeoutMs ?? 1000,
    receiptPollMs: opts.receiptPollMs ?? 10,
  });

  // The constructor just created a FRESH fake pair for this executor
  // (recorded by the viem factory mocks). Configure its behavior here.
  const wallet = fakeViemClients.holder.lastWallet;
  const pub = fakeViemClients.holder.lastPublic;
  if (!wallet || !pub) throw new Error('viem client mocks were not invoked during construction');
  wallet.state.sendTransaction = opts.sendTransaction;
  pub.state.getTransactionReceipt = opts.getTransactionReceipt as
    | ((args: unknown) => Promise<unknown>)
    | undefined;

  return { executor, walletClient: wallet.walletClient, publicClient: pub.publicClient };
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

  it('returns status=ambiguous when sendTransaction throws (NOT proof of non-submission)', async () => {
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => { throw new Error('insufficient funds for gas'); },
    });

    const result = await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(result.txHash).toBeNull();
    expect(result.status).toBe('ambiguous');
    expect(result.reason).toContain('insufficient funds');
    // The reason must explicitly state the ambiguity — never claim the tx
    // was not submitted, never imply retry is safe.
    expect(result.reason).toContain('AMBIGUOUS');
    expect(result.reason).toContain('NOT proof');
    expect(result.reason).toContain('Do NOT automatically retry');
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

// ─── 10. Flashbots Protect helper (mocked fetch, fail-closed) ─────────

/** Build a mock JSON-RPC response for the Flashbots helper. */
function flashbotsResponse(body: unknown, opts: { ok?: boolean; status?: number; statusText?: string; jsonThrows?: boolean } = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? '',
    json: async () => {
      if (opts.jsonThrows) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
  } as unknown as Response;
}

describe('submitViaFlashbotsProtect — mocked fetch, fail-closed response handling', () => {
  it('returns txHash on successful submission (valid 32-byte hash result)', async () => {
    const hash = '0x' + 'aa'.repeat(32);
    const mockFetch = vi.fn().mockResolvedValue(
      flashbotsResponse({ jsonrpc: '2.0', id: 1, result: hash })
    ) as unknown as typeof fetch;
    const result = await submitViaFlashbotsProtect('0xsigned', mockFetch);
    expect(result.txHash).toBe(hash);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://rpc.flashbots.net/fast',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('throws on JSON-RPC error response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      flashbotsResponse({ error: { message: 'bundle not included' } })
    ) as unknown as typeof fetch;
    await expect(submitViaFlashbotsProtect('0xsigned', mockFetch)).rejects.toThrow(
      'Flashbots Protect: bundle not included'
    );
  });

  it('throws on HTTP failure (non-2xx) and does NOT parse a hash out of it', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      flashbotsResponse({ error: { message: 'should not be read' } }, { ok: false, status: 503, statusText: 'Service Unavailable' })
    ) as unknown as typeof fetch;
    await expect(submitViaFlashbotsProtect('0xsigned', mockFetch)).rejects.toThrow(/HTTP 503/);
  });

  it('throws on malformed JSON body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      flashbotsResponse(undefined, { jsonThrows: true })
    ) as unknown as typeof fetch;
    await expect(submitViaFlashbotsProtect('0xsigned', mockFetch)).rejects.toThrow(/invalid JSON/);
  });

  it('throws when the response is not a JSON-RPC object', async () => {
    for (const body of [null, 'plain string', 42, []]) {
      const mockFetch = vi.fn().mockResolvedValue(flashbotsResponse(body)) as unknown as typeof fetch;
      await expect(submitViaFlashbotsProtect('0xsigned', mockFetch)).rejects.toThrow(/not a JSON-RPC object/);
    }
  });

  it('throws when JSON-RPC result is missing, empty, or not a tx hash', async () => {
    const badResults: unknown[] = [undefined, null, '', '0x', '0x1234', 'not-a-hash', '0x' + 'zz'.repeat(32), '0x' + 'aa'.repeat(31), 42];
    for (const result of badResults) {
      const mockFetch = vi.fn().mockResolvedValue(
        flashbotsResponse({ jsonrpc: '2.0', id: 1, result })
      ) as unknown as typeof fetch;
      await expect(
        submitViaFlashbotsProtect('0xsigned', mockFetch),
      ).rejects.toThrow(/not a non-empty transaction hash/);
    }
  });

  it('rejects an error object with non-string message without crashing', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      flashbotsResponse({ error: { code: -32000 } })
    ) as unknown as typeof fetch;
    await expect(submitViaFlashbotsProtect('0xsigned', mockFetch)).rejects.toThrow(/Flashbots Protect: /);
  });

  it('guard-before-network ordering: without the send-transaction scope, fetch is NEVER called', async () => {
    // Revoke the scope: stub the env var with a descriptor lacking 'evm-executor:send-transaction'
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'no-scope-test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['evm-executor:construct-signer'],
    }));
    const mockFetch = vi.fn() as unknown as typeof fetch;
    await expect(submitViaFlashbotsProtect('0xsigned', mockFetch)).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled(); // guard fired BEFORE any network attempt
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

  it('status=ambiguous when sendTransaction fails (RPC failure — outcome unknown, not "nothing sent")', async () => {
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => {
        throw new Error('insufficient funds for gas * price + value');
      },
    });

    const result = await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(result.status).toBe('ambiguous');
    // txHash is null because sendTransaction never returned a hash
    expect(result.txHash).toBeNull();
    expect(result.reason).toContain('insufficient funds');
  });

  it('status=ambiguous is distinct from status=submitted and never implies retry safety', async () => {
    const { executor: ambExecutor } = makeExecutorWithMocks({
      sendTransaction: async () => { throw new Error('nonce too low'); },
    });
    const txHash = '0x' + 'cc'.repeat(32) as `0x${string}`;
    const { executor: subExecutor } = makeExecutorWithMocks({
      sendTransaction: async () => txHash,
      waitForReceipt: false,
    });

    const ambResult = await ambExecutor.execute({ target: TARGET, data: DUMMY_DATA });
    const subResult = await subExecutor.execute({ target: TARGET, data: DUMMY_DATA });

    // Ambiguous: no tx hash, status='ambiguous'
    expect(ambResult.txHash).toBeNull();
    expect(ambResult.status).toBe('ambiguous');

    // Submitted: has tx hash, status='submitted'
    expect(subResult.txHash).toBe(txHash);
    expect(subResult.status).toBe('submitted');

    // The two are distinct
    expect(ambResult.status).not.toBe(subResult.status);
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

// ─── 11. Runtime privacy of #submitAndWait (supervisor follow-up #1) ──
//
// The submission helper was TypeScript `private`, which compiles to a
// runtime-accessible prototype method accepting arbitrary `to`/`data` —
// a caller with an authorized executor instance could broadcast ANY
// transaction through the signer without routing through the AgentVault.
// It is now an ECMAScript `#`-private method: not on the prototype, not an
// own property, lexically unreachable from outside the class body.

describe('EvmExecutor — #submitAndWait is genuinely runtime-private (follow-up #1)', () => {
  it('submitAndWait does not exist on the prototype (TS-private would)', () => {
    const protoMethods = Object.getOwnPropertyNames(EvmExecutor.prototype);
    expect(protoMethods).not.toContain('submitAndWait');
  });

  it('instance does not expose submitAndWait, walletClient, or account at runtime', () => {
    const { executor } = makeExecutorWithMocks({ waitForReceipt: false });
    const ownProps = Object.getOwnPropertyNames(executor);
    expect(ownProps).not.toContain('submitAndWait');
    // Hard-private signer material (from main's Phase-0.5) still holds:
    expect(ownProps).not.toContain('walletClient');
    expect(ownProps).not.toContain('account');
    expect((executor as unknown as Record<string, unknown>).submitAndWait).toBeUndefined();
    expect((executor as unknown as Record<string, unknown>).walletClient).toBeUndefined();
    expect((executor as unknown as Record<string, unknown>).account).toBeUndefined();
  });

  it('calling the (absent) submitAndWait with arbitrary to/data throws TypeError — no arbitrary-target broadcast', async () => {
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => {
        throw new Error('MUST NOT BE REACHED — arbitrary-target submission must fail before any send');
      },
      waitForReceipt: false,
    });

    const directCall = () =>
      (executor as unknown as { submitAndWait: (p: unknown) => Promise<unknown> })
        .submitAndWait({ to: TARGET, data: DUMMY_DATA });

    // The method is undefined at runtime — a direct invocation throws
    // TypeError ("not a function"), and the sendTransaction mock is never
    // reached. (A TS-private method would be a real function here.)
    expect(() => directCall()).toThrow(TypeError);
  });
});

describe('EvmExecutor — public submissions route through agentVaultAddress only (follow-up #1)', () => {
  it('execute() sends to the vault with vault-encoded calldata (user target is an ARGUMENT, not the destination)', async () => {
    const sent: Array<{ to: string; data: string }> = [];
    const txHash = '0x' + 'aa'.repeat(32) as `0x${string}`;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async (args) => {
        sent.push(args as { to: string; data: string });
        return txHash;
      },
      waitForReceipt: false,
    });

    await executor.execute({ target: TARGET, data: DUMMY_DATA });

    expect(sent.length).toBe(1);
    expect(sent[0].to.toLowerCase()).toBe(AGENT_VAULT.toLowerCase());
    expect(sent[0].data.toLowerCase().startsWith(selectorOf('execute(address,bytes)').toLowerCase())).toBe(true);
    // The caller-supplied target appears only INSIDE the vault calldata:
    expect(sent[0].data.toLowerCase()).toContain(padAddress(TARGET));
    // …and is never the `to` itself:
    expect(sent[0].to.toLowerCase()).not.toBe(TARGET.toLowerCase());
  });

  it('balancerFlashLoanArb() sends to the vault with balancerFlashLoan calldata', async () => {
    const sent: Array<{ to: string; data: string }> = [];
    const txHash = '0x' + 'bb'.repeat(32) as `0x${string}`;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async (args) => {
        sent.push(args as { to: string; data: string });
        return txHash;
      },
      waitForReceipt: false,
    });

    await executor.balancerFlashLoanArb({
      flashloanToken: TOKEN,
      flashloanAmount: 1000n,
      swapTargets: [TARGET],
      swapCalldatas: [DUMMY_DATA],
    });

    expect(sent.length).toBe(1);
    expect(sent[0].to.toLowerCase()).toBe(AGENT_VAULT.toLowerCase());
    expect(sent[0].data.toLowerCase().startsWith(selectorOf('balancerFlashLoan(address[],uint256[],bytes)').toLowerCase())).toBe(true);
  });

  it('aaveFlashLoanArb() sends to the vault with aaveFlashLoan calldata', async () => {
    const sent: Array<{ to: string; data: string }> = [];
    const txHash = '0x' + 'cc'.repeat(32) as `0x${string}`;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async (args) => {
        sent.push(args as { to: string; data: string });
        return txHash;
      },
      waitForReceipt: false,
    });

    await executor.aaveFlashLoanArb({
      flashloanToken: TOKEN,
      flashloanAmount: 500n,
      swapTargets: [TARGET],
      swapCalldatas: [DUMMY_DATA],
    });

    expect(sent.length).toBe(1);
    expect(sent[0].to.toLowerCase()).toBe(AGENT_VAULT.toLowerCase());
    expect(sent[0].data.toLowerCase().startsWith(selectorOf('aaveFlashLoan(address,uint256,bytes)').toLowerCase())).toBe(true);
  });
});

// ─── 12. Census ratification perimeter (supervisor follow-up #4) ──────
//
// The census moved EvmExecutor from 3 raw sendTransaction sites to 1
// (consolidated inside the now-runtime-private #submitAndWait). Per the
// disposition, that single raw census entry is retained ONLY because the
// guard/perimeter tests prove there is no runtime-reachable bypass:
//   (a) the sink re-asserts the scope per call (defense-in-depth),
//   (b) an expired/absent scope blocks submission BEFORE the transport,
//   (c) every send is vault-routed (proved in the describe above),
//   (d) the helper is runtime-private (proved in the describe above).

describe('EvmExecutor — raw-sink perimeter: guard fires before the transport (follow-up #4)', () => {
  it('expired authorization: execute() is rejected and sendTransaction is NEVER invoked', async () => {
    // Construct under the valid file-level grant (construction itself requires
    // 'evm-executor:construct-signer'), THEN expire the authorization so the
    // per-submission re-check must fire before the transport.
    let sendCalls = 0;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => { sendCalls++; return '0x' + 'dd'.repeat(32) as `0x${string}`; },
      waitForReceipt: false,
    });
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'expired-scope-test', expiresAtMs: FIXED_NOW - 1_000, scopes: ['evm-executor:construct-signer', 'evm-executor:send-transaction'],
    }));

    await expect(executor.execute({ target: TARGET, data: DUMMY_DATA })).rejects.toThrow();
    expect(sendCalls).toBe(0); // guard blocked the raw sink before any send
  });

  it('missing send-transaction scope (construct-only): execute() is rejected before any send', async () => {
    let sendCalls = 0;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => { sendCalls++; return '0x' + 'ee'.repeat(32) as `0x${string}`; },
      waitForReceipt: false,
    });
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'construct-only-test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['evm-executor:construct-signer'],
    }));

    await expect(executor.execute({ target: TARGET, data: DUMMY_DATA })).rejects.toThrow();
    expect(sendCalls).toBe(0);
  });

  it('balancer/aave submission paths are equally guard-gated before any send', async () => {
    let sendCalls = 0;
    const { executor } = makeExecutorWithMocks({
      sendTransaction: async () => { sendCalls++; return '0x' + 'ff'.repeat(32) as `0x${string}`; },
      waitForReceipt: false,
    });
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'no-send-scope-test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['evm-executor:construct-signer'],
    }));

    await expect(executor.balancerFlashLoanArb({
      flashloanToken: TOKEN, flashloanAmount: 1n, swapTargets: [TARGET], swapCalldatas: [DUMMY_DATA],
    })).rejects.toThrow();
    await expect(executor.aaveFlashLoanArb({
      flashloanToken: TOKEN, flashloanAmount: 1n, swapTargets: [TARGET], swapCalldatas: [DUMMY_DATA],
    })).rejects.toThrow();
    expect(sendCalls).toBe(0);
  });
});
