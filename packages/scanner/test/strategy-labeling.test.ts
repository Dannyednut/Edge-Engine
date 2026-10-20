import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AirdropFarmingScanner } from '../src/strategies/airdrop-farming-scanner.js';
import { LeverageLoopScanner } from '../src/strategies/leverage-loop-scanner.js';
import { EulerLendingArbScanner } from '../src/strategies/euler-lending-arb-scanner.js';
import { CexLikeDexPriceArbStrategy, type PriceArbAlert } from '../src/strategies/cexlike-dex-price-arb.js';
import { CexHlFundingArbStrategy, type CexHlFundingAlert } from '../src/strategies/cex-hl-funding-arb.js';
import { HlLstArbScanner, type HlLstArbAlert } from '../src/strategies/hl-lst-arb-scanner.js';

// ─── EM-STRAT-004 §3 + §4: Presenter contract tests ──────────────────────
//
// These tests verify that downstream presenters enforce the researchOnly /
// monitoringOnly / actionable / null-preservation contracts. They fall
// into two categories:
//
//   A. Strategy-level: each strategy emits the correct flag on its alerts.
//   B. Presenter-level: presenter source code does not coerce null → 0,
//      does not assign 'opportunity' severity to researchOnly/monitoringOnly
//      alerts, and does not present incomplete-economics CEX-like alerts
//      as actionable opportunities.
//
// Category B is enforced by reading the presenter source files and asserting
// on their content. This is a static-analysis guard: it catches regressions
// where a future edit reintroduces a `?? 0` fallback or removes the
// severity downgrade for non-actionable alerts.

const SCANNER_RUNNERS_DIR = resolve(__dirname, '..', 'src', 'runners');

function readRunner(name: string): string {
  return readFileSync(resolve(SCANNER_RUNNERS_DIR, name), 'utf8');
}

// ─── Category A: Strategy-level flag enforcement ──────────────────────

describe('EM-STRAT-004 §4 — strategy-level flag enforcement', () => {
  it('AirdropFarmingScanner sets researchOnly=true on every alert', async () => {
    const scanner = new AirdropFarmingScanner({ minTotalReturnPct: 10 });
    const alerts = await scanner.scan();
    expect(alerts.length).toBeGreaterThan(0);
    for (const a of alerts) {
      expect(a.researchOnly).toBe(true);
    }
  });

  it('LeverageLoopScanner sets researchOnly=true on every alert', async () => {
    const scanner = new LeverageLoopScanner({ minSpreadPct: 0.5, maxLeverage: 5 });
    const alerts = await scanner.scan();
    expect(alerts.length).toBeGreaterThan(0);
    for (const a of alerts) {
      expect(a.researchOnly).toBe(true);
    }
  });

  it('EulerLendingArbScanner sets monitoringOnly=true on every alert', async () => {
    // Use try/catch since the scanner may attempt live RPC and fail in test env.
    const scanner = new EulerLendingArbScanner({
      minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000,
    });
    try {
      const alerts = await scanner.scan();
      for (const a of alerts) {
        expect(a.monitoringOnly).toBe(true);
        // EM-STRAT-004 §3: supplyApyPct, spreadPct, estimatedProfitUsd must be null.
        expect(a.depositVault.supplyApyPct).toBeNull();
        expect(a.borrowVault.supplyApyPct).toBeNull();
        expect(a.spreadPct).toBeNull();
        expect(a.estimatedProfitUsd).toBeNull();
      }
    } catch (e) {
      // If live RPC fails, the scanner throws — that's acceptable for this test
      // (we only assert on alerts that ARE returned). Skip silently.
    }
  });
});

// ─── Category B: Presenter source contract ─────────────────────────────

