import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  EXECUTION_AUTH_ENV_VAR,
  ExecutionNotAuthorizedError,
  parseDotEnvContents,
  loadDotEnvIntoProcessEnv,
  setExecutionClockForTesting,
  resetExecutionClockForTesting,
} from '@edge/risk';
import { createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ─── EM-STRAT-012-R2 — contracts/scripts/deploy.ts containment tests ────
//
// Work order A8: offline deterministic tests proving
//   1. IMPORT SAFETY — importing deploy.ts does not call main(), does not
//      read .env, does not mutate process.env, and does not deploy.
//   2. FAIL-CLOSED DENIAL — main() denies (ExecutionNotAuthorizedError)
//      BEFORE .env loading, bytecode read, signer/client construction, or
//      any network request, when the 'entrypoint:contracts-deploy' scope is
//      absent, expired, or unrelated.
//   3. .env CANNOT ARM THE GUARD — a descriptor persisted in .env is
//      excluded by the shared dotenv-safety helper, and the guard fires
//      before the loader runs anyway.
//   4. AUTHORIZED PATH — with a valid scope, main() proceeds past the guard
//      and the .env load and stops at CLI validation; signer construction
//      and network transport are NEVER reached (mocked to throw if they
//      were).
//
// All fixtures are in-memory or temp-dir files with FAKE values; the real
// repository .env is NEVER read (env path is injected per test). No network,
// no signing, no deployment — fully offline under the global offline guard.

vi.mock('viem', () => ({
  createWalletClient: vi.fn(() => {
    throw new Error('SYNTHETIC: createWalletClient must not be constructed in this test');
  }),
  createPublicClient: vi.fn(() => {
    throw new Error('SYNTHETIC: createPublicClient must not be constructed in this test');
  }),
  http: vi.fn(() => 'SYNTHETIC-HTTP-TRANSPORT'),
}));

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => {
    throw new Error('SYNTHETIC: privateKeyToAccount must not be constructed in this test');
  }),
}));

// Partial mock: keep the REAL guard behavior (reads process.env at check
// time), but wrap the .env loader in a spy so tests can prove WHEN it runs.
vi.mock('@edge/risk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@edge/risk')>();
  return {
    ...actual,
    loadDotEnvIntoProcessEnv: vi.fn(actual.loadDotEnvIntoProcessEnv),
  };
});

const FIXED_NOW = 1_700_000_000_000;
const DEPLOY_SCOPE = 'entrypoint:contracts-deploy';
const DEPLOY_TS = resolve(__dirname, '..', '..', '..', 'contracts', 'scripts', 'deploy.ts');
const PREFLIGHT_TS = resolve(__dirname, '..', '..', '..', 'contracts', 'scripts', 'preflight.ts');

function authFor(...args: Array<string | number>): string {
  // Accepts scopes in any position plus an optional numeric expiresAtMs
  // (absolute epoch ms) — e.g. authFor(SCOPE) or authFor(SCOPE, FIXED_NOW - 1000).
  const scopes = args.filter((a): a is string => typeof a === 'string');
  const expiresAtMs = args.find((a): a is number => typeof a === 'number') ?? FIXED_NOW + 60_000;
  return JSON.stringify({ authId: 'r2-test', expiresAtMs, scopes });
}

function makeTempEnvDir(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'edge-deploy-containment-'));
  writeFileSync(join(dir, '.env'), body, 'utf8');
  return dir;
}

const FAKE_ENV_BODY = [
  'AGENT_EVM_PRIVATE_KEY=0xfake-not-a-real-key-test-fixture-only',
  'PRINCIPAL_EVM_ADDRESS=0x0000000000000000000000000000000000000facade',
  '',
].join('\n');

