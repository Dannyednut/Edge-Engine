import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EvmExecutor, submitViaFlashbotsProtect } from '../src/index.js';
import {
  EXECUTION_AUTH_ENV_VAR,
  ExecutionNotAuthorizedError,
  setExecutionClockForTesting,
  resetExecutionClockForTesting,
} from '@edge/risk';

// EM-STRAT-012 Phase-0 sink-class tests for EvmExecutor. NO network, NO real
// key material (the constructor must fail-closed before the key is even
// parsed when unauthorized). The rpcUrl points at an unroutable local address
// that is never contacted — construction and guard assertions happen before
// any transport use, and the submission tests assert the guard throws BEFORE
// sendTransaction is reached (no HTTP/RPC mock needed for the denial case).

const FIXED_NOW = 1_700_000_000_000;
// Well-formed test key (Hardhat account #0 public test key) — NOT a secret;
// never funded; used only to verify that guard denial precedes key parsing.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

const OPTS = {
  // Note: 'ethereum' is in CHAIN_MAP. (Existing repo inconsistency: the
  // ChainId union includes 'hyperevm' but CHAIN_MAP keys it as 'hyperEvm' —
  // out of scope for Phase-0; the guard fires before the chain lookup anyway.)
  chainId: 'ethereum' as const,
  agentPrivateKey: TEST_KEY,
  agentVaultAddress: '0x0000000000000000000000000000000000000001' as const,
  rpcUrl: 'http://127.0.0.1:1', // unroutable — never contacted in these tests
};

describe('EvmExecutor — execution guard (EM-STRAT-012)', () => {
  beforeEach(() => {
    setExecutionClockForTesting(() => FIXED_NOW);
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    resetExecutionClockForTesting();
    vi.unstubAllEnvs();
  });

  it('construction is BLOCKED without authorization — before any signer/key handling', () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    expect(() => new EvmExecutor(OPTS)).toThrow(ExecutionNotAuthorizedError);
    // The error must be the guard error, not a viem key-parsing error —
    // proving the guard fired BEFORE the private key was touched.
    try {
      new EvmExecutor(OPTS);
    } catch (e: any) {
      expect(e.name).toBe('ExecutionNotAuthorizedError');
    }
  });

  it('construction proceeds with the evm-executor:construct-signer scope', () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['evm-executor:construct-signer'],
    }));
    const ex = new EvmExecutor(OPTS);
    expect(ex.agentVaultAddress).toBe(OPTS.agentVaultAddress);
  });

  it('Phase-0.5 hard privacy: the raw wallet client and key-derived account are UNREACHABLE from any caller', () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['evm-executor:construct-signer'],
    }));
    const ex = new EvmExecutor(OPTS);
    const untyped = ex as any;
    // The former PUBLIC `readonly walletClient` / `readonly account` allowed
    // direct walletClient.sendTransaction(...) after satisfying the
    // constructor guard once — bypassing the per-submission guard. With #
    // hard-private fields they are not own properties at all.
    expect(untyped.walletClient).toBeUndefined();
    expect(untyped.account).toBeUndefined();
    const ownProps = Object.getOwnPropertyNames(untyped);
    expect(ownProps).not.toContain('walletClient');
    expect(ownProps).not.toContain('account');
    // JSON serialization cannot leak the signer either.
    expect(JSON.stringify(ex)).not.toContain('privateKey');
  });

  it('an existing instance CANNOT submit after authorization expires (per-call re-check)', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['evm-executor:construct-signer', 'evm-executor:send-transaction'],
    }));
    const ex = new EvmExecutor(OPTS);
    // Authorization lapses (clock advances past expiry, env unchanged).
    setExecutionClockForTesting(() => FIXED_NOW + 61_000);
    await expect(ex.execute({ target: OPTS.agentVaultAddress, data: '0x' as const })).rejects.toThrow(ExecutionNotAuthorizedError);
    await expect(ex.balancerFlashLoanArb({
      flashloanToken: '0x0000000000000000000000000000000000000002' as const,
      flashloanAmount: 1n,
      swapTargets: [],
      swapCalldatas: [],
    } as any)).rejects.toThrow(ExecutionNotAuthorizedError);
    await expect(ex.aaveFlashLoanArb({
      flashloanToken: '0x0000000000000000000000000000000000000002' as const,
      flashloanAmount: 1n,
      swapTargets: [],
      swapCalldatas: [],
    } as any)).rejects.toThrow(ExecutionNotAuthorizedError);
  });

  it('all three submission methods are blocked without the send-transaction scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['evm-executor:construct-signer'],
    }));
    const ex = new EvmExecutor(OPTS);
    // Constructed fine, but submissions are denied (constructor-only auth is
    // insufficient by design).
    await expect(ex.execute({ target: OPTS.agentVaultAddress, data: '0x' as const })).rejects.toThrow(ExecutionNotAuthorizedError);
    await expect(ex.balancerFlashLoanArb({
      flashloanToken: '0x0000000000000000000000000000000000000002' as const,
      flashloanAmount: 1n,
      swapTargets: [],
      swapCalldatas: [],
    } as any)).rejects.toThrow(ExecutionNotAuthorizedError);
    await expect(ex.aaveFlashLoanArb({
      flashloanToken: '0x0000000000000000000000000000000000000002' as const,
      flashloanAmount: 1n,
      swapTargets: [],
      swapCalldatas: [],
    } as any)).rejects.toThrow(ExecutionNotAuthorizedError);
  });

  it('Phase-0.5: submitViaFlashbotsProtect is a guarded broadcast sink — denied without the send-transaction scope, zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const calls: unknown[] = [];
    const recordingFetch = (async (_url: any, _init?: any) => {
      calls.push({ url: _url, init: _init });
      return { ok: true, json: async () => ({ result: '0xdeadbeef' }) } as any;
    }) as any;
    await expect(submitViaFlashbotsProtect('0xdeadbeef' as const, recordingFetch))
      .rejects.toThrow(ExecutionNotAuthorizedError);
    expect(calls.length).toBe(0);
  });

  it('Phase-0.5: submitViaFlashbotsProtect proceeds with the evm-executor:send-transaction scope (mocked transport)', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['evm-executor:send-transaction'],
    }));
    const calls: unknown[] = [];
    const recordingFetch = (async (_url: any, _init?: any) => {
      calls.push({ url: _url, init: _init });
      return { ok: true, json: async () => ({ result: '0xdeadbeef' }) } as any;
    }) as any;
    const r = await submitViaFlashbotsProtect('0xdeadbeef' as const, recordingFetch);
    expect(r.txHash).toBe('0xdeadbeef');
    expect(calls.length).toBe(1);
    expect(JSON.stringify(calls[0])).toContain('eth_sendRawTransaction');
  });
});
