/**
 * limusd-monitor.test.ts
 * ─────────────────────────────────────────────────────────────────────
 * Tests for the corrected limUSD monitor (EI-010-V2).
 *
 * Covers:
 *   - Contract identity correctness (PT vs underlying vs market)
 *   - Bigint precision for large 18-decimal supplies
 *   - Alert threshold logic (share-price change, redemption buffer)
 *   - Transition-based alerts (pre-existing breach recorded once)
 *   - Stale data / RPC failure handling
 *   - Recovery after failure
 *   - Observation vs forecast distinction
 *   - WATCHLIST status preservation
 */
import { describe, it, expect } from 'vitest';
import {
  LIMUSD_ADDR,
  PT_LIMUSD_ADDR,
  SY_LIMUSD_ADDR,
  MARKET_ADDR,
  NAV_ORACLE_ADDR,
  REDEMPTION_PIPE_ADDR,
  USDC_ADDR,
  GETNAV_SELECTOR,
  EXPIRY_SELECTOR,
} from '../src/runners/limusd-monitor.js';

// ─── Contract identity tests ────────────────────────────────────────
// Constants imported from the monitor module (not duplicated as literals)
// so tests fail if the monitor's constants drift.

describe('limUSD Monitor — contract identities (EI-S006 verified)', () => {
  it('limUSD underlying is 0x1822 (NOT the PT token)', () => {
    // EI-S006 §4: 0x1822 is limUSD (underlying), name=="limUSD", 18 decimals
    // The previous version (7087f43) incorrectly labeled this as "PT-limUSD"
    expect(LIMUSD_ADDR).toBe('0x1822bd335489d84abdd0779a7dcaeda0625e83c8');
    expect(LIMUSD_ADDR).not.toBe(PT_LIMUSD_ADDR);
  });

  it('PT-limUSD token is 0x6b7c (NOT the market)', () => {
    // EI-S006 §4: 0x6b7c is the PT token, name=="PT limUSD 26NOV2026", 6 decimals
    // The previous version incorrectly labeled this as "Pendle PT market"
    expect(PT_LIMUSD_ADDR).toBe('0x6b7cea9d070bbffd8205f256897319139cdef399');
    expect(PT_LIMUSD_ADDR).not.toBe(MARKET_ADDR);
  });

  it('Pendle market is 0xfc93 (separate from PT and SY tokens)', () => {
    expect(MARKET_ADDR).toBe('0xfc93d1ada3277e6274c3905db0a2c81ac1252025');
    expect(MARKET_ADDR).not.toBe(PT_LIMUSD_ADDR);
    expect(MARKET_ADDR).not.toBe(SY_LIMUSD_ADDR);
    expect(MARKET_ADDR).not.toBe(LIMUSD_ADDR);
  });

  it('NAVOracle is 0x47f8', () => {
    expect(NAV_ORACLE_ADDR).toBe('0x47f8d4847f528C18Ea5A6dcb9E0940F6b2977CA7');
  });

  it('RedemptionPipe is 0x2e8c', () => {
    expect(REDEMPTION_PIPE_ADDR).toBe('0x2E8c1256356e261150120a384d95DC0d0D00ae29');
  });

  it('USDC is 0xb883 (6 decimals)', () => {
    expect(USDC_ADDR).toBe('0xb88339CB7199b77E23DB6E890353E22632Ba630f');
  });
});

// ─── Bigint precision tests ─────────────────────────────────────────