describe('contracts deploy entrypoint — import safety (EM-STRAT-012-R2 work order A5)', () => {
  it('importing deploy.ts does not call main(), read .env, or mutate process.env', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const keysBefore = new Set(Object.keys(process.env));

    const deploy = await import('../../../contracts/scripts/deploy');

    // Exports are present (proof the module loaded cleanly).
    expect(typeof deploy.main).toBe('function');
    expect(typeof deploy.isDirectEntrypointInvocation).toBe('function');
    expect(deploy.ENTRYPOINT_SCOPE).toBe(DEPLOY_SCOPE);

    // No side effects at import time.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    const keysAfter = new Set(Object.keys(process.env));
    const added = [...keysAfter].filter(k => !keysBefore.has(k));
    expect(added).toEqual([]);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('isDirectEntrypointInvocation: true only for the module invoked as the process entrypoint', async () => {
    const deploy = await import('../../../contracts/scripts/deploy');
    const selfUrl = pathToFileURL(DEPLOY_TS).href;

    expect(deploy.isDirectEntrypointInvocation(selfUrl, DEPLOY_TS)).toBe(true);
    // Relative path resolving to the same file.
    expect(deploy.isDirectEntrypointInvocation(selfUrl, 'contracts/scripts/deploy.ts')).toBe(true);
    // Test module invoked as itself (predicate is generic).
    expect(deploy.isDirectEntrypointInvocation(import.meta.url, fileURLToPath(import.meta.url))).toBe(true);
    // No argv[1], foreign binary, or unresolvable path → not a direct run.
    expect(deploy.isDirectEntrypointInvocation(selfUrl, undefined)).toBe(false);
    expect(deploy.isDirectEntrypointInvocation(selfUrl, '/usr/local/bin/vitest')).toBe(false);
    expect(deploy.isDirectEntrypointInvocation(selfUrl, '')).toBe(false);
  });
});

describe('contracts deploy entrypoint — fail-closed denial (EM-STRAT-012-R2 work order A3/A4/A8)', () => {
  let tempDir: string | undefined;

  beforeEach(() => {
    setExecutionClockForTesting(() => FIXED_NOW);
    vi.unstubAllEnvs();
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    vi.mocked(loadDotEnvIntoProcessEnv).mockClear();
    vi.mocked(createWalletClient).mockClear();
    vi.mocked(privateKeyToAccount).mockClear();
  });
  afterEach(() => {
    resetExecutionClockForTesting();
    vi.unstubAllEnvs();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('denies when EDGE_EXECUTION_AUTH is absent — BEFORE .env load, bytecode read, or signer construction', async () => {
    const deploy = await import('../../../contracts/scripts/deploy');
    await expect(deploy.main()).rejects.toThrow(ExecutionNotAuthorizedError);
    await expect(deploy.main()).rejects.toThrow(/entrypoint:contracts-deploy/);
    // Guard-first ordering: the .env loader has NOT run yet.
    expect(vi.mocked(loadDotEnvIntoProcessEnv)).not.toHaveBeenCalled();
    // Signer construction never reached (would throw SYNTHETIC if called).
    expect(privateKeyToAccount).not.toHaveBeenCalled();
    expect(createWalletClient).not.toHaveBeenCalled();
  });

  it('denies an EXPIRED descriptor (fail-closed, per-call clock)', async () => {
    const deploy = await import('../../../contracts/scripts/deploy');
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor(DEPLOY_SCOPE, FIXED_NOW - 1_000));
    await expect(deploy.main()).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(vi.mocked(loadDotEnvIntoProcessEnv)).not.toHaveBeenCalled();
    expect(privateKeyToAccount).not.toHaveBeenCalled();
    expect(createWalletClient).not.toHaveBeenCalled();
  });

  it('denies a descriptor whose scopes do NOT include entrypoint:contracts-deploy (scoped control)', async () => {
    const deploy = await import('../../../contracts/scripts/deploy');
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('entrypoint:go-live', 'vooi:place-arbitrage-order'));
    await expect(deploy.main()).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(vi.mocked(loadDotEnvIntoProcessEnv)).not.toHaveBeenCalled();
    expect(privateKeyToAccount).not.toHaveBeenCalled();
  });

  it('a descriptor supplied ONLY via .env can never authorize deployment (work order A4)', async () => {
    const deploy = await import('../../../contracts/scripts/deploy');
    // Temp .env CARRIES a valid-looking descriptor; the process env does not.
    tempDir = makeTempEnvDir(
      `${FAKE_ENV_BODY}${EXECUTION_AUTH_ENV_VAR}=${authFor(DEPLOY_SCOPE)}\n`,
    );
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, '');
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    // Guard fires FIRST (before the loader would even read the file).
    await expect(deploy.main({ envPath: join(tempDir, '.env') })).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(vi.mocked(loadDotEnvIntoProcessEnv)).not.toHaveBeenCalled();
    // And the shared loader itself excludes the key: even if main() had
    // proceeded, the descriptor in .env would not have armed the guard.
    const before = process.env[EXECUTION_AUTH_ENV_VAR];
    loadDotEnvIntoProcessEnv(join(tempDir, '.env'));
    expect(process.env[EXECUTION_AUTH_ENV_VAR]).toBe(before);
    // Prove the fixture really contained the key (the exclusion is the
    // loader's doing, not an empty fixture).
    expect(readFileSync(join(tempDir, '.env'), 'utf8')).toContain(`${EXECUTION_AUTH_ENV_VAR}=`);
  });

  it('the shared parser drops EDGE_EXECUTION_AUTH from .env contents (direct fixture test)', () => {
    const parsed = parseDotEnvContents(
      `AGENT_EVM_PRIVATE_KEY=0xfake-test-fixture\n${EXECUTION_AUTH_ENV_VAR}={"authId":"evil","expiresAtMs":9999999999999,"scopes":["${DEPLOY_SCOPE}"]}\nPRINCIPAL_EVM_ADDRESS=0xdead\n`,
    );
    expect(parsed[EXECUTION_AUTH_ENV_VAR]).toBeUndefined();
    expect(parsed.AGENT_EVM_PRIVATE_KEY).toBe('0xfake-test-fixture');
    expect(parsed.PRINCIPAL_EVM_ADDRESS).toBe('0xdead');
  });
});

