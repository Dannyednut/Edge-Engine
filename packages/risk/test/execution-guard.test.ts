import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EXECUTION_SCOPES,
  EXECUTION_AUTH_ENV_VAR,
  ExecutionNotAuthorizedError,
  assertExecutionAuthorized,
  parseExecutionAuthorization,
  setExecutionClockForTesting,
  resetExecutionClockForTesting,
  setExecutionAuditLoggerForTesting,
  resetExecutionAuditLoggerForTesting,
} from '../src/execution-guard.js';

// EM-STRAT-012 Phase-0 deterministic tests for the shared fail-closed
// execution guard. All time is injected; all authorization is in-memory
// (vi.stubEnv mutates process.env only inside the test process and is
// restored by unstubAllEnvs — nothing is written to .env or any file).

const FIXED_NOW = 1_700_000_000_000; // fixed epoch ms
const VALID_AUTH = {
  authId: 'principal-test-auth-001',
  expiresAtMs: FIXED_NOW + 60_000,
  scopes: ['vooi:place-arbitrage-order', 'vooi:create-bot'],
};

function authJson(overrides: Partial<typeof VALID_AUTH> = {}): string {
  return JSON.stringify({ ...VALID_AUTH, ...overrides });
}

describe('EXECUTION_SCOPES taxonomy', () => {
  it('covers all seven script entrypoints', () => {
    for (const s of [
      'entrypoint:khype-carry-executor',
      'entrypoint:euler-lending-executor',
      'entrypoint:funding-combined-runner',
      'entrypoint:vooi-arb-executor',
      'entrypoint:vooi-price-spread-executor',
      'entrypoint:vooi-create-bot',
      'entrypoint:go-live',
    ]) {
      expect(EXECUTION_SCOPES).toContain(s);
    }
  });

  it('covers the client sinks and executor layers', () => {
    for (const s of [
      'vooi:place-arbitrage-order',
      'vooi:create-bot',
      'vooi:start-bot',
      'vooi-executor:execute-arb',
      'vooi-price-spread-executor:execute-opp',
      'evm-executor:construct-signer',
      'evm-executor:send-transaction',
      'backpack-client:place-order',
      'pumpapi-client:atomic-two-leg-arb',
    ]) {
      expect(EXECUTION_SCOPES).toContain(s);
    }
  });
});

describe('parseExecutionAuthorization — fail-closed matrix', () => {
  beforeEach(() => setExecutionClockForTesting(() => FIXED_NOW));
  afterEach(() => resetExecutionClockForTesting());

  const denyCases: Array<{ name: string; raw: string | undefined; reasonPart: string }> = [
    { name: 'unset', raw: undefined, reasonPart: 'not set' },
    { name: 'empty string', raw: '', reasonPart: 'not set' },
    { name: 'not JSON', raw: 'not-json', reasonPart: 'not valid JSON' },
    { name: 'JSON array', raw: '[]', reasonPart: 'must be a JSON object' },
    { name: 'authId missing', raw: '{"expiresAtMs":9999999999999,"scopes":["vooi:create-bot"]}', reasonPart: 'authId' },
    { name: 'authId empty', raw: '{"authId":"","expiresAtMs":9999999999999,"scopes":["vooi:create-bot"]}', reasonPart: 'authId' },
    { name: 'authId not string', raw: '{"authId":42,"expiresAtMs":9999999999999,"scopes":["vooi:create-bot"]}', reasonPart: 'authId' },
    { name: 'expiresAtMs missing', raw: '{"authId":"a","scopes":["vooi:create-bot"]}', reasonPart: 'expiresAtMs' },
    { name: 'expiresAtMs not number', raw: '{"authId":"a","expiresAtMs":"soon","scopes":["vooi:create-bot"]}', reasonPart: 'expiresAtMs' },
    { name: 'expiresAtMs zero', raw: '{"authId":"a","expiresAtMs":0,"scopes":["vooi:create-bot"]}', reasonPart: 'expiresAtMs' },
    { name: 'expired', raw: '{"authId":"a","expiresAtMs":1700000000000,"scopes":["vooi:create-bot"]}', reasonPart: 'expired' },
    { name: 'scopes missing', raw: '{"authId":"a","expiresAtMs":9999999999999}', reasonPart: 'scopes' },
    { name: 'scopes empty', raw: '{"authId":"a","expiresAtMs":9999999999999,"scopes":[]}', reasonPart: 'scopes' },
    { name: 'scopes not array', raw: '{"authId":"a","expiresAtMs":9999999999999,"scopes":"vooi:create-bot"}', reasonPart: 'scopes' },
    { name: 'unknown scope', raw: '{"authId":"a","expiresAtMs":9999999999999,"scopes":["made-up-scope"]}', reasonPart: 'unknown scope' },
  ];

  for (const { name, raw, reasonPart } of denyCases) {
    it(`denies: ${name}`, () => {
      const r = parseExecutionAuthorization(raw, FIXED_NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(reasonPart);
    });
  }

  it('accepts a fully valid descriptor', () => {
    const r = parseExecutionAuthorization(authJson(), FIXED_NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.auth.authId).toBe('principal-test-auth-001');
      expect(r.auth.scopes).toContain('vooi:place-arbitrage-order');
    }
  });
});

