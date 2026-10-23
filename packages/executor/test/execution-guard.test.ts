import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EvmExecutor } from '../src/index.js';
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
    expect(ex.walletClient).toBeDefined();
    expect(ex.agentVaultAddress).toBe(OPTS.agentVaultAddress);
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
});
