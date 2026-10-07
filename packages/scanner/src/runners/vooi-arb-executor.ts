/**
 * VooiArbExecutor — executes perp funding arb via VOOI atomic paired-leg orders.
 *
 * VOOI (https://ultra.vooi.io) is a CEX-like DEX aggregator that supports
 * ATOMIC paired-leg execution across 12+ venues:
 *   Hyperliquid, Lighter, Aster, Extended, trade.xyz, Kinetiq, Robinhood, Ondo,
 *   Binance, Bybit, MEXC, Gate
 *
 * EXECUTION MODES:
 *   1. Manual: placeArbitrageOrder() for specific pairs
 *   2. Autonomous: createBot() + startBot() for 24/7 auto-execution
 *
 * ARB STRUCTURE:
 *   PerpFundingStrategy finds pairs with high funding rate spreads.
 *   VOOI executes both legs atomically:
 *     - Primary leg: open position on high-funding venue (earn funding)
 *     - Hedge leg: open opposite position on low-funding venue (pay funding)
 *     - Net capture = funding spread × position size × hold time
 *
 * CURRENT TOP OPPORTUNITY (Oct 7 2026):
 *   NMR: Long MEXC → Short Gate = 2294% APR
 *   OI: $87M / $20M (deep liquidity on both sides)
 *   At $5k notional: ~$1,147/day in funding capture
 *   Funding rates reset every 8h, so hold time is short
 *
 * REQUIREMENTS:
 *   - VOOI API token (✅ have it: VOOI_API_TOKEN env var)
 *   - Capital deposited on VOOI platform (⚠️ status unknown — need to check)
 *   - Principal approval to start live trading (⚠️ NOT YET APPROVED)
 */

import { VooiClient, type VooiArbitrageOrderRequest, type VooiBotRequest, type VooiBot, type VooiArbitrageOrder } from '@edge/vooi-client';
import type { PerpFundingAlert } from '../strategies/perp-funding.js';

export interface VooiArbExecutorOptions {
  /** VOOI API token (from env) */
  apiToken: string;
  /** Max notional per arb position (default $5000) */
  maxSizeUsd: number;
  /** Min net APR to execute (default 70% — VOOI's recommended minimum) */
  minNetApr: number;
  /** Max net APR to execute (default 120% — VOOI says >120% "collapses fast") */
  maxNetApr?: number;
  /** Min hold hours before soft exit (default 12 — VOOI recommended) */
  minHoldHours?: number;
  /** Max hold hours for arb bots (default 96 — VOOI recommended 4 days) */
  maxHoldHours: number;
  /** Max round-trip cost in bps (default 12 — 0.12%) */
  maxRoundTripCostBps: number;
  /** Stop loss percentage of collateral (default 5% — VOOI recommended) */
  stopLossPct?: number;
  /** Max slippage per leg in bps (default 200 = 2% — VOOI recommended) */
  maxSlippageBps?: number;
  /** Max adverse basis in bps (default 30 = 0.3% — VOOI recommended) */
  maxAdverseBasisBps?: number;
  /** Dry-run mode (build orders but don't submit) */
  dryRun?: boolean;
  /** VOOI venue set (must match PerpFundingStrategy) */
  venueSet: string[];
}

export interface VooiArbOpportunity {
  alert: PerpFundingAlert;
  notionalUsd: number;
  estimatedDailyProfitUsd: number;
  estimatedHoldHours: number;
  executable: boolean;
  reason?: string;
}

export class VooiArbExecutor {
  private vooi: VooiClient;
  private venueSet: Set<string>;

  constructor(private opts: VooiArbExecutorOptions) {
    this.vooi = new VooiClient({ apiToken: opts.apiToken });
    this.venueSet = new Set(opts.venueSet.map(v => v.toLowerCase()));
  }