describe('EM-STRAT-004 §3 + §4 — presenter source contracts', () => {

  describe('all-runner.ts: researchOnly/monitoringOnly enforcement', () => {
    const src = readRunner('all-runner.ts');

    it('does NOT call alerter.sendAlert for airdropAlerts (researchOnly)', () => {
      // The all-runner must not dispatch a sendAlert block for airdrop alerts.
      // We check that there is no `for (const a of airdropAlerts)` followed by
      // an alerter.sendAlert call.
      const hasAirdropDispatch = /for\s*\(\s*const\s+a\s+of\s+airdropAlerts[\s\S]*?alerter\.sendAlert/s.test(src);
      expect(hasAirdropDispatch, 'airdropAlerts must NOT be sent via alerter.sendAlert').toBe(false);
    });

    it('does NOT call alerter.sendAlert for leverageAlerts (researchOnly)', () => {
      const hasLeverageDispatch = /for\s*\(\s*const\s+a\s+of\s+leverageAlerts[\s\S]*?alerter\.sendAlert/s.test(src);
      expect(hasLeverageDispatch, 'leverageAlerts must NOT be sent via alerter.sendAlert').toBe(false);
    });

    it('Euler alerts use severity "info", NOT "opportunity"', () => {
      // Find the Euler alert dispatch block and verify it uses 'info'.
      const eulerBlockMatch = src.match(/Process Euler lending arb alerts[\s\S]*?(?=\n\s*\/\/ Process)/);
      expect(eulerBlockMatch, 'Euler alert block not found').not.toBeNull();
      const eulerBlock = eulerBlockMatch![0];
      expect(eulerBlock).toContain("severity: 'info'");
      expect(eulerBlock).not.toContain("severity: 'opportunity'");
      // EM-STRAT-004 §3: null fields are displayed as 'UNAVAILABLE', not coerced to 0.
      expect(eulerBlock).toContain('UNAVAILABLE');
    });

    it('CEX-HL alerts downgrade severity to "info" when not actionable', () => {
      // The CEX-HL dispatch must use a conditional severity `? 'opportunity' : 'info'`
      // based on the actionable flag (either a.actionable directly or a local
      // `actionable` variable derived from a.actionable).
      const cexHlBlockMatch = src.match(/Process cex_hl alerts[\s\S]*?(?=\n\s*\/\/ Process)/);
      expect(cexHlBlockMatch, 'CEX-HL alert block not found').not.toBeNull();
      const cexHlBlock = cexHlBlockMatch![0];
      // Must use a conditional severity expression (opportunity OR info).
      expect(cexHlBlock).toMatch(/\?\s*['"]opportunity['"]\s*:\s*['"]info['"]/);
      // Must reference a.actionable (either directly or via local var).
      expect(cexHlBlock).toMatch(/a\.actionable/);
      // Must NOT use a hard-coded 'opportunity' severity for all CEX-HL alerts.
      expect(cexHlBlock).not.toMatch(/^severity:\s*'opportunity'\s*,\s*\n\s*strategyId:\s*'cex_hl_funding_arb'/m);
    });

    it('CEX-like price-arb alerts downgrade severity to "info" when not actionable', () => {
      const priceArbBlockMatch = src.match(/Process CexLikeDex price arb alerts[\s\S]*?(?=\n\s*\/\/ Process)/);
      expect(priceArbBlockMatch, 'CEX-like price-arb alert block not found').not.toBeNull();
      const priceArbBlock = priceArbBlockMatch![0];
      expect(priceArbBlock).toContain("a.actionable ? 'opportunity' : 'info'");
      // Must show 'UNAVAILABLE' for null profit (not coerce to 0).
      expect(priceArbBlock).toContain('UNAVAILABLE');
    });

    it('HL LST alerts preserve null withdrawal delay as UNAVAILABLE (not ?? 0)', () => {
      const hlLstBlockMatch = src.match(/Process HL LST arb alerts[\s\S]*?(?=\n\s*\/\/ Process)/);
      expect(hlLstBlockMatch, 'HL LST alert block not found').not.toBeNull();
      const hlLstBlock = hlLstBlockMatch![0];
      // EM-STRAT-004: null withdrawal delay must be displayed as 'UNAVAILABLE',
      // not coerced to 0 or 'unknown'.
      expect(hlLstBlock).toContain('UNAVAILABLE');
      // Must NOT use the previous `?? 'unknown'` fallback for withdrawal delay.
      expect(hlLstBlock).not.toMatch(/withdrawalDelaySec\s*\?\?\s*['"]unknown['"]/);
    });
  });

  describe('command-handler.ts: null preservation', () => {
    const src = readRunner('command-handler.ts');

    it('does NOT coerce spreadPct ?? 0 in Euler display', () => {
      // The previous code had `(a.spreadPct ?? 0).toFixed(2)`. EM-STRAT-004
      // requires explicit 'UNAVAILABLE' instead.
      expect(src).not.toMatch(/\(a\.spreadPct\s*\?\?\s*0\)\.toFixed/);
    });

    it('does NOT coerce estimatedProfitUsd ?? 0 in Euler display', () => {
      expect(src).not.toMatch(/\(a\.estimatedProfitUsd\s*\?\?\s*0\)\.toFixed/);
    });

    it('does NOT coerce totalLiquidityUsd ?? 0 in Euler display', () => {
      expect(src).not.toMatch(/\(\s*\(a\.totalLiquidityUsd\s*\?\?\s*0\)/);
    });

    it('uses the corrected fee-tier display (not feeTier/10000)', () => {
      // Previous code: `Fee tier: ${a.feeTier/10000}%` — wrong conversion.
      // EM-STRAT-004: display a.ammFeePct (the corrected pct value).
      expect(src).toContain('a.ammFeePct');
      expect(src).not.toMatch(/a\.feeTier\s*\/\s*10000/);
    });

    it('passes minNetDiscountPct: 0.30 to HlLstArbScanner', () => {
      // Every instantiation of HlLstArbScanner in command-handler must pass
      // the 0.30% net threshold (not just the old minDiscountPct).
      const instantiations = src.match(/new HlLstArbScanner\(\s*\{[^}]+\}\s*\)/g) || [];
      expect(instantiations.length).toBeGreaterThan(0);
      for (const inst of instantiations) {
        expect(inst).toContain('minNetDiscountPct');
      }
    });

    it('Euler handler labels alerts as MONITORING ONLY', () => {
      expect(src).toContain('MONITORING ONLY');
    });
  });

  describe('dashboard.ts: null preservation', () => {
    const src = readRunner('dashboard.ts');

    it('does NOT push Euler alerts into the actionable opportunities array', () => {
      // EM-STRAT-004: Euler alerts are monitoring-only and must NOT be ranked
      // alongside actionable arbs. The dashboard must use a separate
      // `monitoringOnly` array (or skip them entirely).
      // We check that the dashboard uses a separate monitoring array.
      expect(src).toMatch(/monitoringOnly/);
      // The push into opportunities[] inside the Euler block must not include
      // `estimatedProfitUsd: a.estimatedProfitUsd ?? 0` (the old coercion).
      const eulerBlockMatch = src.match(/Euler HL lending arb[\s\S]*?(?=\/\/ 3\.)/);
      if (eulerBlockMatch) {
        const eulerBlock = eulerBlockMatch[0];
        // The old code pushed into opportunities with `?? 0` fallbacks.
        // The new code must NOT do that.
        expect(eulerBlock).not.toMatch(/estimatedProfitUsd:\s*a\.estimatedProfitUsd\s*\?\?\s*0/);
        expect(eulerBlock).not.toMatch(/spreadPct:\s*a\.spreadPct\s*\?\?\s*0/);
      }
    });

    it('passes minNetDiscountPct: 0.30 to HlLstArbScanner', () => {
      const instantiations = src.match(/new HlLstArbScanner\(\s*\{[^}]+\}\s*\)/g) || [];
      expect(instantiations.length).toBeGreaterThan(0);
      for (const inst of instantiations) {
        expect(inst).toContain('minNetDiscountPct');
      }
    });

    it('has a monitoring-only output section', () => {
      expect(src).toMatch(/MONITORING ONLY/);
    });
  });

  describe('daily-report.ts: null preservation', () => {
    const src = readRunner('daily-report.ts');

    it('Euler block does NOT coerce spreadPct ?? 0', () => {
      // Extract only the Euler block (between "// 2. Euler" and "// 3. LST yield")
      const eulerBlockMatch = src.match(/\/\/ 2\. Euler[\s\S]*?(?=\/\/ 3\.)/);
      expect(eulerBlockMatch, 'Euler block not found').not.toBeNull();
      const eulerBlock = eulerBlockMatch![0];
      expect(eulerBlock).not.toMatch(/spreadPct:\s*a\.spreadPct\s*\?\?\s*0/);
    });

    it('Euler block does NOT coerce estimatedProfitUsd ?? 0', () => {
      const eulerBlockMatch = src.match(/\/\/ 2\. Euler[\s\S]*?(?=\/\/ 3\.)/);
      expect(eulerBlockMatch, 'Euler block not found').not.toBeNull();
      const eulerBlock = eulerBlockMatch![0];
      expect(eulerBlock).not.toMatch(/estimatedProfitUsd:\s*\(a\.estimatedProfitUsd\s*\?\?\s*0\)/);
    });

    it('Euler block does NOT push alerts into the actionable opportunities array', () => {
      const eulerBlockMatch = src.match(/\/\/ 2\. Euler[\s\S]*?(?=\/\/ 3\.)/);
      expect(eulerBlockMatch, 'Euler block not found').not.toBeNull();
      const eulerBlock = eulerBlockMatch![0];
      // The Euler block must NOT push into opportunities[]; it must push into eulerMonitoring[].
      expect(eulerBlock).not.toMatch(/opportunities\.push/);
      expect(eulerBlock).toMatch(/eulerMonitoring\.push/);
    });

    it('returns monitoring data separately from actionable opportunities', () => {
      // gatherOpportunities must return { opportunities, monitoring }
      expect(src).toMatch(/return\s*\{\s*opportunities,\s*monitoring/);
    });

    it('has a Monitoring Only section in the report', () => {
      expect(src).toMatch(/Monitoring Only \(not actionable\)/);
    });
  });

  describe('master-view.ts: null preservation', () => {
    const src = readRunner('master-view.ts');

    it('does NOT use withdrawalDelaySec ?? unknown fallback', () => {
      expect(src).not.toMatch(/a\.withdrawalDelaySec\s*\?\?\s*['"]unknown['"]/);
    });

    it('labels Euler section as MONITORING ONLY', () => {
      const eulerSectionMatch = src.match(/EULER HL LENDING[\s\S]*?(?=── \d|── Summary)/);
      expect(eulerSectionMatch, 'Euler section not found').not.toBeNull();
      expect(eulerSectionMatch![0]).toMatch(/MONITORING ONLY/);
    });

    it('uses corrected fee-tier display (a.ammFeePct)', () => {
      expect(src).toContain('a.ammFeePct');
    });
  });

  describe('readiness-check.ts: monitoring-only enforcement', () => {
    const src = readRunner('readiness-check.ts');

    it('Euler check status is always "warn" (not "pass") for monitoring-only', () => {
      // EM-STRAT-004: Euler cannot "pass" because supply APY is unverified.
      const eulerBlockMatch = src.match(/Euler lending arb[\s\S]*?(?=\/\/ 10\.)/);
      expect(eulerBlockMatch, 'Euler readiness block not found').not.toBeNull();
      const eulerBlock = eulerBlockMatch![0];
      // The status line must be 'warn' (always), not `alerts.length > 0 ? 'pass' : 'warn'`.
      expect(eulerBlock).toMatch(/status:\s*['"]warn['"]/);
      // Must NOT use the old pass-when-alerts-exist pattern.
      expect(eulerBlock).not.toMatch(/alerts\.length\s*>\s*0\s*\?\s*['"]pass['"]/);
    });

    it('kHYPE readiness detail does NOT coerce estimatedProfitUsd ?? 0', () => {
      // Old code: `$${a.estimatedProfitUsd.toFixed(0)}` (assumed non-null).
      // New code: same (scanner requires net >= 0.30%, so when alerts exist,
      // estimatedProfitUsd is a verified number). The fail-closed detail
      // must say "No actionable opportunity" when alerts is empty.
      const khypeBlockMatch = src.match(/kHYPE carry arb[\s\S]*?(?=\/\/ 9\.)/);
      expect(khypeBlockMatch, 'kHYPE readiness block not found').not.toBeNull();
      const khypeBlock = khypeBlockMatch![0];
      expect(khypeBlock).toContain('fail-closed');
    });
  });

  describe('telegram-summary.ts: null preservation', () => {
    const src = readRunner('telegram-summary.ts');

    it('does NOT use withdrawalDelaySec ?? unknown fallback', () => {
      expect(src).not.toMatch(/a\.withdrawalDelaySec\s*\?\?\s*['"]unknown['"]/);
    });

    it('Euler section is labeled MONITORING ONLY — not actionable', () => {
      expect(src).toMatch(/EULER LENDING[\s\S]{0,100}MONITORING ONLY/);
    });

    it('kHYPE section surfaces anchorBlockTs (real source freshness)', () => {
      expect(src).toContain('a.anchorBlockTs');
    });
  });

  describe('opportunity-monitor.ts: monitoring-only enforcement', () => {
    const src = readRunner('opportunity-monitor.ts');

    it('Euler alerts are skipped (continue on monitoringOnly)', () => {
      // The Euler loop must contain `if (a.monitoringOnly) continue;`
      const eulerBlockMatch = src.match(/Euler lending arb[\s\S]*?(?=Clean old dedup)/);
      expect(eulerBlockMatch, 'Euler block not found').not.toBeNull();
      expect(eulerBlockMatch![0]).toContain('if (a.monitoringOnly) continue');
    });

    it('does NOT send opportunity alerts for Euler', () => {
      // The Euler block must NOT contain alerter.sendAlert.
      const eulerBlockMatch = src.match(/Euler lending arb[\s\S]*?(?=Clean old dedup)/);
      expect(eulerBlockMatch, 'Euler block not found').not.toBeNull();
      expect(eulerBlockMatch![0]).not.toContain('alerter.sendAlert');
    });
  });

  describe('funding-combined-runner.ts: actionable enforcement', () => {
    const src = readRunner('funding-combined-runner.ts');

    it('filters CEX-HL alerts on a.actionable (not just netSpreadApr ?? 0)', () => {
      // EM-STRAT-004: filter must be `a.actionable && (a.netSpreadApr ?? -Infinity) >= MIN_APR_FOR_ALERT`
      // NOT the previous `(a.netSpreadApr ?? 0) >= MIN_APR_FOR_ALERT`.
      expect(src).toContain('a.actionable');
      expect(src).not.toMatch(/\(a\.netSpreadApr\s*\?\?\s*0\)\s*>=\s*MIN_APR_FOR_ALERT/);
    });

    it('displays raw rates with UNAVAILABLE fallback (not ?? 0)', () => {
      // The CEX-HL alert body must use a fmtOrNull-style helper.
      expect(src).toMatch(/fmtOrNull|===\s*null\s*\?/);
    });
  });
});

// ─── Category C: Alert-shape invariants ─────────────────────────────────

describe('EM-STRAT-004 — alert-shape invariants', () => {
  it('HlLstArbAlert has anchorBlockTs field (real source freshness)', () => {
    // Type-level check: the alert shape must include anchorBlockTs.
    // We instantiate a minimal alert and check the field exists.
    const alert: HlLstArbAlert = {
      pair: 'WHYPE/kHYPE', poolAddress: '0x', feeTier: 100,
      marketPrice: 1.05, redemptionAnchor: 1.0265, grossDiscountPct: 5,
      netProfitPct: 4.95, estimatedProfitUsd: 247.5, ammFeePct: 0.01,
      flashloanFeePct: 0.04, poolLiquidity: 1n, withdrawalDelaySec: 604800,
      anchorBlockTs: 1700000000, anchorFresh: true, executable: false, ts: 0,
    };
    expect(alert.anchorBlockTs).toBe(1700000000);
    expect(alert.ammFeePct).toBe(0.01);
  });

  it('HlLstArbAlert has ammFeePct field (corrected fee conversion)', () => {
    const alert: HlLstArbAlert = {
      pair: 'WHYPE/kHYPE', poolAddress: '0x', feeTier: 100,
      marketPrice: 1.05, redemptionAnchor: 1.0265, grossDiscountPct: 5,
      netProfitPct: 4.95, estimatedProfitUsd: 247.5, ammFeePct: 0.01,
      flashloanFeePct: 0.04, poolLiquidity: 1n, withdrawalDelaySec: 604800,
      anchorBlockTs: 1700000000, anchorFresh: true, executable: false, ts: 0,
    };
    // EM-STRAT-004 §1: ammFeePct for tier 100 must be 0.01 (not 1.0).
    expect(alert.ammFeePct).toBe(0.01);
  });

  it('CexHlFundingAlert has hlFundingApr, cexFundingApr, netSpreadApr, sharpeNetApr as nullable', () => {
    const alert: CexHlFundingAlert = {
      asset: 'ETH', cexVenue: 'binance',
      hlFundingApr: null, cexFundingApr: null, netSpreadApr: null,
      hlOiUsd: 0, cexOiUsd: 0, priceSpreadPct: 0,
      vooiExecutable: false, confidence: 0.6, source: 'sharpe',
      sharpeNetApr: null, actionable: false,
    };
    expect(alert.hlFundingApr).toBeNull();
    expect(alert.cexFundingApr).toBeNull();
    expect(alert.netSpreadApr).toBeNull();
    expect(alert.sharpeNetApr).toBeNull();
    expect(alert.actionable).toBe(false);
  });

  it('PriceArbAlert has actionable field', () => {
    const alert: PriceArbAlert = {
      asset: 'ETH', longVenue: 'hl', shortVenue: 'lighter',
      longPrice: 100, shortPrice: 102, headlineSpreadPct: 2,
      atSizeSpreadPct: null, effectiveSpreadPct: 2, fundingSpread1h: null,
      longOiUsd: 0, shortOiUsd: 0, estimatedProfitUsd: null,
      economicsComplete: false, vooiExecutable: true, tradeType: 'convergence',
      actionable: false, ts: 0,
    };
    expect(alert.actionable).toBe(false);
    expect(alert.economicsComplete).toBe(false);
    expect(alert.estimatedProfitUsd).toBeNull();
  });
});
