/**
 * EconomicsAgent — capital allocation, P&L tracking, rebalancing.
 *
 * Responsibilities:
 *   - Track capital allocation across landscapes
 *   - Monitor P&L (daily, weekly, monthly)
 *   - Recommend rebalancing when allocation drifts
 *   - Track yield-bearing stablecoin positions (sUSDe, sUSDAI, USD0)
 *   - Compute risk-adjusted returns per strategy
 *   - Alert when daily loss cap is approached
 */

import { BaseAgent, type Task, type MessageBus } from '../index.js';

export interface CapitalAllocation {
  landscape: string;
  allocatedUsd: number;
  deployedUsd: number;
  pnlRealizedUsd: number;
  pnlUnrealizedUsd: number;
  apy: number;
}

export class EconomicsAgent extends BaseAgent {
  readonly agentId = 'economics' as const;
  private allocations: Map<string, CapitalAllocation> = new Map();
  private dailyPnlUsd = 0;
  private dailyPnlResetTs = Date.now();

  constructor(messageBus: MessageBus) {
    super({ agentId: 'economics', messageBus });
  }

  protected async run(): Promise<void> {
    // Main loop: daily P&L reset + allocation drift check
    while (this.status === 'alive') {
      // Reset daily P&L every 24h
      if (Date.now() - this.dailyPnlResetTs > 24 * 60 * 60 * 1000) {
        this.dailyPnlUsd = 0;
        this.dailyPnlResetTs = Date.now();
        console.log('[economics] daily P&L reset');
      }

      // Check allocation drift every 5 min
      await this.checkAllocationDrift();
      await sleep(5 * 60_000);
    }
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const params = task.params as { type: string; amountUsd?: number; landscape?: string };
    switch (params.type) {
      case 'allocate_capital':
        return await this.allocateCapital(params.landscape!, params.amountUsd!);
      case 'rebalance':
        return await this.rebalance();
      case 'pnl_report':
        return await this.pnlReport();
      case 'risk_assessment':
        return await this.riskAssessment();
      default:
        throw new Error(`EconomicsAgent: unknown task type ${params.type}`);
    }
  }

  private async allocateCapital(landscape: string, amountUsd: number): Promise<unknown> {
    console.log(`[economics] allocating $${amountUsd} to ${landscape}`);
    const existing = this.allocations.get(landscape);
    this.allocations.set(landscape, {
      landscape,
      allocatedUsd: (existing?.allocatedUsd ?? 0) + amountUsd,
      deployedUsd: existing?.deployedUsd ?? 0,
      pnlRealizedUsd: existing?.pnlRealizedUsd ?? 0,
      pnlUnrealizedUsd: existing?.pnlUnrealizedUsd ?? 0,
      apy: existing?.apy ?? 0,
    });
    return { landscape, allocatedUsd: amountUsd, ts: Date.now() };
  }

  private async rebalance(): Promise<unknown> {
    console.log('[economics] rebalancing capital...');
    const report = Array.from(this.allocations.values());
    return { report, ts: Date.now() };
  }

  private async pnlReport(): Promise<unknown> {
    const totalAllocated = Array.from(this.allocations.values()).reduce((s, a) => s + a.allocatedUsd, 0);
    const totalPnl = Array.from(this.allocations.values()).reduce((s, a) => s + a.pnlRealizedUsd + a.pnlUnrealizedUsd, 0);
    return {
      totalAllocated,
      totalPnl,
      dailyPnl: this.dailyPnlUsd,
      byLandscape: Array.from(this.allocations.values()),
      ts: Date.now(),
    };
  }

  private async riskAssessment(): Promise<unknown> {
    const dailyLossCap = 200;  // $200 = 2% of $10k
    const remainingRiskBudget = dailyLossCap - Math.abs(Math.min(this.dailyPnlUsd, 0));
    return {
      dailyPnl: this.dailyPnlUsd,
      dailyLossCap,
      remainingRiskBudget,
      riskUtilizationPct: (Math.abs(Math.min(this.dailyPnlUsd, 0)) / dailyLossCap) * 100,
      ts: Date.now(),
    };
  }

  private async checkAllocationDrift(): Promise<void> {
    // Check if any landscape's allocation has drifted >10% from target
    // If so, alert the orchestrator
    const totalAllocated = Array.from(this.allocations.values()).reduce((s, a) => s + a.allocatedUsd, 0);
    if (totalAllocated === 0) return;

    for (const [landscape, alloc] of this.allocations) {
      const actualPct = (alloc.allocatedUsd / totalAllocated) * 100;
      // Target allocations from Brief 03
      const targets: Record<string, number> = {
        'F_perps_funding': 40, 'A_dex_cex': 15, 'C_dex_dex': 10,
        'D_prediction': 20, 'E_sports': 10, 'G_mev': 5,
      };
      const targetPct = targets[landscape] ?? 0;
      if (Math.abs(actualPct - targetPct) > 10) {
        this.sendMessage('orchestrator', 'ALERT', `Allocation drift: ${landscape}`, {
          landscape, actualPct, targetPct, drift: actualPct - targetPct,
        });
      }
    }
  }

  /** Called by ExecutionAgent when a position closes with P&L. */
  recordPnl(amountUsd: number): void {
    this.dailyPnlUsd += amountUsd;
    if (this.dailyPnlUsd < -200) {
      this.sendMessage('orchestrator', 'ALERT', 'Daily loss cap approached', {
        dailyPnl: this.dailyPnlUsd, cap: -200,
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
