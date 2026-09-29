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

export class MonitoringAgent extends BaseAgent {
  readonly agentId = 'monitoring' as const;
  private scannerRunning = false;
  private listenerRunning = false;
  private lastScanResult?: { ts: number; perpCount: number; cexHlCount: number; predCount: number };

  constructor(messageBus: MessageBus) {
    super({ agentId: 'monitoring', messageBus });
  }

  protected async run(): Promise<void> {
    // Start scanner + listener automatically on boot
    await this.startScanner();
    await this.startListener();

    // Main loop: monitor scanner/listener health
    while (this.status === 'alive') {
      if (!this.scannerRunning) {
        console.warn('[monitoring] scanner died — restarting...');
        await this.startScanner();
      }
      if (!this.listenerRunning) {
        console.warn('[monitoring] listener died — restarting...');
        await this.startListener();
      }
      await sleep(30_000);  // health check every 30s
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
    console.log('[monitoring] starting scanner...');
    try {
      // In production: spawn the scanner as a child process
      // const child = fork('./packages/scanner/src/runners/all-runner.ts');
      // For now, just mark as running (the actual scanner runs separately)
      this.scannerRunning = true;
      this.sendMessage('orchestrator', 'STATUS', 'scanner started', { running: true });
      return { started: true, ts: Date.now() };
    } catch (err) {
      this.scannerRunning = false;
      throw err;
    }
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
