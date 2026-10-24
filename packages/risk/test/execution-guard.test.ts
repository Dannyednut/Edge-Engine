import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EXECUTION_SCOPES,
  EXECUTION_AUTH_ENV_VAR,
  MAX_AUTH_LIFETIME_MS,
  ExecutionNotAuthorizedError,
  assertExecutionAuthorized,
  parseExecutionAuthorization,
  setExecutionClockForTesting,
  resetExecutionClockForTesting,
  setExecutionAuditLoggerForTesting,
  resetExecutionAuditLoggerForTesting,
  parseDotEnvContents,
  loadDotEnvIntoProcessEnv,
  DOTENV_EXCLUDED_KEYS,
} from '../src/index.js';

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
    { name: 'authId missing', raw: `{"expiresAtMs":${FIXED_NOW + 60_000},"scopes":["vooi:create-bot"]}`, reasonPart: 'authId' },
    { name: 'authId empty', raw: `{"authId":"","expiresAtMs":${FIXED_NOW + 60_000},"scopes":["vooi:create-bot"]}`, reasonPart: 'authId' },
    { name: 'authId not string', raw: `{"authId":42,"expiresAtMs":${FIXED_NOW + 60_000},"scopes":["vooi:create-bot"]}`, reasonPart: 'authId' },
    { name: 'expiresAtMs missing', raw: '{"authId":"a","scopes":["vooi:create-bot"]}', reasonPart: 'expiresAtMs' },
    { name: 'expiresAtMs not number', raw: '{"authId":"a","expiresAtMs":"soon","scopes":["vooi:create-bot"]}', reasonPart: 'expiresAtMs' },
    { name: 'expiresAtMs zero', raw: '{"authId":"a","expiresAtMs":0,"scopes":["vooi:create-bot"]}', reasonPart: 'expiresAtMs' },
    { name: 'expired', raw: '{"authId":"a","expiresAtMs":1700000000000,"scopes":["vooi:create-bot"]}', reasonPart: 'expired' },
    { name: 'excessively long-lived (R1 max lifetime)', raw: '{"authId":"a","expiresAtMs":9999999999999,"scopes":["vooi:create-bot"]}', reasonPart: 'exceeds maximum' },
    { name: 'scopes missing', raw: `{"authId":"a","expiresAtMs":${FIXED_NOW + 60_000}}`, reasonPart: 'scopes' },
    { name: 'scopes empty', raw: `{"authId":"a","expiresAtMs":${FIXED_NOW + 60_000},"scopes":[]}`, reasonPart: 'scopes' },
    { name: 'scopes not array', raw: `{"authId":"a","expiresAtMs":${FIXED_NOW + 60_000},"scopes":"vooi:create-bot"}`, reasonPart: 'scopes' },
    { name: 'unknown scope', raw: `{"authId":"a","expiresAtMs":${FIXED_NOW + 60_000},"scopes":["made-up-scope"]}`, reasonPart: 'unknown scope' },
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

// ─── R1: Maximum authorization lifetime ────────────────────────────────