describe('contracts deploy entrypoint — authorized path stops at CLI validation (no signer, no network)', () => {
  let tempDir: string | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const realArgv = process.argv;

  beforeEach(() => {
    setExecutionClockForTesting(() => FIXED_NOW);
    vi.unstubAllEnvs();
    // process.exit is re-routed to a sentinel throw so the CLI validation
    // exit is observable WITHOUT terminating the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`PROCESS_EXIT_SENTINEL:${code}`);
    }) as never);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(loadDotEnvIntoProcessEnv).mockClear();
    vi.mocked(createWalletClient).mockClear();
    vi.mocked(privateKeyToAccount).mockClear();
  });
  afterEach(() => {
    process.argv = realArgv;
    exitSpy.mockRestore();
    errSpy.mockRestore();
    resetExecutionClockForTesting();
    vi.unstubAllEnvs();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('with a valid scope, main() passes the guard, loads the injected .env, then exits on missing --chain — signer and transport NEVER constructed', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor(DEPLOY_SCOPE));
    process.argv = ['node', 'vitest', 'run']; // no --chain flag
    const deploy = await import('../../../contracts/scripts/deploy');
    tempDir = makeTempEnvDir(FAKE_ENV_BODY);
    const envFile = join(tempDir, '.env');
    expect(existsSync(envFile)).toBe(true);

    // Guard passes → env load runs (with the INJECTED temp path — the real
    // repository .env is never read) → CLI validation fails → sentinel exit.
    await expect(deploy.main({ envPath: envFile })).rejects.toThrow('PROCESS_EXIT_SENTINEL:1');
    expect(vi.mocked(loadDotEnvIntoProcessEnv)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadDotEnvIntoProcessEnv)).toHaveBeenCalledWith(envFile);
    // The failure is the missing --chain flag, NOT a guard denial.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--chain=<chain> required'));
    // Signer/transport construction never reached.
    expect(privateKeyToAccount).not.toHaveBeenCalled();
    expect(createWalletClient).not.toHaveBeenCalled();
  });
});

describe('contracts scripts — .env loader hygiene (static source checks, R2 work order A4)', () => {
  it('deploy.ts and preflight.ts use the shared loadDotEnvIntoProcessEnv helper and no inline parser', () => {
    for (const path of [DEPLOY_TS, PREFLIGHT_TS]) {
      const src = readFileSync(path, 'utf8');
      expect(src).toContain('loadDotEnvIntoProcessEnv(');
      // The old inline .env loader pattern must NOT reappear.
      expect(src).not.toMatch(/process\.env\[k\]\s*=\s*v\.replace/);
      // No locally-defined loader shadowing the shared helper.
      expect(src).not.toMatch(/function loadDotEnvIntoProcessEnv/);
    }
  });

  it('deploy.ts asserts the guard before any other statement in main()', () => {
    const src = readFileSync(DEPLOY_TS, 'utf8');
    const mainBody = src.slice(src.indexOf('export async function main'));
    const guardAt = mainBody.indexOf("assertExecutionAuthorized(ENTRYPOINT_SCOPE)");
    expect(guardAt).toBeGreaterThan(-1);
    const firstOtherAction = Math.min(
      ...['loadDotEnvIntoProcessEnv(', 'privateKeyToAccount(', 'createWalletClient(', 'readFileSync(']
        .map(tok => {
          const i = mainBody.indexOf(tok);
          return i === -1 ? Number.MAX_SAFE_INTEGER : i;
        }),
    );
    expect(guardAt).toBeLessThan(firstOtherAction);
  });
});
