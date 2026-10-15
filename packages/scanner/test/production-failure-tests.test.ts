/**
 * production-failure-tests.test.ts
 * ─────────────────────────────────────────────────────────────────────
 * Tests that inject append failures through the PRODUCTION commit
 * functions (commitObservation / commitCadenceObservation), not a
 * test-only copy of the staging pattern.
 *
 * These tests verify:
 *   - Failed writes do not advance reward-step counter, last-recorded
 *     timestamp, share-price baseline, buffer-transition state, or
 *     alert cooldowns.
 *   - A subsequent successful write records the still-pending transition
 *     and advances state exactly once.
 */
import { describe, it, expect } from 'vitest';
import {
  commitObservation,
  type MonitorState,
  type Observation,
  type StagedState,
} from '../src/runners/limusd-monitor.js';
import {
  commitCadenceObservation,
  type CadenceState,
  type Observation as CadenceObservation,
  type StagedCadenceState,
} from '../src/runners/khype-cadence-sampler.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeLimusdState(overrides: Partial<MonitorState> = {}): MonitorState {
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

function makeLimusdObs(overrides: Partial<Observation> = {}): Observation {
  return {
    ts: '2026-10-15T07:00:00Z',
    blockNumber: 48587000,
    source: 'hyperevm-rpc',
    limUsdTotalSupplyRaw: '8542553991097660385206736',
    ptTotalSupplyRaw: '1232395648233',
    syTotalSupplyRaw: '1880624101810537190263376',
    limUsdTotalSupply: '8542553.991097',
    ptTotalSupply: '1232395.648233',
    syTotalSupply: '1880624.101811',
    navRaw: '8846850525638012173056602',
    navUsd: '8846850.525638',
    sharePrice: '1.035623',
    redemptionBufferRaw: '0',
    redemptionBufferUsd: 0,
    ptApy: 10.03,
    underlyingApy: 8.08,
    ptTvlUsd: 1311106,
    underlyingTvlUsd: 8517277,
    ptExpiry: 1795651200,
    ptMaturityDate: '2026-11-26',
    rpcSuccess: true,
    defillamaSuccess: true,
    readFailures: [],
    alerts: [],
    vetoFlag: false,
    dailyDeclinePct: null,
    bufferBreachActive: false,
    ...overrides,
  };
}

function makeCadenceState(overrides: Partial<CadenceState> = {}): CadenceState {
  return {
    lastTotalRewards: null,
    lastAnchor: null,
    lastTs: null,
    rewardStepCount: 0,
    lastObservationAppended: false,
    ...overrides,
  };
}

function makeCadenceObs(overrides: Partial<CadenceObservation> = {}): CadenceObservation {
  return {
    ts: '2026-10-15T07:00:00Z',
    blockNumber: 48587000,
    source: 'hyperevm-rpc',
    totalRewardsRaw: '571007910687725000001187',
    khypeToHypeRaw: '1026506759389196609',
    totalStakedRaw: '52242991399477590000000000',
    khypeTotalSupplyRaw: '10087273326510696181740061',
    totalRewards: '571007.910688',
    anchorExchangeRate: '1.026507',
    totalStaked: '52242991.399478',
    khypeTotalSupply: '10087273.326511',
    totalRewardsDelta: null,
    anchorDelta: null,
    rewardStepDetected: false,
    negativeDeltaAnomaly: false,
    secsSincePrevSample: null,
    rpcSuccess: true,
    readFailures: [],
    ...overrides,
  };
}

// ─── LIMUSD production failure tests ────────────────────────────────