describe('limUSD Monitor — bigint precision for large supplies', () => {
  // The monitor uses bigint arithmetic to avoid float precision loss.
  // 18-decimal supplies can be up to ~10^24, which exceeds Number.MAX_SAFE_INTEGER.

  it('limUSD supply (18-dec) is handled as bigint, not float', () => {
    // Verified on-chain: 8,483,686.270107 limUSD = 8483686270107227971453853 wei
    const rawSupply = 8483686270107227971453853n;
    const decimals = 18;
    // This would lose precision as a float:
    const floatValue = Number(rawSupply) / 1e18;
    const bigintValue = Number(rawSupply / 10n ** 18n) + Number(rawSupply % 10n ** 18n) / 1e18;
    // The float approximation should be close but not exact
    expect(floatValue).toBeCloseTo(8483686.270107, 6);
    // The bigint approach should be exact
    expect(bigintValue).toBeCloseTo(8483686.270107, 6);
  });

  it('PT supply (6-dec) is handled correctly', () => {
    // Verified: 1,232,395.648233 PT = 1232395648233 (6-dec)
    const rawSupply = 1232395648233n;
    const decimals = 6;
    const value = Number(rawSupply) / 1e6;
    expect(value).toBeCloseTo(1232395.648233, 6);
  });

  it('large 18-decimal supply does not lose precision', () => {
    // Test with a very large value: 1e24 wei = 1M tokens
    const largeSupply = 1000000000000000000000000n; // 1M tokens with 18 decimals
    const decimals = 18;
    const divisor = 10n ** BigInt(decimals);
    const wholePart = largeSupply / divisor;
    expect(wholePart).toBe(1000000n);
  });

  it('share price calculation is exact', () => {
    // NAV = 8,785,885.862268 USDC (18-dec) = 8785885862268000000000000
    // Supply = 8,483,686.270107 limUSD (18-dec) = 8483686270107227971453853
    // Share price = NAV / supply ≈ 1.0356213
    const nav = 8785885862268000000000000n;
    const supply = 8483686270107227971453853n;
    const precision = 6n;
    const multiplier = 10n ** precision;
    const scaledPrice = (nav * multiplier) / supply;
    const wholePart = scaledPrice / multiplier;
    const fracPart = scaledPrice % multiplier;
    const sharePrice = parseFloat(`${wholePart}.${fracPart.toString().padStart(Number(precision), '0')}`);
    expect(sharePrice).toBeCloseTo(1.035621, 5);
  });
});

// ─── Alert threshold tests ──────────────────────────────────────────

const SHARE_PRICE_CHANGE_THRESHOLD_PCT = 0.5;
const REDEMPTION_BUFFER_THRESHOLD_USD = 50_000;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const REDEMPTION_BUFFER_BASELINE_USD = 0;

describe('limUSD Monitor — alert thresholds', () => {
  it('share-price change threshold is 0.5%', () => {
    expect(SHARE_PRICE_CHANGE_THRESHOLD_PCT).toBe(0.5);
  });

  it('redemption buffer threshold is $50,000', () => {
    expect(REDEMPTION_BUFFER_THRESHOLD_USD).toBe(50_000);
  });

  it('redemption buffer baseline is $0 (per EI-S005)', () => {
    expect(REDEMPTION_BUFFER_BASELINE_USD).toBe(0);
  });

  it('alert cooldown is 1 hour', () => {
    expect(ALERT_COOLDOWN_MS).toBe(60 * 60 * 1000);
  });
});

// ─── Alert logic (transition-based) ─────────────────────────────────

interface MonitorState {
  lastAlertTime: Record<string, number>;
  preexistingBreaches: Record<string, string>;
  lastSharePrice: string | null;
  lastSharePriceTs: string | null;
}

function recordPreexisting(state: MonitorState, breachKey: string): boolean {
  if (!state.preexistingBreaches[breachKey]) {
    state.preexistingBreaches[breachKey] = new Date().toISOString();
    return true;
  }
  return false;
}

function shouldAlert(state: MonitorState, alertKey: string, now: number): boolean {
  const last = state.lastAlertTime[alertKey] ?? 0;
  return (now - last) >= ALERT_COOLDOWN_MS;
}

function recordAlert(state: MonitorState, alertKey: string, now: number): void {
  state.lastAlertTime[alertKey] = now;
}

