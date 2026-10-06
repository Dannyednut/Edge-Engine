/**
 * ResearchAgent v2 — EXPLORATORY. Not locked to any area.
 *
 * Distinction from MonitoringAgent:
 *   - MonitoringAgent scans KNOWN edges continuously (Sharpe+VOOI perp
 *     funding, prediction arb, sports arb). Mechanical, repeatable.
 *   - ResearchAgent EXSPLORES — discovers new frameworks, new venues, new
 *     approaches, market updates, novel arb structures. Like a manager
 *     growing the enterprise.
 *
 * What ResearchAgent does:
 *   1. Discovers new arbitrage landscapes (not just the 7 we have)
 *   2. Tracks new protocol launches + venue listings
 *   3. Evaluates new tools + frameworks (like view-quoter-v3, PumpApi, VOOI)
 *   4. Reads market structure changes (regulatory, technological)
 *   5. Surfaces novel arb structures from first principles
 *   6. Monitors competitor activity (what are other arb bots doing?)
 *   7. Tracks academic papers + research on MEV, AMM design, perp mechanics
 *   8. Evaluates new chains + L2s for arb viability
 *   9. Discovers new data sources + APIs
 *  10. Recommends enterprise expansion (new landscapes, new strategies)
 *
 * Output: weekly Research Bulletin with new discoveries + recommendations.
 * Real-time: ALERT messages to orchestrator when something actionable is found.
 *
 * NOT a scanner. Does NOT re-poll Sharpe/VOOI. That is MonitoringAgent's job.
 */

import { BaseAgent, type Task, type MessageBus } from '../index.js';

export interface ResearchDiscovery {
  id: string;
  ts: number;
  category: 'new_landscape' | 'new_venue' | 'new_tool' | 'new_framework' |
            'market_structure' | 'regulatory' | 'competitor' | 'academic' |
            'new_chain' | 'new_data_source' | 'enterprise_expansion';
  title: string;
  summary: string;
  potentialEdge?: string;       // what arb opportunity this creates
  recommendedAction?: string;   // what the enterprise should do about it
  priority: 'low' | 'medium' | 'high' | 'critical';
  sources: string[];
}

export class ResearchAgent extends BaseAgent {
  readonly agentId = 'research' as const;
  private discoveries: ResearchDiscovery[] = [];
  private readonly discoverySources: ResearchSource[] = [
    new ProtocolLaunchTracker(),
    new ToolEvaluator(),
    new MarketStructureMonitor(),
    new ChainViabilityAssessor(),
    new CompetitorMonitor(),
    new AcademicPaperTracker(),
  ];

  constructor(messageBus: MessageBus) {
    super({ agentId: 'research', messageBus });
  }

  protected async run(): Promise<void> {
    // Main loop: exploratory research cycle every 30 min
    while (this.status === 'alive') {
      try {
        await this.exploratoryCycle();
      } catch (err) {
        console.error('[research] exploratory cycle failed:', err);
      }
      // 30 min between cycles (research is not time-critical like monitoring)
      await sleep(30 * 60_000);
    }
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const params = task.params as { type: string; query?: string; landscape?: string };
    switch (params.type) {
      case 'research_edge':
        return await this.researchEdge(params.query || '');
      case 'explore_landscape':
        return await this.exploreLandscape(params.landscape || '');
      case 'evaluate_tool':
        return await this.evaluateTool(params.query || '');
      case 'weekly_bulletin':
        return await this.compileWeeklyBulletin();
      case 'list_discoveries':
        return this.discoveries;
      default:
        throw new Error(`ResearchAgent: unknown task type ${params.type}`);
    }
  }

  /**
   * One exploratory research cycle. Polls all discovery sources,
   * surfaces anything new, alerts orchestrator on high-priority finds.
   */
  private async exploratoryCycle(): Promise<void> {
    console.log('[research] exploratory cycle starting...');

    for (const source of this.discoverySources) {
      try {
        const discoveries = await source.scan();
        for (const d of discoveries) {
          this.discoveries.push(d);
          console.log(`[research] discovery: [${d.priority}] ${d.title}`);

          // Alert orchestrator on high-priority discoveries
          if (d.priority === 'high' || d.priority === 'critical') {
            this.sendMessage('orchestrator', 'ALERT', `Research discovery: ${d.title}`, d);
          }

          // If the discovery recommends a new module, dispatch to EngineeringAgent
          if (d.recommendedAction && d.recommendedAction.includes('build')) {
            this.sendMessage('engineering', 'TASK', `Build: ${d.title}`, {
              type: 'build_module',
              description: d.recommendedAction,
            });
          }
        }
      } catch (err) {
        console.warn(`[research] source ${source.constructor.name} failed:`, err);
      }
    }

    console.log(`[research] cycle complete. Total discoveries: ${this.discoveries.length}`);
  }

