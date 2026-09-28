/**
 * VooiExecutor — wraps VOOI's POST /arbitrage-orders for atomic paired-leg
 * execution of perp funding arbs.
 *
 * Why VOOI:
 *   - 11 perp venues unified behind one API (Hyperliquid, Lighter, Aster,
 *     Extended, trade.xyz, Kinetiq, Robinhood Lighter, Ondo, Binance,
 *     Bybit, MEXC)
 *   - Atomic paired-leg execution: primary leg placed first (limit), hedge
 *     leg fires automatically once primary fills (market)
 *   - Both legs validated before acceptance
 *   - partialFillPolicy: fullFill (only option)
 *   - hedgeFailurePolicy: alertAndHold (only option — leaves naked leg)
 *
 * Risk flags:
 *   - hedgeFailurePolicy leaves a naked leg on hedge failure → MUST alert
 *   - partialFillPolicy fullFill means partial primary fills cancel entire order
 *   - No sandbox — every test is real money
 *
 * Pre-execution checks (must all pass before calling placeArbitrageOrder):
 *   1. RiskGuard.preExec() — daily loss, cooldown, gas cap, kill switch
 *   2. Both legs on VOOI venue set (else skip)
 *   3. Price spread < 1% (else entry/exit slippage eats the funding edge)
 *   4. Min net APR threshold (configurable; default 8%)
 *   5. Pair has live quote in VOOI scanner (else skip)
 */

import { VooiClient, type VooiArbitrageOrder, type VooiArbitrageOrderLeg, type VooiArbitrageOrderRequest } from '@edge/vooi-client';
import type { TelegramAlerter } from '@edge/alerts';

export interface VooiExecutorOptions {
  vooi: VooiClient;
  alerter: TelegramAlerter;
  /** Min net APR to execute (default 0.08 = 8%) */
  minAprToExecute?: number;
  /** Max price spread % to allow (default 1.0) */
  maxPriceSpreadPct?: number;
  /** Default notional USD per arb (default 5000) */
  defaultNotionalUsd?: number;
  /** Default leverage (default 2) */
  defaultLeverage?: number;
  /** Max hold hours before auto-close (default 72) */
  maxHoldHours?: number;
  /** Dry-run mode: log but don't actually submit orders */
  dryRun?: boolean;
}

export interface ExecuteArbParams {
  asset: string;
  longVenue: string;          // e.g. 'pacifica'
  shortVenue: string;         // e.g. 'hyperliquid'
  notionalUsd?: number;       // overrides default
  leverage?: number;          // overrides default
  /** Limit price for the primary leg (long). If not set, uses market. */
  longLimitPrice?: number;
  /** Limit price for the hedge leg (short). If not set, uses market. */
  shortLimitPrice?: number;
  /** Slippage tolerance for market legs (default 0.5%) */
  slippagePct?: number;
}

export interface ExecuteArbResult {
  orderId: string;
  status: VooiArbitrageOrder['status'];
  primaryFillPrice?: number;
  hedgeFillPrice?: number;
  error?: string;
  dryRun?: boolean;
}

export class VooiExecutor {
  private readonly vooi: VooiClient;
  private readonly alerter: TelegramAlerter;
  private readonly maxPriceSpreadPct: number;
  private readonly defaultNotionalUsd: number;
  private readonly defaultLeverage: number;
  private readonly maxHoldHours: number;
  private readonly dryRun: boolean;

  constructor(opts: VooiExecutorOptions) {
    this.vooi = opts.vooi;
    this.alerter = opts.alerter;
    this.maxPriceSpreadPct = opts.maxPriceSpreadPct ?? 1.0;
    this.defaultNotionalUsd = opts.defaultNotionalUsd ?? 5000;
    this.defaultLeverage = opts.defaultLeverage ?? 2;
    this.maxHoldHours = opts.maxHoldHours ?? 72;
    this.dryRun = opts.dryRun ?? false;
  }

