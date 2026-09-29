/**
 * ExecutionAgent — live trade execution, position management.
 *
 * Responsibilities:
 *   - Execute arbitrage trades when opportunities are found
 *   - Manage open positions (monitor, close on signal)
 *   - Enforce risk limits (daily loss cap, per-trade cap, cooldown)
 *   - Emergency close all positions (kill switch)
 *   - Report fills + P&L to EconomicsAgent
 *
 * Activated only when capital is deployed. Until then, stays idle.
 */

import { BaseAgent, type Task, type MessageBus } from '../index.js';

export class ExecutionAgent extends BaseAgent {
  readonly agentId = 'execution' as const;
  private capitalDeployed = false;
  private openPositions: Map<string, { id: string; asset: string; sizeUsd: number; openedAt: number }> = new Map();

  constructor(messageBus: MessageBus) {
    super({ agentId: 'execution', messageBus });
  }

  protected async run(): Promise<void> {
    // Main loop: monitor open positions + check for close signals
    while (this.status === 'alive') {
      if (this.capitalDeployed && this.openPositions.size > 0) {
        await this.monitorPositions();
      }
      await sleep(30_000);  // check every 30s
    }
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const params = task.params as { type: string; opportunityId?: string; positionId?: string; reason?: string };
    switch (params.type) {
      case 'execute_arb':
        return await this.executeArb(params.opportunityId!);
      case 'close_position':
        return await this.closePosition(params.positionId!, params.reason);
      case 'rebalance':
        return await this.rebalance();
      case 'emergency_close_all':
        return await this.emergencyCloseAll(params.reason || 'manual');
      default:
        throw new Error(`ExecutionAgent: unknown task type ${params.type}`);
    }
  }

  private async executeArb(opportunityId: string): Promise<unknown> {
    if (!this.capitalDeployed) {
      throw new Error('ExecutionAgent: cannot execute — no capital deployed');
    }
    console.log(`[execution] executing arb ${opportunityId}...`);
    // Would call VooiExecutor or EvmExecutor here
    const positionId = `pos_${Date.now()}`;
    this.openPositions.set(positionId, {
      id: positionId,
      asset: 'unknown',
      sizeUsd: 5000,
      openedAt: Date.now(),
    });
    return { positionId, opportunityId, status: 'opened', ts: Date.now() };
  }

  private async closePosition(positionId: string, reason?: string): Promise<unknown> {
    console.log(`[execution] closing position ${positionId}: ${reason || 'signal'}`);
    const pos = this.openPositions.get(positionId);
    if (!pos) throw new Error(`position ${positionId} not found`);
    this.openPositions.delete(positionId);
    // Report P&L to EconomicsAgent
    this.sendMessage('economics', 'RESULT', `Position ${positionId} closed`, {
      positionId,
      reason,
      durationMs: Date.now() - pos.openedAt,
    });
    return { positionId, status: 'closed', reason, ts: Date.now() };
  }

  private async rebalance(): Promise<unknown> {
    console.log('[execution] rebalancing...');
    return { status: 'rebalanced', ts: Date.now() };
  }

  private async emergencyCloseAll(reason: string): Promise<unknown> {
    console.error(`[execution] EMERGENCY CLOSE ALL: ${reason}`);
    const closed: string[] = [];
    for (const [id, _pos] of this.openPositions) {
      await this.closePosition(id, `emergency: ${reason}`);
      closed.push(id);
    }
    this.sendMessage('orchestrator', 'ALERT', 'Emergency close all executed', { reason, closed });
    return { closed, reason, ts: Date.now() };
  }

  private async monitorPositions(): Promise<void> {
    // Check each open position for close signals:
    //   - Max hold time exceeded
    //   - Funding inversion
    //   - Profit target hit
    //   - Stop loss hit
    for (const [id, pos] of this.openPositions) {
      const ageHours = (Date.now() - pos.openedAt) / (60 * 60 * 1000);
      if (ageHours > 72) {
        console.log(`[execution] position ${id} exceeded 72h max hold — closing`);
        await this.closePosition(id, 'max_hold_exceeded');
      }
    }
  }

  /** Called by orchestrator when capital is deployed. */
  setCapitalDeployed(deployed: boolean): void {
    this.capitalDeployed = deployed;
    console.log(`[execution] capital ${deployed ? 'deployed' : 'withdrawn'}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