describe('commitObservation — production append-failure injection', () => {
  it('append failure: no state mutation at all', () => {
    const state = makeLimusdState({
      bufferBreachActive: false,
      sharePriceBaseline: '1.035000',
      lastSharePrice: '1.035000',
      lastSharePriceTs: '2026-10-15T06:00:00Z',
    });
    const obs = makeLimusdObs({
      alerts: ['Redemption buffer $0.00 < $50000 threshold (OK→BREACH)'],
      bufferBreachActive: true,
    });
    const staged: StagedState = {
      bufferBreachActive: true,
      sharePriceBaseline: '1.035000',
      sharePriceBaselineTs: '2026-10-15T06:00:00Z',
      lastSharePrice: '1.035623',
      lastSharePriceTs: '2026-10-15T07:00:00Z',
      cooldowns: { 'share_price_decline': Date.now() },
    };

    // Inject a failing append
    const failingAppend = () => { throw new Error('EIO'); };
    const result = commitObservation(state, obs, staged, failingAppend as any, () => {});

    expect(result).toBe(false);
    // Verify NO state was mutated
    expect(state.bufferBreachActive).toBe(false);  // not advanced to true
    expect(state.sharePriceBaseline).toBe('1.035000');  // unchanged
    expect(state.lastSharePrice).toBe('1.035000');  // not advanced
    expect(state.lastSharePriceTs).toBe('2026-10-15T06:00:00Z');  // not advanced
    expect(Object.keys(state.lastAlertTime).length).toBe(0);  // no cooldowns persisted
  });

  it('append success: all staged state committed', () => {
    const state = makeLimusdState({
      bufferBreachActive: false,
      sharePriceBaseline: null,
      lastSharePrice: null,
    });
    const obs = makeLimusdObs();
    const staged: StagedState = {
      bufferBreachActive: true,
      sharePriceBaseline: '1.035623',
      sharePriceBaselineTs: '2026-10-15T07:00:00Z',
      lastSharePrice: '1.035623',
      lastSharePriceTs: '2026-10-15T07:00:00Z',
      cooldowns: { 'baseline_veto': 1234567890 },
    };

    let appendedObs: Observation | null = null;
    const successAppend = (o: Observation) => { appendedObs = o; };
    let savedState: MonitorState | null = null;
    const result = commitObservation(state, obs, staged, successAppend, (s) => { savedState = s; });

    expect(result).toBe(true);
    expect(appendedObs).not.toBeNull();
    expect(state.bufferBreachActive).toBe(true);
    expect(state.sharePriceBaseline).toBe('1.035623');
    expect(state.lastSharePrice).toBe('1.035623');
    expect(state.lastAlertTime['baseline_veto']).toBe(1234567890);
    expect(savedState).not.toBeNull();
  });

  it('failed then successful: pending transition advances exactly once', () => {
    const state = makeLimusdState({ bufferBreachActive: false });
    const obs = makeLimusdObs({ bufferBreachActive: true });
    const staged: StagedState = {
      bufferBreachActive: true,
      sharePriceBaseline: null,
      sharePriceBaselineTs: null,
      lastSharePrice: '1.035623',
      lastSharePriceTs: '2026-10-15T07:00:00Z',
      cooldowns: {},
    };

    // First attempt: append fails
    const failAppend = () => { throw new Error('disk full'); };
    const r1 = commitObservation(state, obs, staged, failAppend as any, () => {});
    expect(r1).toBe(false);
    expect(state.bufferBreachActive).toBe(false);  // still not advanced

    // Second attempt: append succeeds — transition advances NOW
    const successAppend = () => {};
    const r2 = commitObservation(state, obs, staged, successAppend, () => {});
    expect(r2).toBe(true);
    expect(state.bufferBreachActive).toBe(true);  // advanced exactly once
  });
});

// ─── kHYPE cadence production failure tests ─────────────────────────