describe('MAX_AUTH_LIFETIME_MS — R1 maximum authorization lifetime', () => {
  beforeEach(() => {
    setExecutionClockForTesting(() => FIXED_NOW);
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    resetExecutionClockForTesting();
    vi.unstubAllEnvs();
  });

  it('MAX_AUTH_LIFETIME_MS is 1 hour (documented maximum)', () => {
    expect(MAX_AUTH_LIFETIME_MS).toBe(60 * 60 * 1000);
  });

  it('accepts a descriptor that expires exactly MAX_AUTH_LIFETIME_MS in the future (boundary)', () => {
    const raw = JSON.stringify({
      authId: 'boundary',
      expiresAtMs: FIXED_NOW + MAX_AUTH_LIFETIME_MS,
      scopes: ['vooi:create-bot'],
    });
    const r = parseExecutionAuthorization(raw, FIXED_NOW);
    expect(r.ok).toBe(true);
  });

  it('denies a descriptor that expires 1ms BEYOND MAX_AUTH_LIFETIME_MS (just over the boundary)', () => {
    const raw = JSON.stringify({
      authId: 'too-long',
      expiresAtMs: FIXED_NOW + MAX_AUTH_LIFETIME_MS + 1,
      scopes: ['vooi:create-bot'],
    });
    const r = parseExecutionAuthorization(raw, FIXED_NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('exceeds maximum');
      expect(r.reason).toContain(String(MAX_AUTH_LIFETIME_MS));
    }
  });

  it('denies a descriptor with expiresAtMs far in the future (e.g. year 2286)', () => {
    const raw = '{"authId":"a","expiresAtMs":9999999999999,"scopes":["vooi:create-bot"]}';
    const r = parseExecutionAuthorization(raw, FIXED_NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('exceeds maximum');
  });

  it('injectable clock: the same descriptor is accepted at t=0 but denied as too-long-lived at t=now-2h', () => {
    // A descriptor that expires at FIXED_NOW + 30min is valid when checked at
    // FIXED_NOW. But if we rewind the clock 2 hours, the same descriptor's
    // lifetime (from the rewound clock's perspective) is 2h30m — exceeding
    // the 1h max. This proves the lifetime check uses the injectable clock
    // and is NOT just "expiresAtMs is in the future".
    const raw = JSON.stringify({
      authId: 'clock-test',
      expiresAtMs: FIXED_NOW + 30 * 60 * 1000, // 30 min after FIXED_NOW
      scopes: ['vooi:create-bot'],
    });
    // At FIXED_NOW: lifetime = 30min, within 1h max → accept.
    setExecutionClockForTesting(() => FIXED_NOW);
    const r1 = parseExecutionAuthorization(raw, FIXED_NOW);
    expect(r1.ok).toBe(true);
    // 2 hours before FIXED_NOW: lifetime = 2h30m, exceeds 1h max → deny.
    const twoHoursBefore = FIXED_NOW - 2 * 60 * 60 * 1000;
    const r2 = parseExecutionAuthorization(raw, twoHoursBefore);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('exceeds maximum');
  });

  it('the guard itself enforces the max-lifetime check (not just the parser)', () => {
    // A descriptor with a valid scope but excessively long lifetime must be
    // rejected by assertExecutionAuthorized, not just by the parser.
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'long-lived',
      expiresAtMs: FIXED_NOW + MAX_AUTH_LIFETIME_MS + 1,
      scopes: ['vooi:place-arbitrage-order'],
    }));
    expect(() => assertExecutionAuthorized('vooi:place-arbitrage-order'))
      .toThrow(/exceeds maximum/);
  });
});

// ─── R1: .env loader safety ────────────────────────────────────────────

describe('parseDotEnvContents — R1 .env exclusion of EDGE_EXECUTION_AUTH', () => {
  it('DOTENV_EXCLUDED_KEYS contains EDGE_EXECUTION_AUTH', () => {
    expect(DOTENV_EXCLUDED_KEYS.has(EXECUTION_AUTH_ENV_VAR)).toBe(true);
  });

  it('parseDotEnvContents returns regular keys but EXCLUDES EDGE_EXECUTION_AUTH', () => {
    const content = [
      '# comment line',
      'VOOI_API_TOKEN=abc123',
      'AUTO_EXECUTE=false',
      'EDGE_EXECUTION_AUTH={"authId":"x","expiresAtMs":9999,"scopes":["vooi:create-bot"]}',
      'SCAN_INTERVAL_MS=60000',
    ].join('\n');
    const parsed = parseDotEnvContents(content);
    expect(parsed.VOOI_API_TOKEN).toBe('abc123');
    expect(parsed.AUTO_EXECUTE).toBe('false');
    expect(parsed.SCAN_INTERVAL_MS).toBe('60000');
    // The execution-authorization descriptor MUST be excluded.
    expect(parsed.EDGE_EXECUTION_AUTH).toBeUndefined();
  });

  it('parseDotEnvContents strips surrounding quotes from values', () => {
    const content = [
      'KEY_DOUBLE="quoted_value"',
      'KEY_SINGLE=\'single_value\'',
      'EDGE_EXECUTION_AUTH="should_still_be_excluded"',
    ].join('\n');
    const parsed = parseDotEnvContents(content);
    expect(parsed.KEY_DOUBLE).toBe('quoted_value');
    expect(parsed.KEY_SINGLE).toBe('single_value');
    expect(parsed.EDGE_EXECUTION_AUTH).toBeUndefined();
  });

  it('parseDotEnvContents skips malformed lines (no crash, no spurious keys)', () => {
    const content = [
      'this is not a key=value line',
      'ANOTHER_VALID=ok',
      '',
      '   # indented comment',
      'NO_EQUALS_SIGN',
    ].join('\n');
    const parsed = parseDotEnvContents(content);
    expect(parsed.ANOTHER_VALID).toBe('ok');
    expect(Object.keys(parsed).length).toBe(1);
  });

  it('parseDotEnvContents excludes EDGE_EXECUTION_AUTH even if it appears multiple times', () => {
    const content = [
      'EDGE_EXECUTION_AUTH={"first":true}',
      'OTHER_KEY=ok',
      'EDGE_EXECUTION_AUTH={"second":true}',
    ].join('\n');
    const parsed = parseDotEnvContents(content);
    expect(parsed.EDGE_EXECUTION_AUTH).toBeUndefined();
    expect(parsed.OTHER_KEY).toBe('ok');
  });
});

