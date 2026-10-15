/**
 * limusd-alert-semantics.test.ts
 * ─────────────────────────────────────────────────────────────────────
 * Tests for the EI-S008 alert semantics corrections:
 *   A. Redemption-buffer true transition handling (OK↔BREACH)
 *   B. Share-price daily decline (time-aware)
 *   C. 2% baseline veto
 *
 * These tests exercise the REAL exported helpers from the production
 * module — not a copied implementation.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateBufferTransition,
  evaluateSharePriceDecline,
  evaluateBaselineVeto,
  SHARE_PRICE_CHANGE_THRESHOLD_PCT,
  SHARE_PRICE_VETO_THRESHOLD_PCT,
  REDEMPTION_BUFFER_THRESHOLD_USD,
} from '../src/runners/limusd-monitor.js';
import type { MonitorState } from '../src/runners/limusd-monitor.js';

// Helper to create a default state
function makeState(overrides: Partial<MonitorState> = {}): MonitorState {
  return {
    lastAlertTime: {},
    bufferBreachActive: false,
    sharePriceBaseline: null,
    sharePriceBaselineTs: null,
    lastSharePrice: null,
    lastSharePriceTs: null,
    preexistingBreaches: {},
    ...overrides,
  };
}

// ─── A. Redemption-buffer transition handling ───────────────────────

describe('evaluateBufferTransition — true OK↔BREACH transitions', () => {
  it('OK → BREACH: alerts on first breach', () => {
    const state = makeState({ bufferBreachActive: false });
    const result = evaluateBufferTransition(0, state); // $0 < $50k = breach
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain('OK→BREACH');
    expect(result.transition).toBe('OK_TO_BREACH');
  });

  it('BREACH → BREACH: no spam on continued breach', () => {
    const state = makeState({ bufferBreachActive: true });
    const result = evaluateBufferTransition(0, state);
    expect(result.alerts.length).toBe(0);
    expect(result.transition).toBe('STILL_BREACH');
  });

  it('BREACH → OK: alerts on recovery', () => {
    const state = makeState({ bufferBreachActive: true });
    const result = evaluateBufferTransition(100_000, state); // $100k > $50k = OK
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain('BREACH→OK');
    expect(result.transition).toBe('BREACH_TO_OK');
  });

  it('OK → BREACH again after recovery: alerts (no silent re-breach)', () => {
    // This is the key fix — the old preexistingBreaches logic would NOT
    // alert on re-breach after recovery. The new transition logic does.
    const state = makeState({ bufferBreachActive: false }); // recovered
    const result = evaluateBufferTransition(0, state); // breach again
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain('OK→BREACH');
    expect(result.transition).toBe('OK_TO_BREACH');
  });

  it('OK → OK: no alert', () => {
    const state = makeState({ bufferBreachActive: false });
    const result = evaluateBufferTransition(100_000, state);
    expect(result.alerts.length).toBe(0);
    expect(result.transition).toBe('NO_CHANGE');
  });

  it('null buffer (RPC failure): no alert, null transition', () => {
    const state = makeState({ bufferBreachActive: false });
    const result = evaluateBufferTransition(null, state);
    expect(result.alerts.length).toBe(0);
    expect(result.transition).toBe(null);
  });

  it('boundary: exactly $50,000 is NOT a breach (>= threshold)', () => {
    const state = makeState({ bufferBreachActive: false });
    const result = evaluateBufferTransition(50_000, state);
    expect(result.transition).toBe('NO_CHANGE');
  });
});

// ─── B. Share-price daily decline (time-aware) ──────────────────────

describe('evaluateSharePriceDecline — time-aware daily rate', () => {
  it('large decline over short time: alerts (daily rate exceeds threshold)', () => {
    // 0.1% decline over 10 minutes = 14.4%/day — exceeds 0.5%/day
    const result = evaluateSharePriceDecline(
      '1.034500', '1.035621',
      '2026-10-15T10:10:00Z', '2026-10-15T10:00:00Z',
    );
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain('daily decline');
    expect(result.dailyDeclinePct).not.toBeNull();
    expect(Math.abs(result.dailyDeclinePct!)).toBeGreaterThan(0.5);
  });

  it('small decline over long time: does NOT alert (daily rate below threshold)', () => {
    // 0.1% decline over 1 day = 0.1%/day — below 0.5%/day
    const result = evaluateSharePriceDecline(
      '1.034600', '1.035621',
      '2026-10-16T10:00:00Z', '2026-10-15T10:00:00Z',
    );
    expect(result.alerts.length).toBe(0);
    expect(Math.abs(result.dailyDeclinePct!)).toBeLessThan(0.5);
  });

  it('cumulative decline below per-sample threshold but above daily threshold: alerts', () => {
    // 0.3% decline over 10 minutes = 43.2%/day — exceeds 0.5%/day
    // But 0.3% < 0.5% per-sample threshold — the old code would miss this
    const result = evaluateSharePriceDecline(
      '1.032500', '1.035621',
      '2026-10-15T10:10:00Z', '2026-10-15T10:00:00Z',
    );
    expect(result.alerts.length).toBe(1);
  });

  it('no previous price: no alert', () => {
    const result = evaluateSharePriceDecline(
      '1.035621', null,
      '2026-10-15T10:00:00Z', null,
    );
    expect(result.alerts.length).toBe(0);
    expect(result.dailyDeclinePct).toBeNull();
  });

  it('zero elapsed time: no alert (invalid)', () => {
    const result = evaluateSharePriceDecline(
      '1.035621', '1.035621',
      '2026-10-15T10:00:00Z', '2026-10-15T10:00:00Z',
    );
    expect(result.alerts.length).toBe(0);
    expect(result.dailyDeclinePct).toBeNull();
  });
});

// ─── C. 2% baseline veto ────────────────────────────────────────────

describe('evaluateBaselineVeto — 2% decline from baseline', () => {
  it('no veto when price is at baseline', () => {
    const result = evaluateBaselineVeto('1.035621', '1.035621');
    expect(result.vetoFlag).toBe(false);
    expect(result.alerts.length).toBe(0);
  });

  it('no veto when price is above baseline', () => {
    const result = evaluateBaselineVeto('1.040000', '1.035621');
    expect(result.vetoFlag).toBe(false);
  });

  it('no veto when decline is below 2%', () => {
    // 1% decline
    const result = evaluateBaselineVeto('1.025265', '1.035621');
    expect(result.vetoFlag).toBe(false);
    expect(result.alerts.length).toBe(0);
  });

  it('VETO when decline exceeds 2%', () => {
    // 2.5% decline: 1.035621 * (1 - 0.025) = 1.009730
    const result = evaluateBaselineVeto('1.009730', '1.035621');
    expect(result.vetoFlag).toBe(true);
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain('VETO');
    expect(result.declineFromBaselinePct).toBeGreaterThan(2.0);
  });

  it('VETO at exactly 2% boundary: decline > 2% triggers veto', () => {
    // 2.01% decline
    const declined = 1.035621 * (1 - 0.0201);
    const result = evaluateBaselineVeto(declined.toFixed(6), '1.035621');
    expect(result.vetoFlag).toBe(true);
  });

  it('recovery from veto: price returns to baseline range', () => {
    // Price was vetoed, now recovers
    const result = evaluateBaselineVeto('1.035000', '1.035621');
    expect(result.vetoFlag).toBe(false);
  });

  it('null current price: no veto', () => {
    const result = evaluateBaselineVeto(null, '1.035621');
    expect(result.vetoFlag).toBe(false);
  });

  it('null baseline: no veto (first observation)', () => {
    const result = evaluateBaselineVeto('1.035621', null);
    expect(result.vetoFlag).toBe(false);
  });
});

// ─── Threshold constants ────────────────────────────────────────────

describe('Alert threshold constants', () => {
  it('share-price daily decline threshold is 0.5%/day', () => {
    expect(SHARE_PRICE_CHANGE_THRESHOLD_PCT).toBe(0.5);
  });

  it('share-price veto threshold is 2.0%', () => {
    expect(SHARE_PRICE_VETO_THRESHOLD_PCT).toBe(2.0);
  });

  it('redemption buffer threshold is $50,000', () => {
    expect(REDEMPTION_BUFFER_THRESHOLD_USD).toBe(50_000);
  });
});
