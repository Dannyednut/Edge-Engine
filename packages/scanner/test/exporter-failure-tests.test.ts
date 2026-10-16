/**
 * exporter-failure-tests.test.ts
 * ─────────────────────────────────────────────────────────────────────
 * Tests that exercise the ACTUAL exporter script by running it as a
 * subprocess with isolated temporary fixtures. No hardcoded paths.
 * Tests fail against defective behavior and pass only after fixes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// Derive paths from module location (portable)
const REPO = resolve(__dirname, '..', '..', '..');
const EXPORTER = resolve(REPO, 'scripts', 'export-evidence-bundle.py');
const PYTHON = 'python3';

// Isolated temp directory for test fixtures — unique per test run
const TMP = join(tmpdir(), `exporter-test-${process.pid}-${Date.now()}`);
const TMP_DATA = join(TMP, 'data');
const TMP_LOGS = join(TMP, 'logs');
const TMP_OUTPUT = join(TMP, 'output');

function setupTempRepo(obs: { limusd?: string[]; cadence?: string[]; defillama?: string[] }) {
  // Always recreate to ensure clean state
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP_DATA, 'limusd-study'), { recursive: true });
  mkdirSync(join(TMP_DATA, 'khope-study'), { recursive: true });
  mkdirSync(TMP_LOGS, { recursive: true });
  mkdirSync(TMP_OUTPUT, { recursive: true });

  if (obs.limusd) {
    writeFileSync(join(TMP_DATA, 'limusd-study', 'observations.jsonl'), obs.limusd.join('\n') + '\n');
  }
  if (obs.cadence) {
    writeFileSync(join(TMP_DATA, 'khope-study', 'cadence-observations.jsonl'), obs.cadence.join('\n') + '\n');
  }
  if (obs.defillama) {
    writeFileSync(join(TMP_DATA, 'khope-study', 'observations.jsonl'), obs.defillama.join('\n') + '\n');
  }
  // Minimal state/log files
  writeFileSync(join(TMP_DATA, 'limusd-study', 'monitor-state.json'), '{}');
  writeFileSync(join(TMP_DATA, 'khope-study', 'cadence-state.json'), '{}');
  writeFileSync(join(TMP_LOGS, 'limusd-monitor.log'), '[limusd] test\n');
  writeFileSync(join(TMP_LOGS, 'khype-cadence-sampler.log'), '[khype] test\n');
  writeFileSync(join(TMP_LOGS, 'khype-timeseries.log'), '[kHYPE] test\n');
  writeFileSync(join(TMP_LOGS, 'daemon-supervisor.log'), '[supervisor] test\n');
}

function runExporter(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(PYTHON, [EXPORTER, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      exitCode: e.status || 1,
    };
  }
}

// Helper: verify temp files exist before running exporter
function verifyTempFiles() {
  const limusdPath = join(TMP_DATA, 'limusd-study', 'observations.jsonl');
  if (!existsSync(limusdPath)) {
    throw new Error(`Temp file missing: ${limusdPath}`);
  }
}

// Valid observation fixtures
const validLimusd = [
  JSON.stringify({ ts: '2026-10-15T12:00:00Z', blockNumber: 100, source: 'hyperevm-rpc', limUsdTotalSupplyRaw: '1000', ptTotalSupplyRaw: '500', syTotalSupplyRaw: '800', limUsdTotalSupply: '1.0', ptTotalSupply: '0.5', syTotalSupply: '0.8', navRaw: '1035', navUsd: '1.035', sharePrice: '1.035', redemptionBufferRaw: '0', redemptionBufferUsd: 0, ptApy: 10, underlyingApy: 8, ptTvlUsd: 1000, underlyingTvlUsd: 8000, ptExpiry: 1795651200, ptMaturityDate: '2026-11-26', rpcSuccess: true, defillamaSuccess: true, readFailures: [], alerts: [], vetoFlag: false, dailyDeclinePct: null, bufferBreachActive: true }),
  JSON.stringify({ ts: '2026-10-15T12:10:00Z', blockNumber: 101, source: 'hyperevm-rpc', limUsdTotalSupplyRaw: '1000', ptTotalSupplyRaw: '500', syTotalSupplyRaw: '800', limUsdTotalSupply: '1.0', ptTotalSupply: '0.5', syTotalSupply: '0.8', navRaw: '1035', navUsd: '1.035', sharePrice: '1.035', redemptionBufferRaw: '0', redemptionBufferUsd: 0, ptApy: 10, underlyingApy: 8, ptTvlUsd: 1000, underlyingTvlUsd: 8000, ptExpiry: 1795651200, ptMaturityDate: '2026-11-26', rpcSuccess: true, defillamaSuccess: true, readFailures: [], alerts: [], vetoFlag: false, dailyDeclinePct: null, bufferBreachActive: true }),
];
const validCadence = [
  JSON.stringify({ ts: '2026-10-15T12:00:00Z', blockNumber: 100, source: 'hyperevm-rpc', totalRewardsRaw: '1000', khypeToHypeRaw: '1026', totalStakedRaw: '5000', khypeTotalSupplyRaw: '1000', totalRewards: '1.0', anchorExchangeRate: '1.026', totalStaked: '5.0', khypeTotalSupply: '1.0', totalRewardsDelta: null, anchorDelta: null, rewardStepDetected: false, negativeDeltaAnomaly: false, secsSincePrevSample: null, rpcSuccess: true, readFailures: [] }),
];
const validDefillama = [
  JSON.stringify({ ts: '2026-10-15T12:00:00Z', source: 'defillama', apiStatus: 'ok', fetchMs: 100, totalPoolsScanned: 100, matchedPools: 1, pools: [] }),
];

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('Exporter — real script execution with temp fixtures', () => {
  it('succeeds with valid observations in the window', () => {
    setupTempRepo({ limusd: validLimusd, cadence: validCadence, defillama: validDefillama });
    verifyTempFiles();
    const result = runExporter([
      '--window-id', 'TestWin',
      '--window-start', '2026-10-15T12:00:00Z',
      '--window-completion', '2026-10-16T12:00:00Z',
      '--data-root', TMP,
      '--output-dir', TMP_OUTPUT,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Audit/raw-count consistency: PASS');
    expect(result.stdout).toContain('TestWin');
  });

  it('fails when --window-id is missing', () => {
    const result = runExporter([
      '--window-start', '2026-10-15T12:00:00Z',
      '--window-completion', '2026-10-16T12:00:00Z',
      '--data-root', TMP,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('required');
  });

  it('fails when completion is before start', () => {
    const result = runExporter([
      '--window-id', 'Test',
      '--window-start', '2026-10-16T12:00:00Z',
      '--window-completion', '2026-10-15T12:00:00Z',
      '--data-root', TMP,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('must be after');
  });

  it('fails when timestamp is not UTC (no Z suffix)', () => {
    const result = runExporter([
      '--window-id', 'Test',
      '--window-start', '2026-10-15T12:00:00',
      '--window-completion', '2026-10-16T12:00:00Z',
      '--data-root', TMP,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('UTC');
  });

  it('fails on window_start mismatch >5 min from first observation', () => {
    setupTempRepo({ limusd: validLimusd, cadence: validCadence, defillama: validDefillama });
    const result = runExporter([
      '--window-id', 'Test',
      '--window-start', '2026-10-15T11:00:00Z',  // 1h before first obs at 12:00
      '--window-completion', '2026-10-16T12:00:00Z',
      '--data-root', TMP,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('differs from first observation');
  });

  it('fails on empty required observation file', () => {
    setupTempRepo({ limusd: [], cadence: validCadence, defillama: validDefillama });
    // limusd file exists but is empty (0 lines)
    writeFileSync(join(TMP_DATA, 'limusd-study', 'observations.jsonl'), '');
    const result = runExporter([
      '--window-id', 'Test',
      '--window-start', '2026-10-15T12:00:00Z',
      '--window-completion', '2026-10-16T12:00:00Z',
      '--data-root', TMP,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('empty');
  });

  it('fails on malformed JSONL', () => {
    setupTempRepo({ limusd: ['{invalid json}'], cadence: validCadence, defillama: validDefillama });
    const result = runExporter([
      '--window-id', 'Test',
      '--window-start', '2026-10-15T12:00:00Z',
      '--window-completion', '2026-10-16T12:00:00Z',
      '--data-root', TMP,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('malformed JSON');
  });

  it('fails on missing observation timestamp', () => {
    const noTsObs = [JSON.stringify({ blockNumber: 100, source: 'hyperevm-rpc' })]; // no 'ts' field
    setupTempRepo({ limusd: noTsObs, cadence: validCadence, defillama: validDefillama });
    const result = runExporter([
      '--window-id', 'Test',
      '--window-start', '2026-10-15T12:00:00Z',
      '--window-completion', '2026-10-16T12:00:00Z',
      '--data-root', TMP,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("missing 'ts'");
  });

  it('fails when no observations in the requested window', () => {
    // Observations at 12:00, but window is 13:00-14:00
    setupTempRepo({ limusd: validLimusd, cadence: validCadence, defillama: validDefillama });
    const result = runExporter([
      '--window-id', 'Test',
      '--window-start', '2026-10-15T13:00:00Z',
      '--window-completion', '2026-10-15T14:00:00Z',
      '--data-root', TMP,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('no observations found in window');
  });

  it('excludes observations after window completion', () => {
    // Add an observation at 13:00 (after completion at 12:30)
    const obsWithLate = [...validLimusd, JSON.stringify({ ts: '2026-10-15T13:00:00Z', blockNumber: 102, source: 'hyperevm-rpc', limUsdTotalSupplyRaw: '1000', ptTotalSupplyRaw: '500', syTotalSupplyRaw: '800', limUsdTotalSupply: '1.0', ptTotalSupply: '0.5', syTotalSupply: '0.8', navRaw: '1035', navUsd: '1.035', sharePrice: '1.035', redemptionBufferRaw: '0', redemptionBufferUsd: 0, ptApy: 10, underlyingApy: 8, ptTvlUsd: 1000, underlyingTvlUsd: 8000, ptExpiry: 1795651200, ptMaturityDate: '2026-11-26', rpcSuccess: true, defillamaSuccess: true, readFailures: [], alerts: [], vetoFlag: false, dailyDeclinePct: null, bufferBreachActive: true })];
    setupTempRepo({ limusd: obsWithLate, cadence: validCadence, defillama: validDefillama });
    // Window: 12:00 to 12:30 — the 13:00 obs should be excluded
    const result = runExporter([
      '--window-id', 'Test',
      '--window-start', '2026-10-15T12:00:00Z',
      '--window-completion', '2026-10-15T12:30:00Z',
      '--data-root', TMP,
    ]);
    expect(result.exitCode).toBe(0);
    // Should have 2 LIMUSD obs (12:00 and 12:10), NOT 3 (13:00 excluded)
    expect(result.stdout).toContain('LIMUSD: 2 obs');
  });

  it('produces audit with correct window_id (not Window 7)', () => {
    setupTempRepo({ limusd: validLimusd, cadence: validCadence, defillama: validDefillama });
    const result = runExporter([
      '--window-id', 'Window 8',
      '--window-start', '2026-10-15T12:00:00Z',
      '--window-completion', '2026-10-16T12:00:00Z',
      '--data-root', TMP,
      '--output-dir', TMP_OUTPUT,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Window ID: Window 8');
    expect(result.stdout).toContain('window8-audit.json');
    expect(result.stdout).not.toContain('Window 7');
    expect(result.stdout).not.toContain('window7-audit.json');
  });

  it('fails on missing required observation file', () => {
    // Don't create limusd observations file
    setupTempRepo({ cadence: validCadence, defillama: validDefillama });
    rmSync(join(TMP_DATA, 'limusd-study', 'observations.jsonl'), { force: true });
    const result = runExporter([
      '--window-id', 'Test',
      '--window-start', '2026-10-15T12:00:00Z',
      '--window-completion', '2026-10-16T12:00:00Z',
      '--data-root', TMP,
    ]);
    expect(result.exitCode).not.toBe(0);
    // The exporter reports "required file missing from bundle" when the
    // source file doesn't exist and thus wasn't copied to the bundle
    expect(result.stderr).toContain('missing');
  });
});

describe('One-shot mode — source code verification', () => {
  it('all samplers have --once flag, exit 0 on success, exit 1 on failure', () => {
    const limusdSource = readFileSync(resolve(REPO, 'packages/scanner/src/runners/limusd-monitor.ts'), 'utf-8');
    expect(limusdSource).toContain("process.argv.includes('--once')");
    expect(limusdSource).toContain('process.exit(0)');
    expect(limusdSource).toContain('process.exit(1)');

    const cadenceSource = readFileSync(resolve(REPO, 'packages/scanner/src/runners/khype-cadence-sampler.ts'), 'utf-8');
    expect(cadenceSource).toContain("process.argv.includes('--once')");
    expect(cadenceSource).toContain('process.exit(0)');
    expect(cadenceSource).toContain('process.exit(1)');

    const defiSource = readFileSync(resolve(REPO, 'packages/scanner/src/runners/khype-timeseries.ts'), 'utf-8');
    expect(defiSource).toContain("process.argv.includes('--once')");
    expect(defiSource).toContain('process.exit(0)');
    expect(defiSource).toContain('process.exit(1)');
  });

  it('commit functions return boolean', () => {
    const limusdSource = readFileSync(resolve(REPO, 'packages/scanner/src/runners/limusd-monitor.ts'), 'utf-8');
    expect(limusdSource).toContain('export function commitObservation(');
    expect(limusdSource).toContain('): boolean {');

    const cadenceSource = readFileSync(resolve(REPO, 'packages/scanner/src/runners/khype-cadence-sampler.ts'), 'utf-8');
    expect(cadenceSource).toContain('export function commitCadenceObservation(');
    expect(cadenceSource).toContain('): boolean {');

    const defiSource = readFileSync(resolve(REPO, 'packages/scanner/src/runners/khype-timeseries.ts'), 'utf-8');
    expect(defiSource).toContain('function appendObservation(obs: Observation): boolean {');
    expect(defiSource).toContain('return true');
    expect(defiSource).toContain('return false');
  });
});