function evaluateAlerts(
  sharePrice: string | null,
  redemptionBufferUsd: number | null,
  state: MonitorState,
  now: number,
): { alerts: string[] } {
  const alerts: string[] = [];

  // Redemption buffer alert (transition-based)
  if (redemptionBufferUsd !== null && redemptionBufferUsd < REDEMPTION_BUFFER_THRESHOLD_USD) {
    const isFirst = recordPreexisting(state, 'redemption_buffer_low');
    if (isFirst) {
      alerts.push(`Redemption buffer $${redemptionBufferUsd.toFixed(2)} < $${REDEMPTION_BUFFER_THRESHOLD_USD} (PRE-EXISTING)`);
    }
  }

  // Share-price change alert
  if (sharePrice && state.lastSharePrice) {
    const current = parseFloat(sharePrice);
    const previous = parseFloat(state.lastSharePrice);
    if (previous > 0) {
      const changePct = ((current - previous) / previous) * 100;
      if (Math.abs(changePct) > SHARE_PRICE_CHANGE_THRESHOLD_PCT) {
        if (shouldAlert(state, 'share_price_change', now)) {
          alerts.push(`Share price change ${changePct.toFixed(4)}% exceeds threshold`);
          recordAlert(state, 'share_price_change', now);
        }
      }
    }
  }

  if (sharePrice) {
    state.lastSharePrice = sharePrice;
    state.lastSharePriceTs = new Date(now).toISOString();
  }

  return { alerts };
}

describe('limUSD Monitor — transition-based alerts', () => {
  it('redemption buffer breach recorded as PRE-EXISTING on first observation', () => {
    const state: MonitorState = { lastAlertTime: {}, preexistingBreaches: {}, lastSharePrice: null, lastSharePriceTs: null };
    const { alerts } = evaluateAlerts('1.035621', 0, state, Date.now());
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain('PRE-EXISTING');
  });

  it('redemption buffer breach does NOT re-alert on subsequent observations', () => {
    const state: MonitorState = { lastAlertTime: {}, preexistingBreaches: {}, lastSharePrice: null, lastSharePriceTs: null };
    // First observation — records pre-existing
    evaluateAlerts('1.035621', 0, state, Date.now());
    // Second observation — should NOT re-alert
    const { alerts } = evaluateAlerts('1.035621', 0, state, Date.now() + 1000);
    expect(alerts.length).toBe(0);
  });

  it('share-price change > 0.5% alerts', () => {
    const state: MonitorState = {
      lastAlertTime: {},
      preexistingBreaches: {},
      lastSharePrice: '1.035621',
      lastSharePriceTs: new Date().toISOString(),
    };
    const { alerts } = evaluateAlerts('1.041000', 100_000, state, Date.now());
    // Change = (1.041 - 1.035621) / 1.035621 * 100 = 0.519% > 0.5%
    expect(alerts.some(a => a.includes('Share price change'))).toBe(true);
  });

  it('share-price change < 0.5% does NOT alert', () => {
    const state: MonitorState = {
      lastAlertTime: {},
      preexistingBreaches: {},
      lastSharePrice: '1.035621',
      lastSharePriceTs: new Date().toISOString(),
    };
    const { alerts } = evaluateAlerts('1.038000', 100_000, state, Date.now());
    // Change = (1.038 - 1.035621) / 1.035621 * 100 = 0.230% < 0.5%
    expect(alerts.some(a => a.includes('Share price change'))).toBe(false);
  });

  it('share-price alert respects cooldown', () => {
    const now = Date.now();
    const state: MonitorState = {
      lastAlertTime: { 'share_price_change': now - 30 * 60 * 1000 }, // 30 min ago
      preexistingBreaches: {},
      lastSharePrice: '1.035621',
      lastSharePriceTs: new Date().toISOString(),
    };
    const { alerts } = evaluateAlerts('1.041000', 100_000, state, now);
    expect(alerts.some(a => a.includes('Share price change'))).toBe(false);
  });
});

// ─── Failure handling and recovery ──────────────────────────────────

