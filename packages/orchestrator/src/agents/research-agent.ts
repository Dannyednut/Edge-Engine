/**
 * ResearchAgent — continuous edge discovery + market monitoring.
 *
 * Responsibilities:
 *   - Scan markets continuously for new arbitrage edges
 *   - Monitor funding rate regimes (Hyperliquid, CEX venues)
 *   - Track new venue listings + delistings
 *   - Research novel arb structures (not copying existing bots)
 *   - Publish weekly edge reports to the message bus
 *   - Flag regime shifts that affect other agents' strategies
 *
 * Runs continuously. When it discovers a new edge, it sends a TASK message
 * to the EngineeringAgent to build a capture system for it.
 */

import { BaseAgent, type Task, type MessageBus } from '../index.js';
import { SharpeClient } from '@edge/sharpe-client';
import { VooiClient } from '@edge/vooi-client';

export class ResearchAgent extends BaseAgent {
  readonly agentId = 'research' as const;

  private sharpe: SharpeClient;
  private vooi: VooiClient;
  private readonly scanIntervalMs = 5 * 60_000;   // 5 min

  constructor(messageBus: MessageBus, sharpeApiKey?: string, vooiApiToken?: string) {
    super({ agentId: 'research', messageBus });
    this.sharpe = new SharpeClient({ apiKey: sharpeApiKey });
    this.vooi = new VooiClient({ apiToken: vooiApiToken });
  }

  protected async run(): Promise<void> {
    // Main loop: scan markets every 5 min, look for new edges
    while (this.status === 'alive') {
      try {
        await this.scanMarkets();
      } catch (err) {
        console.error('[research] scan failed:', err);
      }
      await sleep(this.scanIntervalMs);
    }
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const params = task.params as { type: string; landscape?: string; query?: string };
    switch (params.type) {
      case 'scan_market':
        return await this.scanMarkets();
      case 'research_edge':
        return await this.researchEdge(params.query || '');
      case 'monitor_regime':
        return await this.monitorRegime();
      case 'backtest':
        return await this.backtest(params.landscape);
      default:
        throw new Error(`ResearchAgent: unknown task type ${params.type}`);
    }
  }

  /**
   * Scan markets for new edges. This is the continuous-discovery loop.
   * Looks for:
   *   - New Sharpe cross-exchange arbs that weren't there before
   *   - VOOI pairs with anomalous funding spreads
   *   - New venue listings
   *   - Regime shifts (funding sign flips like HYPE)
   */
  private async scanMarkets(): Promise<unknown> {
    console.log('[research] scanning markets...');

    // Pull Sharpe cross-exchange arbs
    const sharpeResp = await this.sharpe.crossExchangeFunding({
      minApr: 5,
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
      console.warn('[research] VOOI scan failed:', err);
    }

    const summary = {
      ts: Date.now(),
      sharpeArbs: sharpeResp.data.length,
      vooiPairs: vooiCount,
      topArbs: sharpeResp.data.slice(0, 5).map(r => ({
        asset: r.coin || r.asset,
        long: r.longExchange,
        short: r.shortExchange,
        netApr: r.netApr,
      })),
    };

    console.log(`[research] scan complete: ${summary.sharpeArbs} Sharpe arbs, ${summary.vooiPairs} VOOI pairs`);

    // If we find an exceptionally high-APR arb, alert the orchestrator
    const exceptional = sharpeResp.data.find(r => (r.netApr ?? 0) > 50);
    if (exceptional) {
      this.sendMessage('orchestrator', 'ALERT', 'Exceptional arb found', {
        asset: exceptional.coin || exceptional.asset,
        netApr: exceptional.netApr,
        long: exceptional.longExchange,
        short: exceptional.shortExchange,
      });
    }

    return summary;
  }

  /** Research a specific edge query (e.g. "Hyperliquid spot-perp basis"). */
  private async researchEdge(query: string): Promise<unknown> {
    console.log(`[research] researching edge: ${query}`);
    // This would normally dispatch a subagent to do deep research.
    // For now, return a placeholder.
    return {
      query,
      ts: Date.now(),
      status: 'research_queued',
      note: 'Deep research would be dispatched here — currently a stub.',
    };
  }

  /** Monitor funding rate regime shifts. */
  private async monitorRegime(): Promise<unknown> {
    console.log('[research] monitoring funding regime...');
    const sharpeResp = await this.sharpe.crossExchangeFunding({
      minApr: 0,
      minOiUsd: 500_000,
      assetClass: 'crypto',
    });

    // Look for assets where funding flipped sign since last scan
    // (would need to persist previous scan results to detect flips)
    const regimeReport = {
      ts: Date.now(),
      totalArbs: sharpeResp.data.length,
      positiveFunding: sharpeResp.data.filter(r => (r.netApr ?? 0) > 0).length,
      negativeFunding: sharpeResp.data.filter(r => (r.netApr ?? 0) < 0).length,
    };

    return regimeReport;
  }

  /** Backtest a strategy on historical data. */
  private async backtest(landscape?: string): Promise<unknown> {
    console.log(`[research] backtesting ${landscape || 'all landscapes'}...`);
    return { landscape, ts: Date.now(), status: 'backtest_queued' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