  /** Research a specific edge query (deep dive). */
  private async researchEdge(query: string): Promise<unknown> {
    console.log(`[research] deep dive: ${query}`);
    return {
      query,
      ts: Date.now(),
      status: 'This would dispatch a focused research subagent to investigate the query.',
      note: 'In production: web search + page reader + synthesis. Currently a stub.',
    };
  }

  /** Explore a new landscape for arb viability. */
  private async exploreLandscape(landscape: string): Promise<unknown> {
    console.log(`[research] exploring new landscape: ${landscape}`);
    return {
      landscape,
      ts: Date.now(),
      status: 'Would assess: venues, liquidity, edge sizes, capital efficiency, risks.',
    };
  }

  /** Evaluate a new tool/framework for enterprise integration. */
  private async evaluateTool(toolName: string): Promise<unknown> {
    console.log(`[research] evaluating tool: ${toolName}`);
    return {
      tool: toolName,
      ts: Date.now(),
      status: 'Would assess: what it does, API surface, pricing, integration path.',
    };
  }

  /** Compile the weekly research bulletin. */
  private async compileWeeklyBulletin(): Promise<unknown> {
    const recent = this.discoveries.filter(d => Date.now() - d.ts < 7 * 24 * 60 * 60 * 1000);
    return {
      weekOf: new Date().toISOString().slice(0, 10),
      totalDiscoveries: recent.length,
      byCategory: this.groupByCategory(recent),
      byPriority: this.groupByPriority(recent),
      discoveries: recent,
    };
  }

  private groupByCategory(discoveries: ResearchDiscovery[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const d of discoveries) out[d.category] = (out[d.category] || 0) + 1;
    return out;
  }

  private groupByPriority(discoveries: ResearchDiscovery[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const d of discoveries) out[d.priority] = (out[d.priority] || 0) + 1;
    return out;
  }
}

// ─── Research source interfaces ───────────────────────────────────────

interface ResearchSource {
  scan(): Promise<ResearchDiscovery[]>;
}

/**
 * Tracks new protocol launches (new DEXs, perp DEXs, lending protocols).
 * Source: DeFiLlama new protocols, GitHub new repos, X/Twitter announcements.
 */
class ProtocolLaunchTracker implements ResearchSource {
  async scan(): Promise<ResearchDiscovery[]> {
    // In production: poll DeFiLlama /protocols, GitHub topics, X search
    // For now: return empty (stub)
    return [];
  }
}

/**
 * Evaluates new tools + frameworks (like view-quoter-v3, PumpApi, VOOI).
 * Source: GitHub trending, npm new packages, product hunt.
 */
class ToolEvaluator implements ResearchSource {
  async scan(): Promise<ResearchDiscovery[]> {
    return [];
  }
}

/**
 * Monitors market structure changes (new listing models, fee changes,
 * consolidation, regulatory shifts).
 * Source: exchange announcements, news, regulatory filings.
 */
class MarketStructureMonitor implements ResearchSource {
  async scan(): Promise<ResearchDiscovery[]> {
    return [];
  }
}

/**
 * Assesses new chains + L2s for arbitrage viability.
 * Source: chain launches, bridge deployments, DEX deployments on new chains.
 */
class ChainViabilityAssessor implements ResearchSource {
  async scan(): Promise<ResearchDiscovery[]> {
    return [];
  }
}

/**
 * Monitors what other arb bots / searchers are doing.
 * Source: MEV dashboards, on-chain analysis, GitHub arb bot repos.
 */
class CompetitorMonitor implements ResearchSource {
  async scan(): Promise<ResearchDiscovery[]> {
    return [];
  }
}

/**
 * Tracks academic papers on MEV, AMM design, perp mechanics, prediction
 * markets. Source: arXiv, SSRN, conference proceedings.
 */
class AcademicPaperTracker implements ResearchSource {
  async scan(): Promise<ResearchDiscovery[]> {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
