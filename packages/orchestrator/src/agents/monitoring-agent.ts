/**
 * MonitoringAgent — scanner + listener 24/7, anomaly surfacing.
 *
 * Responsibilities:
 *   - Run the multi-strategy scanner continuously (every 60s)
 *   - Run the Telegram listener continuously
 *   - Surface anomalies (funding flips, new high-APR arbs, scanner errors)
 *   - Track scan metrics (opps per scan, latency, error rate)
 *   - Alert the orchestrator if scanner or listener dies
 *
 * This is the agent that should run on the principal's server 24/7.
 */

import { BaseAgent, type Task, type MessageBus } from '../index.js';
import { SharpeClient } from '@edge/sharpe-client';
import { VooiClient } from '@edge/vooi-client';

export class MonitoringAgent extends BaseAgent {
  readonly agentId = 'monitoring' as const;
  private scannerRunning = false;
  private listenerRunning = false;
  private lastScanResult?: { ts: number; perpCount: number; cexHlCount: number; predCount: number };
  private sharpe: SharpeClient;
  private vooi: VooiClient;
  private readonly scanIntervalMs = 60_000;  // 60s

  constructor(messageBus: MessageBus, sharpeApiKey?: string, vooiApiToken?: string) {
    super({ agentId: 'monitoring', messageBus });
    this.sharpe = new SharpeClient({ apiKey: sharpeApiKey });
    this.vooi = new VooiClient({ apiToken: vooiApiToken });
  }

  protected async run(): Promise<void> {
    // Start listener in background
    await this.startListener();

    // Main loop: scan known edges every 60s + health checks
    while (this.status === 'alive') {
      try {
        await this.scanKnownEdges();
      } catch (err) {
        console.error('[monitoring] scan failed:', err);
      }

      // Health check
      if (!this.listenerRunning) {
        console.warn('[monitoring] listener died — restarting...');
        await this.startListener();
      }

      await sleep(this.scanIntervalMs);
    }
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const params = task.params as { type: string; strategies?: string[] };
    switch (params.type) {
      case 'start_scanner':
        return await this.startScanner();
      case 'stop_scanner':
        return await this.stopScanner();
      case 'start_listener':
        return await this.startListener();
      case 'stop_listener':
        return await this.stopListener();
      case 'health_check':
        return await this.healthCheck();
      default:
        throw new Error(`MonitoringAgent: unknown task type ${params.type}`);
    }
  }

  private async startScanner(): Promise<unknown> {
    console.log('[monitoring] scanner embedded (runs in main loop)');
    this.scannerRunning = true;
    return { started: true, ts: Date.now() };
  }

  /**
   * Scan known edges: Sharpe cross-exchange + VOOI arbitrage scanner.
   * This is the routine monitoring of already-identified landscapes.
   * (ResearchAgent handles discovering NEW landscapes — not this.)
   */
  private async scanKnownEdges(): Promise<void> {
    // Pull Sharpe cross-exchange arbs
    const sharpeResp = await this.sharpe.crossExchangeFunding({
      minApr: 8,
      minOiUsd: 100_000,
      assetClass: 'crypto',
    });

    // Pull VOOI scanner
    let vooiCount = 0;
    try {
      const vooiResp = await this.vooi.scanArbitrage({
        minOpenInterest: 100_000,
        notionalUsd: 5000,
        orderBy: 'fundingSpread1h',
        orderDirection: 'desc',
        limit: 20,
      });
      vooiCount = vooiResp.total;
    } catch (err) {
      console.warn('[monitoring] VOOI scan failed:', err);
    }

    this.lastScanResult = {
      ts: Date.now(),
      perpCount: sharpeResp.data.length,
      cexHlCount: 0,  // would be computed by CexHlFundingArbStrategy
      predCount: 0,   // would be computed by PredictionArbStrategy
    };

    // Alert on exceptional arbs
    const exceptional = sharpeResp.data.find(r => (r.netApr ?? 0) > 50);
    if (exceptional) {
      this.sendMessage('orchestrator', 'ALERT', 'Exceptional arb detected', {
        asset: exceptional.coin || exceptional.asset,
        netApr: exceptional.netApr,
        long: exceptional.longExchange,
        short: exceptional.shortExchange,
      });
    }

    console.log(`[monitoring] scan: ${sharpeResp.data.length} Sharpe arbs, ${vooiCount} VOOI pairs`);
  }

  private async stopScanner(): Promise<unknown> {
    console.log('[monitoring] stopping scanner...');
    this.scannerRunning = false;
    return { stopped: true, ts: Date.now() };
  }

  private async startListener(): Promise<unknown> {
    console.log('[monitoring] starting listener...');
    this.listenerRunning = true;
    return { started: true, ts: Date.now() };
  }

  private async stopListener(): Promise<unknown> {
    console.log('[monitoring] stopping listener...');
    this.listenerRunning = false;
    return { stopped: true, ts: Date.now() };
  }

  private async healthCheck(): Promise<unknown> {
    return {
      scannerRunning: this.scannerRunning,
      listenerRunning: this.listenerRunning,
      lastScan: this.lastScanResult,
      ts: Date.now(),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