describe('assertExecutionAuthorized — fail-closed gate matrix', () => {
  let logLines: string[];
  beforeEach(() => {
    setExecutionClockForTesting(() => FIXED_NOW);
    logLines = [];
    setExecutionAuditLoggerForTesting((msg) => logLines.push(msg));
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    resetExecutionClockForTesting();
    resetExecutionAuditLoggerForTesting();
    vi.unstubAllEnvs();
  });

  it('denies when EDGE_EXECUTION_AUTH is unset (default state)', () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    expect(() => assertExecutionAuthorized('vooi:place-arbitrage-order')).toThrow(ExecutionNotAuthorizedError);
  });

  it('denies a valid descriptor whose scopes do not include the requested scope', () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authJson({ scopes: ['vooi:create-bot'] }));
    expect(() => assertExecutionAuthorized('vooi:place-arbitrage-order')).toThrow(/scope not in authorized set/);
  });

  it('denies an expired authorization even if the scope matches', () => {
    setExecutionClockForTesting(() => VALID_AUTH.expiresAtMs + 1);
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authJson());
    expect(() => assertExecutionAuthorized('vooi:place-arbitrage-order')).toThrow(/expired/);
  });

  it('denies malformed JSON', () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, '{broken');
    expect(() => assertExecutionAuthorized('vooi:create-bot')).toThrow(ExecutionNotAuthorizedError);
  });

  it('allows an exactly-scoped, unexpired authorization', () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authJson());
    expect(() => assertExecutionAuthorized('vooi:place-arbitrage-order')).not.toThrow();
  });

  it('allows a second listed scope with the same descriptor', () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authJson());
    expect(() => assertExecutionAuthorized('vooi:create-bot')).not.toThrow();
  });

  it('scoped positive control: authorization for one scope does not enable another', () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authJson({ scopes: ['vooi:place-arbitrage-order'] }));
    expect(() => assertExecutionAuthorized('vooi:place-arbitrage-order')).not.toThrow();
    expect(() => assertExecutionAuthorized('evm-executor:send-transaction')).toThrow(ExecutionNotAuthorizedError);
    expect(() => assertExecutionAuthorized('entrypoint:go-live')).toThrow(ExecutionNotAuthorizedError);
  });

  it('throws a programming error for an unknown scope (never authorizable)', () => {
    // @ts-expect-error — deliberately passing an invalid scope
    expect(() => assertExecutionAuthorized('made-up-scope')).toThrow(/unknown scope/);
  });

  it('logs scope, decision, timestamp, and authId — never credentials', () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authJson());
    assertExecutionAuthorized('vooi:place-arbitrage-order');
    expect(logLines.length).toBe(1);
    const line = logLines[0];
    expect(line).toContain('decision=ALLOW');
    expect(line).toContain('scope="vooi:place-arbitrage-order"');
    expect(line).toContain('principal-test-auth-001');

    // Denial path also logs with the reason
    logLines.length = 0;
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    try {
      assertExecutionAuthorized('vooi:place-arbitrage-order');
    } catch { /* expected */ }
    expect(logLines[0]).toContain('decision=DENY');
    expect(logLines[0]).toContain('authId=none');
    expect(logLines[0]).not.toContain('PRIVATE');
    expect(logLines[0].toLowerCase()).not.toContain('privkey');
  });

  it('expiry is checked at call time, not import time (same descriptor flips to deny)', () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authJson());
    expect(() => assertExecutionAuthorized('vooi:place-arbitrage-order')).not.toThrow();
    // Advance the clock past expiry WITHOUT changing the env var.
    setExecutionClockForTesting(() => FIXED_NOW + 61_000);
    expect(() => assertExecutionAuthorized('vooi:place-arbitrage-order')).toThrow(/expired/);
  });
});