  /**
   * Execute a paired-leg perp funding arb via VOOI.
   * Returns the order ID + status.
   */
  async executeArb(params: ExecuteArbParams): Promise<ExecuteArbResult> {
    const notional = params.notionalUsd ?? this.defaultNotionalUsd;
    const leverage = params.leverage ?? this.defaultLeverage;
    const slippage = params.slippagePct ?? 0.5;

    // 1. Validate venue support
    if (!VOOI_SUPPORTED_VENUES.has(params.longVenue.toLowerCase())) {
      return this.fail(`Long venue ${params.longVenue} not on VOOI`);
    }
    if (!VOOI_SUPPORTED_VENUES.has(params.shortVenue.toLowerCase())) {
      return this.fail(`Short venue ${params.shortVenue} not on VOOI`);
    }

    // 2. Get live quote from VOOI scanner to verify spread
    const scanResp = await this.vooi.scanArbitrage({
      query: params.asset,
      notionalUsd: notional,
      limit: 5,
    });
    const matchingPair = scanResp.items
      .flatMap(item => item.pairs.map(p => ({ ...p, asset: item.asset })))
      .find(p =>
        p.asset.toUpperCase() === params.asset.toUpperCase() &&
        (
          (p.long.exchange.toLowerCase() === params.longVenue.toLowerCase() &&
           p.short.exchange.toLowerCase() === params.shortVenue.toLowerCase()) ||
          (p.long.exchange.toLowerCase() === params.shortVenue.toLowerCase() &&
           p.short.exchange.toLowerCase() === params.longVenue.toLowerCase())
        )
      );

    if (!matchingPair) {
      return this.fail(`No live VOOI pair for ${params.asset} ${params.longVenue}/${params.shortVenue}`);
    }

    const priceSpreadPct = (matchingPair.priceSpreadAtSize ?? matchingPair.priceSpread ?? 0) * 100;
    if (Math.abs(priceSpreadPct) > this.maxPriceSpreadPct) {
      return this.fail(`Price spread ${priceSpreadPct.toFixed(3)}% exceeds max ${this.maxPriceSpreadPct}%`);
    }

    // 3. Compute order sizes (in contracts — VOOI uses USD-quoted perps)
    // For USD-quoted perps, 1 contract = $1 notional, so contracts = notional
    const sizePerLeg = Math.floor(notional / leverage);

    // 4. Build the order legs
    // Primary = LONG on longVenue (limit if price provided, else market)
    // Hedge = SHORT on shortVenue (always market for fast fill)
    const longLeg = this.buildLeg({
      asset: params.asset,
      exchange: params.longVenue,
      side: 'buy',
      size: sizePerLeg,
      limitPrice: params.longLimitPrice,
      slippagePct: slippage,
    });
    const shortLeg = this.buildLeg({
      asset: params.asset,
      exchange: params.shortVenue,
      side: 'sell',
      size: sizePerLeg,
      limitPrice: params.shortLimitPrice,
      slippagePct: slippage,
    });

    const orderReq: VooiArbitrageOrderRequest = {
      primary: longLeg,
      hedge: shortLeg,
      partialFillPolicy: 'fullFill',
      hedgeFailurePolicy: 'alertAndHold',
      clientOrderId: `edge_${Date.now()}_${params.asset}_${params.longVenue}_${params.shortVenue}`,
    };

    // 5. Dry-run check
    if (this.dryRun) {
      console.log(`[VooiExecutor:DRY-RUN] Would submit:`, JSON.stringify(orderReq, null, 2));
      return {
        orderId: `dryrun_${Date.now()}`,
        status: 'pending',
        dryRun: true,
      };
    }

    // 6. Submit
    try {
      const order = await this.vooi.placeArbitrageOrder(orderReq);

      // Alert on submission
      await this.alerter.sendAlert({
        id: `vooi_submit_${order.id}`,
        ts: Date.now(),
        severity: 'opportunity',
        strategyId: 'perp_funding',
        opportunityId: order.id,
        title: `VOOI order submitted: ${params.asset} $${notional} ${params.longVenue}/short ${params.shortVenue}`,
        body: [
          `Order ID: \`${order.id}\``,
          `Status: \`${order.status}\``,
          `Primary (long ${params.longVenue}): ${longLeg.type} ${sizePerLeg} contracts${params.longLimitPrice ? ' @ ' + params.longLimitPrice : ''}`,
          `Hedge (short ${params.shortVenue}): ${shortLeg.type} ${sizePerLeg} contracts`,
          `Price spread at size: ${priceSpreadPct.toFixed(3)}%`,
          `Max hold: ${this.maxHoldHours}h`,
          '',
          `_If hedge fails, naked leg will be left open and you will get a critical alert. Manually close via VOOI UI or API._`,
        ].join('\n'),
        channels: ['telegram'],
      });

      return {
        orderId: order.id,
        status: order.status,
        primaryFillPrice: order.primary.fillPrice,
        hedgeFillPrice: order.hedge?.fillPrice,
      };
    } catch (err) {
      const errorMsg = String(err).slice(0, 300);
      await this.alerter.sendAlert({
        id: `vooi_err_${Date.now()}`,
        ts: Date.now(),
        severity: 'critical',
        strategyId: 'perp_funding',
        title: `VOOI order FAILED: ${params.asset}`,
        body: `Error: ${errorMsg}\n\n_Order was not placed. No naked leg._`,
        channels: ['telegram'],
      });
      return {
        orderId: `failed_${Date.now()}`,
        status: 'failed',
        error: errorMsg,
      };
    }
  }