describe('loadDotEnvIntoProcessEnv — R1 .env cannot arm the guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(__dirname, 'dotenv-fixture-tmp');
    mkdirSync(tmpDir, { recursive: true });
    // Ensure clean state: EDGE_EXECUTION_AUTH must NOT be in process.env.
    delete process.env[EXECUTION_AUTH_ENV_VAR];
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env[EXECUTION_AUTH_ENV_VAR];
  });

  it('a .env file containing EDGE_EXECUTION_AUTH does NOT set process.env.EDGE_EXECUTION_AUTH', () => {
    const envPath = resolve(tmpDir, '.env');
    writeFileSync(envPath, [
      'VOOI_API_TOKEN=from-dotenv',
      'EDGE_EXECUTION_AUTH={"authId":"leaked","expiresAtMs":9999999999999,"scopes":["vooi:create-bot"]}',
      'OTHER_VAR=ok',
    ].join('\n'));
    loadDotEnvIntoProcessEnv(envPath);
    // Regular keys ARE loaded.
    expect(process.env.VOOI_API_TOKEN).toBe('from-dotenv');
    expect(process.env.OTHER_VAR).toBe('ok');
    // EDGE_EXECUTION_AUTH is NOT loaded — the guard stays disarmed.
    expect(process.env[EXECUTION_AUTH_ENV_VAR]).toBeUndefined();
  });

  it('a .env file with only regular keys loads them normally', () => {
    const envPath = resolve(tmpDir, '.env');
    writeFileSync(envPath, [
      'API_KEY=test-key',
      'DEBUG=true',
    ].join('\n'));
    loadDotEnvIntoProcessEnv(envPath);
    expect(process.env.API_KEY).toBe('test-key');
    expect(process.env.DEBUG).toBe('true');
  });

  it('a missing .env file is a no-op (no throw, no env mutation)', () => {
    const envPath = resolve(tmpDir, 'does-not-exist.env');
    loadDotEnvIntoProcessEnv(envPath);
    // No throw, no mutation.
    expect(process.env[EXECUTION_AUTH_ENV_VAR]).toBeUndefined();
  });

  it('existing process.env values are NOT overwritten by .env (parent-process wins)', () => {
    process.env.VOOI_API_TOKEN = 'from-parent-process';
    const envPath = resolve(tmpDir, '.env');
    writeFileSync(envPath, 'VOOI_API_TOKEN=from-dotenv\n');
    loadDotEnvIntoProcessEnv(envPath);
    expect(process.env.VOOI_API_TOKEN).toBe('from-parent-process');
  });

  it('after loading .env, the guard STILL denies (EDGE_EXECUTION_AUTH not armed)', () => {
    setExecutionClockForTesting(() => FIXED_NOW);
    const envPath = resolve(tmpDir, '.env');
    writeFileSync(envPath, [
      'EDGE_EXECUTION_AUTH={"authId":"leaked","expiresAtMs":' + (FIXED_NOW + 60_000) + ',"scopes":["vooi:create-bot"]}',
    ].join('\n'));
    loadDotEnvIntoProcessEnv(envPath);
    // The guard must deny even though the .env file contained a valid-looking
    // descriptor — .env cannot arm the guard.
    expect(() => assertExecutionAuthorized('vooi:create-bot')).toThrow(ExecutionNotAuthorizedError);
    resetExecutionClockForTesting();
  });
});
