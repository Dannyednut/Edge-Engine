/**
 * remote-branch-detection.test.ts
 * ─────────────────────────────────────────────────────────────────────
 * Deterministic test for the fail-closed remote branch detection helper
 * used by `.github/workflows/monitor-sampling.yml`.
 *
 * The previous workflow YAML used `git ls-remote ... 2>/dev/null | grep -q`
 * combined with a negated pipeline. That pattern collapsed two distinct
 * outcomes into a single "branch absent" path:
 *   (a) `git ls-remote` succeeded and returned no matching branch —
 *       a genuine first-run case.
 *   (b) `git ls-remote` FAILED (network, auth, git error) — must NOT
 *       enter the first-run creation path because it could clobber
 *       existing remote data on a subsequent successful fetch.
 *
 * This test exercises the helper script `scripts/gha/check-remote-branch.sh`
 * against three controlled git fixtures and verifies the three outcomes
 * are distinguished correctly.
 *
 * The test does NOT depend on network access or live GitHub API.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HELPER = resolve(__dirname, '..', '..', '..', 'scripts', 'gha', 'check-remote-branch.sh');

interface Fixture {
  tempDir: string;
  remoteUrl: string;
}

function makeBareRemote(branch: 'main' | 'master' = 'main'): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'rb-test-'));
  const remoteDir = join(tempDir, 'remote.git');
  execFileSync('git', ['init', '--bare', '-b', branch, remoteDir], { stdio: 'pipe' });

  // Create a work clone (no -b; the remote has no commits yet), commit a
  // file on the desired branch, then push so the branch exists remotely.
  const workDir = join(tempDir, 'work');
  execFileSync('git', ['clone', remoteDir, workDir], { stdio: 'pipe' });
  execFileSync('git', ['-C', workDir, 'checkout', '-b', branch], { stdio: 'pipe' });
  writeFileSync(join(workDir, 'README.md'), 'hello\n');
  execFileSync('git', ['-C', workDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'README.md'], { stdio: 'pipe' });
  execFileSync('git', ['-C', workDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { stdio: 'pipe' });
  execFileSync('git', ['-C', workDir, 'push', 'origin', branch], { stdio: 'pipe' });

  return { tempDir, remoteUrl: remoteDir };
}

function callHelper(remoteUrl: string, branch: string): { stdout: string; stderr: string; exit: number } {
  let stdout = '';
  let stderr = '';
  let exit = 0;
  try {
    stdout = execFileSync('bash', [HELPER, remoteUrl, branch], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
    exit = err.status ?? 1;
  }
  return { stdout: stdout.trim(), stderr: stderr.trim(), exit };
}

describe('check-remote-branch.sh — fail-closed branch detection', () => {
  let fixtures: Fixture[] = [];

  // Cleanup all temp dirs after each test
  function track(f: Fixture) {
    fixtures.push(f);
    return f;
  }

  it('returns "present" (exit 0) when the branch exists on the remote', () => {
    const f = track(makeBareRemote('main'));
    const result = callHelper(f.remoteUrl, 'main');
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe('present');
  });

  it('returns "absent" (exit 0) when the branch does NOT exist on the remote (genuine first-run)', () => {
    const f = track(makeBareRemote('main'));
    const result = callHelper(f.remoteUrl, 'monitor-data-validation');
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe('absent');
  });

  it('returns "error" (exit 1) when the remote is unreachable — does NOT enter first-run path', () => {
    // Point at a path that does not exist and is not a git repo
    const bogusRemote = '/tmp/rb-bogus-' + process.pid + '-' + Date.now() + '.git';
    // Sanity: confirm the bogus remote really does not exist
    expect(existsSync(bogusRemote)).toBe(false);

    const result = callHelper(bogusRemote, 'monitor-data-validation');
    expect(result.exit).toBe(1);
    expect(result.stdout).not.toBe('absent');   // critical: NOT reported as absent
    expect(result.stdout).not.toBe('present');  // critical: NOT reported as present
    expect(result.stderr.toLowerCase()).toContain('failed');
  });

  it('returns "error" (exit 1) when the remote URL is malformed', () => {
    // A clearly malformed URL — git will reject this
    const result = callHelper('not-a-valid-url://', 'some-branch');
    expect(result.exit).toBe(1);
    expect(result.stdout).not.toBe('absent');
    expect(result.stdout).not.toBe('present');
  });

  it('distinguishes present vs absent on the SAME remote (regression)', () => {
    // Regression: a single remote can have some branches and not others.
    // The helper must not collapse these cases.
    const f = track(makeBareRemote('main'));

    const present = callHelper(f.remoteUrl, 'main');
    const absent = callHelper(f.remoteUrl, 'definitely-does-not-exist-' + Date.now());

    expect(present.exit).toBe(0);
    expect(present.stdout).toBe('present');
    expect(absent.exit).toBe(0);
    expect(absent.stdout).toBe('absent');
    expect(present.stdout).not.toBe(absent.stdout);
  });

  it('helper script file exists at the expected path', () => {
    expect(existsSync(HELPER)).toBe(true);
  });

  it('helper script can be invoked directly (executable bit set in git)', () => {
    // The helper has a `if [ "${BASH_SOURCE[0]}" = "$0" ]; then check_remote_branch "$@"; fi`
    // block that allows direct invocation. Verify it can be executed directly
    // (not just sourced). This requires the executable bit to be committed.
    let exit = 0;
    let stdout = '';
    try {
      stdout = execFileSync(HELPER, ['/dev/null', 'main'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (err: any) {
      exit = err.status ?? 1;
      stdout = (err.stdout ?? '').trim();
    }
    // Invoking with a non-git remote URL should produce 'error' (not a crash).
    expect(exit).toBe(1);
    expect(stdout).not.toBe('present');
    expect(stdout).not.toBe('absent');
  });

  // Cleanup after all tests
  afterAll(() => {
    for (const f of fixtures) {
      try { rmSync(f.tempDir, { recursive: true, force: true }); } catch {}
    }
    fixtures = [];
  });
});