describe('commitCadenceObservation — production append-failure injection', () => {
  it('append failure: rewardStepCount not advanced', () => {
    const state = makeCadenceState({
      lastTotalRewards: '571007910687725000001187',
      lastAnchor: '1026506759389196609',
      lastTs: '2026-10-15T06:30:00Z',
      rewardStepCount: 0,
    });
    const obs = makeCadenceObs({
      rewardStepDetected: true,
      totalRewardsDelta: '541513277379000000000',  // positive delta
    });
    const staged: StagedCadenceState = {
      lastTotalRewards: '571007910687725000001187',
      lastAnchor: '1026506759389196609',
      lastTs: '2026-10-15T07:00:00Z',
      rewardStep: true,
    };

    const failAppend = () => { throw new Error('EIO'); };
    const result = commitCadenceObservation(state, obs, staged, failAppend as any, () => {});

    expect(result).toBe(false);
    expect(state.rewardStepCount).toBe(0);  // NOT advanced
    expect(state.lastTs).toBe('2026-10-15T06:30:00Z');  // NOT advanced
    expect(state.lastTotalRewards).toBe('571007910687725000001187');  // unchanged
  });

  it('append success with reward step: counter advances exactly once', () => {
    const state = makeCadenceState({
      lastTotalRewards: '571007910687725000001187',
      lastTs: '2026-10-15T06:30:00Z',
      rewardStepCount: 0,
    });
    const obs = makeCadenceObs({ rewardStepDetected: true });
    const staged: StagedCadenceState = {
      lastTotalRewards: '571549423965112000001187',
      lastAnchor: '1026506759389196609',
      lastTs: '2026-10-15T07:00:00Z',
      rewardStep: true,
    };

    const successAppend = () => {};
    const result = commitCadenceObservation(state, obs, staged, successAppend, () => {});

    expect(result).toBe(true);
    expect(state.rewardStepCount).toBe(1);  // advanced exactly once
    expect(state.lastTs).toBe('2026-10-15T07:00:00Z');
    expect(state.lastTotalRewards).toBe('571549423965112000001187');
  });

  it('failed then successful: reward step advances exactly once', () => {
    const state = makeCadenceState({
      lastTotalRewards: '571007910687725000001187',
      lastTs: '2026-10-15T06:30:00Z',
      rewardStepCount: 0,
    });
    const obs = makeCadenceObs({ rewardStepDetected: true });
    const staged: StagedCadenceState = {
      lastTotalRewards: '571549423965112000001187',
      lastAnchor: '1026506759389196609',
      lastTs: '2026-10-15T07:00:00Z',
      rewardStep: true,
    };

    // First: append fails
    const failAppend = () => { throw new Error('disk full'); };
    const r1 = commitCadenceObservation(state, obs, staged, failAppend as any, () => {});
    expect(r1).toBe(false);
    expect(state.rewardStepCount).toBe(0);

    // Second: append succeeds — step advances NOW
    const successAppend = () => {};
    const r2 = commitCadenceObservation(state, obs, staged, successAppend, () => {});
    expect(r2).toBe(true);
    expect(state.rewardStepCount).toBe(1);  // exactly once
  });

  it('append failure with no reward step: nothing changes', () => {
    const state = makeCadenceState({
      lastTotalRewards: '571007910687725000001187',
      lastTs: '2026-10-15T06:30:00Z',
      rewardStepCount: 2,
    });
    const obs = makeCadenceObs({ rewardStepDetected: false });
    const staged: StagedCadenceState = {
      lastTotalRewards: '571007910687725000001187',
      lastAnchor: '1026506759389196609',
      lastTs: '2026-10-15T07:00:00Z',
      rewardStep: false,
    };

    const failAppend = () => { throw new Error('EIO'); };
    const result = commitCadenceObservation(state, obs, staged, failAppend as any, () => {});

    expect(result).toBe(false);
    expect(state.rewardStepCount).toBe(2);  // unchanged
    expect(state.lastTs).toBe('2026-10-15T06:30:00Z');  // unchanged
  });

  it('append failure: saveStateFn is NOT called (no persisted state change)', () => {
    const state = makeCadenceState({
      lastTotalRewards: '571007910687725000001187',
      lastTs: '2026-10-15T06:30:00Z',
      rewardStepCount: 1,
      lastObservationAppended: true,  // was true before this failed attempt
    });
    const obs = makeCadenceObs({ rewardStepDetected: true });
    const staged: StagedCadenceState = {
      lastTotalRewards: '571549423965112000001187',
      lastAnchor: '1026506759389196609',
      lastTs: '2026-10-15T07:00:00Z',
      rewardStep: true,
    };

    let saveCallCount = 0;
    const failAppend = () => { throw new Error('EIO'); };
    const result = commitCadenceObservation(state, obs, staged, failAppend as any, () => { saveCallCount++; });

    expect(result).toBe(false);
    expect(saveCallCount).toBe(0);  // saveStateFn was NOT called
    expect(state.lastObservationAppended).toBe(false);  // in-memory only
    expect(state.rewardStepCount).toBe(1);  // unchanged
    // On restart, state file would still have lastObservationAppended=true
    // from the previous successful write — the in-memory false is ephemeral
  });

  it('append failure: LIMUSD saveStateFn is NOT called either', () => {
    const state = makeLimusdState({
      bufferBreachActive: false,
      sharePriceBaseline: '1.035000',
    });
    const obs = makeLimusdObs();
    const staged: StagedState = {
      bufferBreachActive: true,
      sharePriceBaseline: '1.035623',
      sharePriceBaselineTs: '2026-10-15T07:00:00Z',
      lastSharePrice: '1.035623',
      lastSharePriceTs: '2026-10-15T07:00:00Z',
      cooldowns: {},
    };

    let saveCallCount = 0;
    const failAppend = () => { throw new Error('EIO'); };
    const result = commitObservation(state, obs, staged, failAppend as any, () => { saveCallCount++; });

    expect(result).toBe(false);
    expect(saveCallCount).toBe(0);  // saveStateFn NOT called on failure
    expect(state.bufferBreachActive).toBe(false);  // unchanged
    expect(state.sharePriceBaseline).toBe('1.035000');  // unchanged
  });
});