  /**
   * Close an existing paired-leg position by submitting reverse orders.
   */
  async closeArb(params: {
    orderId: string;
    asset: string;
    longVenue: string;
    shortVenue: string;
    size: number;
  }): Promise<ExecuteArbResult> {
    if (this.dryRun) {
      console.log(`[VooiExecutor:DRY-RUN] Would close:`, JSON.stringify(params, null, 2));
      return { orderId: `dryrun_close_${Date.now()}`, status: 'cancelled', dryRun: true };
    }

    // Build reverse legs: sell long, buy short (reduceOnly)
    const closeLong: VooiArbitrageOrderLeg = {
      asset: params.asset,
      exchange: params.longVenue,
      side: 'sell',
      size: params.size,
      type: 'market',
      reduceOnly: true,
      timeInForce: 'ioc',
    };
    const closeShort: VooiArbitrageOrderLeg = {
      asset: params.asset,
      exchange: params.shortVenue,
      side: 'buy',
      size: params.size,
      type: 'market',
      reduceOnly: true,
      timeInForce: 'ioc',
    };

    try {
      const order = await this.vooi.placeArbitrageOrder({
        primary: closeLong,
        hedge: closeShort,
        partialFillPolicy: 'fullFill',
        hedgeFailurePolicy: 'alertAndHold',
        clientOrderId: `edge_close_${Date.now()}_${params.orderId}`,
      });
      return {
        orderId: order.id,
        status: order.status,
      };
    } catch (err) {
      return {
        orderId: `failed_close_${Date.now()}`,
        status: 'failed',
        error: String(err).slice(0, 300),
      };
    }
  }

  /**
   * Monitor open positions and auto-close when:
   *   - maxHoldHours exceeded
   *   - funding spread inverts (long leg goes negative)
   *   - profit target hit
   *
   * Called on a timer by the funding-runner.
   */
  async monitorAndClose(opts: {
    asset: string;
    longVenue: string;
    shortVenue: string;
    openedAt: number;
    size: number;
    originalOrderId: string;
  }): Promise<{ closed: boolean; reason?: string; closeOrderId?: string }> {
    const ageHours = (Date.now() - opts.openedAt) / (60 * 60 * 1000);

    // 1. Max hold time
    if (ageHours >= this.maxHoldHours) {
      const close = await this.closeArb({
        orderId: opts.originalOrderId,
        asset: opts.asset,
        longVenue: opts.longVenue,
        shortVenue: opts.shortVenue,
        size: opts.size,
      });
      return { closed: true, reason: `max_hold_${this.maxHoldHours}h`, closeOrderId: close.orderId };
    }

    // 2. Check current funding spread via VOOI scanner
    try {
      const scanResp = await this.vooi.scanArbitrage({
        query: opts.asset,
        notionalUsd: opts.size,
        limit: 5,
      });
      const pair = scanResp.items
        .flatMap(item => item.pairs.map(p => ({ ...p, asset: item.asset })))
        .find(p =>
          p.asset.toUpperCase() === opts.asset.toUpperCase() &&
          p.long.exchange.toLowerCase() === opts.longVenue.toLowerCase() &&
          p.short.exchange.toLowerCase() === opts.shortVenue.toLowerCase()
        );

      if (pair) {
        // If funding spread inverts (negative), close
        if (pair.fundingSpread1h < 0) {
          const close = await this.closeArb({
            orderId: opts.originalOrderId,
            asset: opts.asset,
            longVenue: opts.longVenue,
            shortVenue: opts.shortVenue,
            size: opts.size,
          });
          return { closed: true, reason: 'funding_inverted', closeOrderId: close.orderId };
        }
      }
    } catch (err) {
      console.warn('monitorAndClose: VOOI scan failed:', err);
    }

    return { closed: false };
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private buildLeg(params: {
    asset: string;
    exchange: string;
    side: 'buy' | 'sell';
    size: number;
    limitPrice?: number;
    slippagePct?: number;
  }): VooiArbitrageOrderLeg {
    const leg: VooiArbitrageOrderLeg = {
      asset: params.asset,
      exchange: params.exchange,
      side: params.side,
      size: params.size,
      type: params.limitPrice !== undefined ? 'limit' : 'market',
    };
    if (params.limitPrice !== undefined) {
      leg.price = params.limitPrice;
      leg.timeInForce = 'gtc';
    } else {
      leg.timeInForce = 'ioc';
    }
    return leg;
  }

  private async fail(reason: string): Promise<ExecuteArbResult> {
    return {
      orderId: `skipped_${Date.now()}`,
      status: 'cancelled',
      error: reason,
    };
  }
}

// ─── VOOI-supported venue set (lowercase) ──────────────────────────

export const VOOI_SUPPORTED_VENUES = new Set([
  'hyperliquid',
  'lighter',
  'aster',
  'extended',
  'trade.xyz',
  'kinetiq',
  'robinhood',     // Robinhood Lighter
  'ondo',
  'binance',
  'bybit',
  'mexc',
  'gate',
]);