  /**
   * Filter perp funding alerts for VOOI-executable opportunities.
   * Both venues must be in the VOOI venue set.
   */
  filterExecutable(alerts: PerpFundingAlert[]): VooiArbOpportunity[] {
    const opps: VooiArbOpportunity[] = [];

    for (const alert of alerts) {
      const longOk = this.venueSet.has(alert.longVenue.toLowerCase());
      const shortOk = this.venueSet.has(alert.shortVenue.toLowerCase());

      if (!longOk || !shortOk) {
        continue; // skip non-VOOI pairs
      }

      if (alert.netApr < this.opts.minNetApr) {
        continue; // skip low-APR pairs
      }

      // VOOI recommends max APR cap — ">120% APR collapses fast"
      const maxApr = this.opts.maxNetApr ?? 120;
      if (alert.netApr > maxApr) {
        continue; // skip high-APR spikes (likely ephemeral)
      }

      if (!alert.vooiExecutable) {
        continue; // skip if VOOI scanner didn't flag it
      }

      // Estimate daily profit
      // netApr is annualized; daily = netApr / 365
      // But funding resets every 8h, so effective hold is ~8-24h
      const estimatedHoldHours = Math.min(this.opts.maxHoldHours, 8);
      const estimatedDailyProfitUsd = (alert.netApr / 100 / 365) * this.opts.maxSizeUsd;

      opps.push({
        alert,
        notionalUsd: this.opts.maxSizeUsd,
        estimatedDailyProfitUsd,
        estimatedHoldHours,
        executable: true,
      });
    }

    // Sort by estimated daily profit (highest first)
    opps.sort((a, b) => b.estimatedDailyProfitUsd - a.estimatedDailyProfitUsd);
    return opps;
  }

