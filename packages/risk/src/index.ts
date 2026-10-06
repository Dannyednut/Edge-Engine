/**
 * @edge/risk — Risk guard.  Called before every execution; rejects violations.
 * Also handles kill-switch webhooks and cooldown management.
 */

import type { RiskEnvelope, SizedLeg } from '@edge/types';
import type { PnlDb } from '@edge/pnl';
import type { TelegramAlerter } from '@edge/alerts';

export class RiskGuardViolation extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RiskGuardViolation';
  }
}

export interface RiskGuardOptions {
  pnl: PnlDb;
  envelope: RiskEnvelope;
  alerter?: TelegramAlerter;
}

export class RiskGuard {
  constructor(private opts: RiskGuardOptions) {}

  /** Pre-execution check.  Throws RiskGuardViolation if blocked. */
  async preExec(params: {
    strategyId: string;
    opportunityId: string;
    sizedLegs: SizedLeg[];
    gasPriceMedian: number;
    gasPriceUsed: number;
  }): Promise<void> {
    const e = this.opts.envelope;

    // 1. Kill switch
    if (this.opts.pnl.isKillSwitchActive()) {
      const reason = this.opts.pnl.getKillSwitchReason() ?? 'unknown';
      throw new RiskGuardViolation('kill_switch_active',
        `Kill switch active: ${reason}`);
    }

    // 2. Daily loss cap
    if (this.opts.pnl.isDailyLossCapHit()) {
      await this.notifyCritical('KILL: daily loss cap hit',
        `Daily loss $${this.opts.pnl.getDailyLossAbs().toFixed(2)} ≥ cap $${e.maxDailyLossUsd}`);
      throw new RiskGuardViolation('daily_loss_cap',
        `Daily loss cap hit: $${this.opts.pnl.getDailyLossAbs().toFixed(2)}`);
    }

    // 3. Concurrent position cap
    const openCount = this.opts.pnl.countOpenPositions();
    if (openCount >= e.maxConcurrentArbs) {
      throw new RiskGuardViolation('max_concurrent',
        `Max concurrent arbs (${e.maxConcurrentArbs}) reached; currently open: ${openCount}`);
    }

    // 4. Per-trade size cap
    for (const leg of params.sizedLegs) {
      if (leg.sizeUsd > e.maxPerTradeLossUsd * 4) {
        // Per-trade cap is on max LOSS, but for hedged/delta-neutral arbs,
        // max loss ≈ leg size × slippage (≈ 1%).  Cap notional at 4× max loss.
        throw new RiskGuardViolation('per_trade_cap',
          `Leg size $${leg.sizeUsd.toFixed(2)} exceeds 4× max per-trade loss $${e.maxPerTradeLossUsd}`);
      }
    }

    // 5. Gas price cap
    if (params.gasPriceUsed > e.gasPriceCapMultiplier * params.gasPriceMedian) {
      throw new RiskGuardViolation('gas_price_cap',
        `Gas price ${params.gasPriceUsed} > ${e.gasPriceCapMultiplier}× median ${params.gasPriceMedian}`);
    }

    // 6. Cooldown
    if (this.opts.pnl.isCooldownActive()) {
      const remaining = Math.ceil((this.opts.pnl.getCooldownUntil() - Date.now()) / 1000);
      throw new RiskGuardViolation('cooldown_active',
        `Cooldown active; ${remaining}s remaining`);
    }
  }

  /** Called after any reverted arb. */
  async onRevert(params: {
    strategyId: string;
    opportunityId: string;
    gasLostUsd: number;
    reason: string;
  }): Promise<void> {
    this.opts.pnl.startCooldown(this.opts.envelope.cooldownAfterLossMs);
    this.opts.pnl.record({
      id: `revert_${params.opportunityId}_${Date.now()}`,
      ts: Date.now(),
      strategyId: params.strategyId,
      opportunityId: params.opportunityId,
      legs: [],
      realizedUsd: -params.gasLostUsd,
      gasUsd: params.gasLostUsd,
      feesUsd: 0,
      status: 'reverted',
      notes: params.reason,
    });
    await this.notifyCritical('Reverted arb',
      `Strategy: ${params.strategyId}\nGas lost: $${params.gasLostUsd.toFixed(2)}\nReason: ${params.reason}\nCooldown: ${this.opts.envelope.cooldownAfterLossMs / 1000}s`);
  }

  /** Called after a successful fill. */
  onFill(params: {
    strategyId: string;
    opportunityId: string;
    legs: SizedLeg[];
    realizedUsd: number;
    gasUsd: number;
    feesUsd: number;
    txHashes?: string[];
  }): void {
    this.opts.pnl.record({
      id: `fill_${params.opportunityId}_${Date.now()}`,
      ts: Date.now(),
      strategyId: params.strategyId,
      opportunityId: params.opportunityId,
      legs: params.legs,
      realizedUsd: params.realizedUsd,
      gasUsd: params.gasUsd,
      feesUsd: params.feesUsd,
      status: 'filled',
      txHashes: params.txHashes,
    });
  }

  /** Activate kill switch from external trigger (Telegram /pause). */
  async activateKillSwitch(reason: string): Promise<void> {
    this.opts.pnl.activateKillSwitch(reason);
    await this.opts.alerter?.killSwitch(reason);
  }

  /** Deactivate kill switch (Telegram /resume). */
  async deactivateKillSwitch(): Promise<void> {
    this.opts.pnl.deactivateKillSwitch();
    await this.opts.alerter?.info('Kill switch deactivated',
      'Risk guard resumed. Bot will resume scanning.');
  }

  private async notifyCritical(title: string, body: string): Promise<void> {
    if (this.opts.alerter) {
      try {
        await this.opts.alerter.sendAlert({
          id: `crit_${Date.now()}`,
          ts: Date.now(),
          severity: 'critical',
          title, body,
          channels: ['telegram'],
        });
      } catch (err) {
        console.error('RiskGuard: failed to send critical alert:', err);
      }
    }
  }
}