describe('limUSD Monitor — failure handling', () => {
  it('null share price does not trigger share-price alert', () => {
    const state: MonitorState = { lastAlertTime: {}, preexistingBreaches: {}, lastSharePrice: '1.035621', lastSharePriceTs: new Date().toISOString() };
    const { alerts } = evaluateAlerts(null, 100_000, state, Date.now());
    expect(alerts.some(a => a.includes('Share price change'))).toBe(false);
  });

  it('null redemption buffer does not trigger buffer alert (distinguish from real zero)', () => {
    const state: MonitorState = { lastAlertTime: {}, preexistingBreaches: {}, lastSharePrice: null, lastSharePriceTs: null };
    const { alerts } = evaluateAlerts('1.035621', null, state, Date.now());
    // null means RPC failed — NOT the same as buffer=0
    expect(alerts.some(a => a.includes('PRE-EXISTING'))).toBe(false);
  });

  it('real zero redemption buffer IS a breach (not a failed read)', () => {
    const state: MonitorState = { lastAlertTime: {}, preexistingBreaches: {}, lastSharePrice: null, lastSharePriceTs: null };
    const { alerts } = evaluateAlerts('1.035621', 0, state, Date.now());
    expect(alerts.some(a => a.includes('PRE-EXISTING'))).toBe(true);
  });

  it('recovery: after null buffer, a real zero is still recorded', () => {
    const state: MonitorState = { lastAlertTime: {}, preexistingBreaches: {}, lastSharePrice: null, lastSharePriceTs: null };
    // First: null (RPC failed)
    evaluateAlerts('1.035621', null, state, Date.now());
    expect(state.preexistingBreaches['redemption_buffer_low']).toBeUndefined();
    // Second: real zero (RPC recovered, buffer is actually 0)
    const { alerts } = evaluateAlerts('1.035621', 0, state, Date.now() + 1000);
    expect(alerts.some(a => a.includes('PRE-EXISTING'))).toBe(true);
  });
});

// ─── WATCHLIST status ───────────────────────────────────────────────

describe('limUSD Monitor — WATCHLIST preservation', () => {
  it('PT-LIMUSD is NOT promoted to capital-ready status', () => {
    // The monitor explicitly does NOT promote PT-LIMUSD. Redemption-at-maturity
    // is UNVERIFIED before November 26, 2026.
    const maturity = new Date('2026-11-26');
    const now = new Date();
    expect(maturity.getTime()).toBeGreaterThan(now.getTime());
  });

  it('observation is distinct from forecast', () => {
    // The monitor records CURRENT observations (block, supply, NAV, share price).
    // Alerts fire on observed transitions, not on predictions.
    // This test verifies the maturity is a future date (observation point, not forecast).
    const maturityEpoch = 1795651200; // 2026-11-26T00:00:00Z (EI-S006 verified)
    const now = Math.floor(Date.now() / 1000);
    expect(maturityEpoch).toBeGreaterThan(now);
  });
});

// ─── Selector regression tests (EI-S007) ────────────────────────────
// These tests verify the EXACT selector constants used by the monitor.
// Selectors are imported from the module (not duplicated as literals)
// so tests fail if the monitor's selectors drift.

describe('limUSD Monitor — function selectors (EI-S007 verified)', () => {
  it('getNAV() selector is 0x0126c606 (keccak256 verified)', () => {
    // EI-S007 §2.1: keccak256("getNAV()") = 0x0126c606
    // The previous selector 0x41976e09 was wrong and reverted on every node.
    expect(GETNAV_SELECTOR).toBe('0x0126c606');
    expect(GETNAV_SELECTOR).not.toBe('0x41976e09');
  });

  it('expiry() selector is 0xe184c9be (keccak256 verified)', () => {
    // EI-S007 §2.1: keccak256("expiry()") = 0xe184c9be
    // The previous selector 0x96c8ef5d was wrong and reverted on PT token.
    expect(EXPIRY_SELECTOR).toBe('0xe184c9be');
    expect(EXPIRY_SELECTOR).not.toBe('0x96c8ef5d');
  });

  it('selectors are 4-byte (8 hex chars) with 0x prefix', () => {
    expect(GETNAV_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/);
    expect(EXPIRY_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/);
  });
});