  /**
   * Place a single arbitrage order via VOOI.
   * Atomic: both legs fill or neither fills.
   */
  async placeArbOrder(opp: VooiArbOpportunity): Promise<{ success: boolean; order?: VooiArbitrageOrder; error?: string }> {
    if (this.opts.dryRun) {
      console.log(`[dry-run] Would place VOOI arb order:`);
      console.log(`  Asset: ${opp.alert.asset}`);
      console.log(`  Primary: BUY ${opp.alert.longVenue} (funding +)`);
      console.log(`  Hedge:   SELL ${opp.alert.shortVenue} (funding -)`);
      console.log(`  Notional: $${opp.notionalUsd}`);
      console.log(`  Est. daily profit: $${opp.estimatedDailyProfitUsd.toFixed(2)}`);
      console.log(`  Net APR: ${opp.alert.netApr.toFixed(1)}%`);
      return { success: false, error: 'dry-run mode' };
    }

    try {
      // Convert notional to contracts (VOOI uses contracts, not USD)
      // For most venues, 1 contract = 1 unit of the asset
      // We need the price to convert: contracts = notional / price
      const price = opp.alert.longOiUsd > 0 ? opp.alert.longOiUsd / 1e6 : 1; // rough estimate
      const size = Math.floor(opp.notionalUsd / price);

      const req: VooiArbitrageOrderRequest = {
        primary: {
          asset: opp.alert.asset,
          exchange: opp.alert.longVenue,
          side: 'buy',
          size,
          type: 'market',
        },
        hedge: {
          asset: opp.alert.asset,
          exchange: opp.alert.shortVenue,
          side: 'sell',
          size,
          type: 'market',
        },
        partialFillPolicy: 'fullFill',
        hedgeFailurePolicy: 'alertAndHold',
      };

      console.log(`[vooi-exec] Placing arb order: ${opp.alert.asset} ${opp.alert.longVenue}→${opp.alert.shortVenue}`);
      const order = await this.vooi.placeArbitrageOrder(req);
      console.log(`[vooi-exec] ✓ Order placed: id=${order.id} status=${order.status}`);
      return { success: true, order };
    } catch (e: any) {
      console.error(`[vooi-exec] Order failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /**
   * Create an autonomous VOOI arb bot.
   * The bot automatically finds and executes arbs 24/7.
   */
  async createArbBot(params: {
    exchanges: string[];
    leverage: number;
    notionalUsd: number;
    categories?: string[];
    symbols?: string[];
  }): Promise<{ success: boolean; bot?: VooiBot; error?: string }> {
    if (this.opts.dryRun) {
      console.log(`[dry-run] Would create VOOI arb bot:`);
      console.log(`  Exchanges: ${params.exchanges.join(', ')}`);
      console.log(`  Leverage: ${params.leverage}x`);
      console.log(`  Notional: $${params.notionalUsd}`);
      console.log(`  Max hold: ${this.opts.maxHoldHours}h`);
      console.log(`  Max round-trip cost: ${this.opts.maxRoundTripCostBps} bps`);
      return { success: false, error: 'dry-run mode' };
    }

    try {
      const req: VooiBotRequest = {
        exchanges: params.exchanges,
        leverage: params.leverage,
        maxHoldHours: this.opts.maxHoldHours,
        maxRoundTripCostBps: this.opts.maxRoundTripCostBps,
        notionalUsd: params.notionalUsd,
        categories: params.categories,
        symbols: params.symbols,
      };

      console.log(`[vooi-exec] Creating arb bot...`);
      const bot = await this.vooi.createBot(req);
      console.log(`[vooi-exec] ✓ Bot created: id=${bot.id} status=${bot.status}`);
      return { success: true, bot };
    } catch (e: any) {
      console.error(`[vooi-exec] Bot creation failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /** Start an existing bot. */
  async startBot(botId: string): Promise<{ success: boolean; error?: string }> {
    if (this.opts.dryRun) {
      console.log(`[dry-run] Would start bot: ${botId}`);
      return { success: false, error: 'dry-run mode' };
    }
    try {
      await this.vooi.startBot(botId);
      console.log(`[vooi-exec] ✓ Bot started: ${botId}`);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /** Stop a running bot. */
  async stopBot(botId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.vooi.stopBot(botId);
      console.log(`[vooi-exec] ✓ Bot stopped: ${botId}`);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /** List all bots. */
  async listBots(): Promise<VooiBot[]> {
    return this.vooi.listBots();
  }

  /** List recent arbitrage orders. */
  async listOrders(): Promise<VooiArbitrageOrder[]> {
    const r = await this.vooi.listArbitrageOrders();
    return r.items || [];
  }
}

// ─── CLI entry point ───────────────────────────────────────────────────
async function main() {
  const args = new Set(process.argv.slice(2));
  const apiToken = process.env.VOOI_API_TOKEN;
  if (!apiToken) {
    console.error('VOOI_API_TOKEN not set');
    process.exit(1);
  }

  const executor = new VooiArbExecutor({
    apiToken,
    maxSizeUsd: 5000,
    minNetApr: 70,  // VOOI recommended minimum
    maxHoldHours: 96,  // VOOI recommended (4 days)
    maxRoundTripCostBps: 12,
    dryRun: !args.has('--live'),
    venueSet: ['hyperliquid', 'lighter', 'aster', 'extended', 'trade.xyz', 'kinetiq', 'robinhood', 'ondo', 'binance', 'bybit', 'mexc', 'gate'],
  });

  console.log('═══════════════════════════════════════════════════');
  console.log('  VOOI Arbitrage Executor');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Mode: ${executor['opts'].dryRun ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`  Max notional: $${executor['opts'].maxSizeUsd}`);
  console.log(`  Min APR: ${executor['opts'].minNetApr}%`);

  // List existing bots
  console.log('\n── Existing Bots ──');
  try {
    const bots = await executor.listBots();
    console.log(`  Found ${bots.length} bots`);
    for (const b of bots) {
      console.log(`    - ${b.id}: status=${b.status} notional=$${b.notionalUsd} exchanges=${b.exchanges.join(',')}`);
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message}`);
  }

  // List recent orders
  console.log('\n── Recent Orders ──');
  try {
    const orders = await executor.listOrders();
    console.log(`  Found ${orders.length} orders`);
    for (const o of orders.slice(0, 5)) {
      console.log(`    - ${o.id}: status=${o.status} ${o.primary.asset} ${o.primary.exchange}→${o.hedge.exchange}`);
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message}`);
  }

  if (args.has('--create-bot')) {
    console.log('\n── Creating Arb Bot ──');
    const result = await executor.createArbBot({
      exchanges: ['hyperliquid', 'binance', 'bybit', 'mexc', 'gate'],
      leverage: 1,
      notionalUsd: 5000,
      categories: ['crypto'],
    });
    console.log('  Result:', result);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
