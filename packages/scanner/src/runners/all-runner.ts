/**
 * Multi-strategy runner — runs ALL active strategies in parallel and
 * sends Telegram alerts for any opportunities found.
 *
 * Active strategies (as of Brief 03):
 *   1. PerpFundingStrategy — any-venue perp funding arb (Sharpe + VOOI)
 *   2. CexHlFundingArbStrategy — CEX spot + HL perp (9-11% APR carry)
 *   3. DexCexFlashloanStrategy — DEX-CEX spot arb (Balancer V2 0% flashloan)
 *   4. SolanaMultiAmmArbStrategy — Solana memecoin cross-AMM arb (PumpApi)
 *
 * Usage: pnpm --filter @edge/scanner start:all
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig } from '@edge/config';
import { TelegramAlerter } from '@edge/alerts';
import { PnlDb } from '@edge/pnl';
import { SharpeClient } from '@edge/sharpe-client';
import { VooiClient } from '@edge/vooi-client';
import { PumpApiClient } from '@edge/pumpapi-client';
import { PerpFundingStrategy, type PerpFundingAlert } from '../strategies/perp-funding.js';
import { CexHlFundingArbStrategy, type CexHlFundingAlert } from '../strategies/cex-hl-funding-arb.js';
import { DexCexFlashloanStrategy, type DexCexArbAlert } from '../strategies/dex-cex-flashloan.js';
import { SolanaMultiAmmArbStrategy, type SolanaArbAlert } from '../strategies/solana-memmecoin-arb.js';
import { PredictionArbStrategy, type PredictionArbAlert } from '../strategies/prediction-arb.js';
import { SportsArbStrategy, type SportsArbAlert } from '../strategies/sports-arb.js';
import { PendleBorosScanner, type BorosArbAlert } from '../strategies/pendle-boros-scanner.js';
import { TokenizedEquityScanner, type TokenizedEquityAlert } from '../strategies/tokenized-equity-scanner.js';
import { CexLikeDexPriceArbStrategy, type PriceArbAlert } from '../strategies/cexlike-dex-price-arb.js';
import { HlAmmArbScanner, type HlAmmArbAlert } from '../strategies/hl-amm-arb-scanner.js';
import { HlLstArbScanner, type HlLstArbAlert } from '../strategies/hl-lst-arb-scanner.js';
import { GoldArbScanner, type GoldArbAlert } from '../strategies/gold-arb-scanner.js';
import { EquityPerpCrossVenueScanner, type EquityPerpArbAlert } from '../strategies/equity-perp-cross-venue.js';
import { LstYieldComparisonScanner, type LstYieldAlert } from '../strategies/lst-yield-comparison.js';
import { PtKhypeYieldArbScanner, type PtKhypeAlert } from '../strategies/pt-khype-yield-arb.js';
import { PtYieldArbScanner, type PtYieldArbAlert } from '../strategies/pt-yield-arb-scanner.js';
import { EulerLendingArbScanner, type EulerLendingArbAlert } from '../strategies/euler-lending-arb-scanner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

// Load .env
try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch { /* .env not present */ }

const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 60_000);

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Edge-Engine / Multi-Strategy Scanner');
  console.log('═══════════════════════════════════════════════════');
  const cfg = loadConfig(REPO_ROOT);

  if (!cfg.alerts.telegram.botToken || !cfg.alerts.telegram.chatId) {
    console.error('❌ Telegram credentials not set');
    process.exit(1);
  }

  const alerter = new TelegramAlerter({
    botToken: cfg.alerts.telegram.botToken,
    chatId: cfg.alerts.telegram.chatId,
  });
  const pnl = new PnlDb({ path: 'data/edge-engine.sqlite', risk: cfg.risk });

  const sharpe = new SharpeClient({ apiKey: cfg.apis.sharpe?.apiKey });
  const vooi   = new VooiClient({ apiToken: cfg.apis.vooi?.apiToken });
  const pump   = new PumpApiClient({ publicKey: process.env.AGENT_SOLANA_ADDRESS || undefined });

  // Strategy 1: perp funding (any venue)
  const perpFunding = new PerpFundingStrategy(sharpe, vooi, {
    minSpreadApr: 0.08,
    longVenues: ['pacifica', 'paradex', 'binance', 'okx', 'bybit', 'mexc', 'gate', 'hyperliquid'],
    shortVenues: ['hyperliquid', 'dydx', 'binance', 'okx', 'bybit', 'mexc', 'gate'],
    useVooiExecutor: !!cfg.apis.vooi?.apiToken,
    vooiVenueSet: ['hyperliquid', 'lighter', 'aster', 'extended', 'trade.xyz', 'kinetiq', 'robinhood', 'ondo', 'binance', 'bybit', 'mexc', 'gate'],
  });

  // Strategy 2: CEX-HL funding arb
  const cexHlArb = new CexHlFundingArbStrategy(sharpe, vooi, {
    minNetApr: 0.05,
    cexVenues: ['binance', 'okx', 'bybit', 'mexc', 'gate'],
    hlVenueName: 'Hyperliquid',
    useVooiExecutor: !!cfg.apis.vooi?.apiToken,
    vooiVenueSet: ['hyperliquid', 'lighter', 'aster', 'extended', 'trade.xyz', 'kinetiq', 'robinhood', 'ondo', 'binance', 'bybit', 'mexc', 'gate'],
    autoExecute: false,
    maxNotionalUsd: 5000,
    minHlFundingApr: 0.02,
  });

  // Strategy 3: DEX-CEX flashloan
  const dexCexFlashloan = new DexCexFlashloanStrategy(sharpe, {
    minGrossSpreadPct: 0.5,
    maxSizeUsd: 50_000,
    cexVenues: ['binance', 'okx', 'bybit', 'mexc', 'gate'],
    dexVenues: ['uniswap-v3', 'aerodrome', 'camelot', 'sushiswap'],
    flashloanChains: ['arbitrum', 'base', 'optimism', 'polygon', 'ethereum'],
    useBalancer: true,
    useAaveFallback: true,
  });

  // Strategy 4: Solana memecoin arb
  const solanaArb = new SolanaMultiAmmArbStrategy(pump, {
    minSpreadPct: 0.008,
    maxSizeUsd: 200,
    minBurnedLiquidity: 0.5,
    minBondingCurveDepthSol: 10,
    watchlistMints: [],  // empty = discovery mode (not yet implemented)
  });

  // Strategy 5: Prediction market arb
  const predictionArb = new PredictionArbStrategy({
    minDivergencePct: 3.0,
    maxSizeUsd: 2000,
    maxCapitalLockDays: 30,
    platforms: ['polymarket'],
  });

  // Strategy 6: Sportsbook arb
  const sportsArb = new SportsArbStrategy(process.env.ODDS_API_KEY || undefined, {
    minArbPct: 1.0,
    maxSizeUsd: 500,
    sports: ['americanfootball_nfl', 'basketball_nba', 'soccer_epl'],
    regions: ['us', 'uk', 'eu'],
    oddsFormat: 'decimal',
    bookmakers: [],
  });

  // Strategy 7: Pendle Boros funding rate swap arb
  const pendleBoros = new PendleBorosScanner({
    minSpreadApr: 0.5,
    maxSizeUsd: 5000,
    minNotionalOI: 50_000,        // raised from $10k → $50k (filter illiquid)
    minVolume24h: 100_000,        // NEW: require $100k 24h volume
    minDaysToMaturity: 7,         // NEW: skip markets expiring <7d
    minSpreadPersistence: 2,      // NEW: require spread to hold 2+ scans
    platforms: [],
  });

  // Strategy 8: Tokenized equity arb (monitoring-only on Backpack)
  const tokenizedEquity = new TokenizedEquityScanner({
    minActionableSpreadPct: 2.0,
    minActionableDepthUsd: 500,
    markets: ['SPCX.US_USDC', 'SNDK.US_USDC'],
  });

  // Strategy 9: CEX-like DEX price spread arb (VOOI)
  const cexLikeDexArb = new CexLikeDexPriceArbStrategy(vooi, {
    minPriceSpreadPct: 0.5,
    maxSizeUsd: 5000,
    minOpenInterest: 10_000,
    minVolume24h: 100_000,
    venues: [],
    minSpreadPersistence: 2,
  });

  // Strategy 10: HL AMM vs orderbook arb
  const hlAmmArb = new HlAmmArbScanner({
    minSpreadPct: 0.1,
    minPoolLiquidityUsd: 100,
    maxSizeUsd: 5000,
  });

  // Strategy 11: HL LST (kHYPE/WHYPE) carry arb
  const hlLstArb = new HlLstArbScanner({
    minDiscountPct: 0.1,
    maxSizeUsd: 5000,
    preferredFeeTier: 100,
  });

  // Strategy 12: Tokenized gold (PAXG vs XAUT)
  const goldArb = new GoldArbScanner({
    minSpreadPct: 0.3,
    maxSizeUsd: 10_000,
  });

  // Strategy 13: Equity perp cross-venue (HL HIP-3 ↔ Backpack)
  const equityPerpCrossVenue = new EquityPerpCrossVenueScanner({
    minSpreadPct: 0.5,
    maxSizeUsd: 2_000,
  });

  // Strategy 14: LST yield comparison (kHYPE vs vkHYPE vs stHYPE etc.)
  const lstYield = new LstYieldComparisonScanner({
    minYieldSpreadPct: 1.0,
    minTvlUsd: 1_000_000,
  });

  // Strategy 15: PT-kHYPE fixed vs floating yield arb
  const ptKhypeArb = new PtKhypeYieldArbScanner({
    minYieldSpreadPct: 1.0,
    khypeFloatingYieldApr: 2.28,
    maxSizeUsd: 5_000,
  });

  // Strategy 16: PT yield arb across ALL HL LSTs (broader coverage)
  const ptYieldArb = new PtYieldArbScanner({
    minYieldSpreadPct: 3.0,
    minTvlUsd: 500_000,
    maxImpliedApyPct: 50,
    khypeFloatingYieldApr: 2.37,
  });

  // Strategy 17: Euler HL lending arb (cross-vault rate spreads)
  const eulerLendingArb = new EulerLendingArbScanner({
    minSpreadPct: 1.0,
    minLiquidityUsd: 50_000,
    maxSizeUsd: 5_000,
  });

  console.log(`  Strategies: [perp_funding, cex_hl_funding_arb, dex_cex_flashloan, solana_memecoin_arb, prediction_arb, sports_arb, pendle_boros, tokenized_equity, cexlike_dex_price_arb, hl_amm_arb, hl_lst_arb, gold_arb, equity_perp_xvenue, lst_yield, pt_khype_yield, pt_yield_arb, euler_lending_arb]`);
  console.log(`  Scan interval: ${SCAN_INTERVAL_MS / 1000}s`);
  console.log('═══════════════════════════════════════════════════');

  let scanCount = 0;
  const seenOpps = new Map<string, number>();
  const DEDUP_WINDOW_MS = 5 * 60_000;
  // Sports scan is expensive (5 API calls per scan, 500/month quota).
  // Only scan sports every N ticks (default: every 10 ticks = ~10 min at 60s interval).
  const SPORTS_SCAN_EVERY_N_TICKS = Number(process.env.SPORTS_SCAN_EVERY_N_TICKS ?? 10);
  let lastSportsScan = 0;

  async function tick() {
    scanCount++;
    const start = Date.now();
    try {
      // Throttle sports scan to preserve Odds API quota (500/month)
      const shouldScanSports = (scanCount - lastSportsScan) >= SPORTS_SCAN_EVERY_N_TICKS;
      const sportsAlerts = shouldScanSports
        ? await sportsArb.scan().catch(e => { console.warn(`sports failed: ${e.message}`); return [] as SportsArbAlert[]; })
        : [];
      if (shouldScanSports) lastSportsScan = scanCount;

      const [perpAlerts, cexHlAlerts, dexCexAlerts, solanaAlerts, predictionAlerts, borosAlerts, equityAlerts, priceArbAlerts, hlAmmAlerts, hlLstAlerts, goldAlerts, equityXvAlerts, lstYieldAlerts, ptKhypeAlerts, ptYieldArbAlerts, eulerLendingArbAlerts] = await Promise.all([
        perpFunding.scan().catch(e => { console.warn(`perp_funding failed: ${e.message}`); return [] as PerpFundingAlert[]; }),
        cexHlArb.scan().catch(e => { console.warn(`cex_hl failed: ${e.message}`); return [] as CexHlFundingAlert[]; }),
        dexCexFlashloan.scan().catch(e => { console.warn(`dex_cex failed: ${e.message}`); return [] as DexCexArbAlert[]; }),
        solanaArb.scan().catch(e => { console.warn(`solana failed: ${e.message}`); return [] as SolanaArbAlert[]; }),
        predictionArb.scan().catch(e => { console.warn(`prediction failed: ${e.message}`); return [] as PredictionArbAlert[]; }),
        pendleBoros.scan().catch(e => { console.warn(`boros failed: ${e.message}`); return [] as BorosArbAlert[]; }),
        tokenizedEquity.scan().catch(e => { console.warn(`equity failed: ${e.message}`); return [] as TokenizedEquityAlert[]; }),
        cexLikeDexArb.scan().catch(e => { console.warn(`pricewarb failed: ${e.message}`); return [] as PriceArbAlert[]; }),
        hlAmmArb.scan().catch(e => { console.warn(`hl_amm failed: ${e.message}`); return [] as HlAmmArbAlert[]; }),
        hlLstArb.scan().catch(e => { console.warn(`hl_lst failed: ${e.message}`); return [] as HlLstArbAlert[]; }),
        goldArb.scan().catch(e => { console.warn(`gold failed: ${e.message}`); return [] as GoldArbAlert[]; }),
        equityPerpCrossVenue.scan().catch(e => { console.warn(`equity_xv failed: ${e.message}`); return [] as EquityPerpArbAlert[]; }),
        lstYield.scan().catch(e => { console.warn(`lst_yield failed: ${e.message}`); return [] as LstYieldAlert[]; }),
        ptKhypeArb.scan().catch(e => { console.warn(`pt_khype failed: ${e.message}`); return [] as PtKhypeAlert[]; }),
        ptYieldArb.scan().catch(e => { console.warn(`pt_yield failed: ${e.message}`); return [] as PtYieldArbAlert[]; }),
        eulerLendingArb.scan().catch(e => { console.warn(`euler_lending failed: ${e.message}`); return [] as EulerLendingArbAlert[]; }),
      ]);

      const sportsStr = shouldScanSports ? `=${sportsAlerts.length}` : '=skip';
      console.log(`[scan ${scanCount}] perp=${perpAlerts.length} cex_hl=${cexHlAlerts.length} dex_cex=${dexCexAlerts.length} solana=${solanaAlerts.length} pred=${predictionAlerts.length} boros=${borosAlerts.length} equity=${equityAlerts.length} price=${priceArbAlerts.length} hlamm=${hlAmmAlerts.length} hllst=${hlLstAlerts.length} gold=${goldAlerts.length} eqxv=${equityXvAlerts.length} lsty=${lstYieldAlerts.length} ptkh=${ptKhypeAlerts.length} ptya=${ptYieldArbAlerts.length} eulr=${eulerLendingArbAlerts.length} sports${sportsStr} | ${Date.now() - start}ms`);

      // Process perp alerts
      for (const a of perpAlerts.filter(a => a.netApr >= 8).slice(0, 3)) {
        const key = `perp|${a.asset}|${a.longVenue}|${a.shortVenue}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `perp_${a.asset}_${a.longVenue}_${a.shortVenue}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'perp_funding',
          title: `[PERP] ${a.asset} ${a.netApr.toFixed(1)}% APR${a.vooiExecutable ? ' · VOOI-exec' : ''}`,
          body: [
            `Long ${a.longVenue} → Short ${a.shortVenue}`,
            `Net APR: ${a.netApr.toFixed(2)}%`,
            `Price spread: ${a.priceSpreadPct.toFixed(3)}%`,
            `Long OI: $${(a.longOiUsd / 1e6).toFixed(2)}M / Short OI: $${(a.shortOiUsd / 1e6).toFixed(2)}M`,
            `Source: ${a.source} | VOOI: ${a.vooiExecutable ? 'YES' : 'NO'}`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process cex_hl alerts
      for (const a of cexHlAlerts.filter(a => a.netSpreadApr >= 5).slice(0, 2)) {
        const key = `cex_hl|${a.asset}|${a.cexVenue}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `cex_hl_${a.asset}_${a.cexVenue}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'cex_hl_funding_arb',
          title: `[CEX-HL] ${a.asset} ${a.netSpreadApr.toFixed(1)}% APR · ${a.cexVenue}↔HL`,
          body: [
            `Long perp ${a.cexVenue} → Short perp Hyperliquid`,
            `Net spread APR: ${a.netSpreadApr.toFixed(2)}%`,
            `HL funding: ${a.hlFundingApr.toFixed(2)}% / CEX funding: ${a.cexFundingApr.toFixed(2)}%`,
            `CEX OI: $${(a.cexOiUsd / 1e6).toFixed(2)}M / HL OI: $${(a.hlOiUsd / 1e6).toFixed(2)}M`,
            `VOOI atomic: ${a.vooiExecutable ? 'YES' : 'NO (need direct SDK)'}`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process dex_cex alerts
      for (const a of dexCexAlerts.filter(a => a.netProfitUsd >= 20).slice(0, 2)) {
        const key = `dex_cex|${a.asset}|${a.dexVenue}|${a.cexVenue}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `dex_cex_${a.asset}_${a.dexVenue}_${a.cexVenue}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'dex_cex_flashloan',
          title: `[DEX-CEX] ${a.asset} net +$${a.netProfitUsd.toFixed(0)} (${a.netProfitPct.toFixed(2)}%)`,
          body: [
            `Buy ${a.dexVenue} (chain: ${a.dexChain}) → Sell ${a.cexVenue}`,
            `Gross spread: ${a.grossSpreadPct.toFixed(2)}%`,
            `Est. slippage: ${a.estimatedSlippagePct.toFixed(2)}%`,
            `Flashloan fee: ${a.flashloanFeePct.toFixed(2)}% (Balancer V2 0%)`,
            `Gas: $${a.gasUsd.toFixed(2)}`,
            `Net profit: $${a.netProfitUsd.toFixed(2)} on $50,000 flashloan`,
            `Executable: ${a.executable ? 'YES (after AgentVault deploy)' : 'NO (scanner only)'}`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process solana alerts
      for (const a of solanaAlerts.slice(0, 2)) {
        const key = `solana|${a.mint}|${a.buyAmm}|${a.sellAmm}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `solana_${a.mint}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'solana_memecoin_arb',
          title: `[SOL-ARB] ${a.symbol || a.mint.slice(0,8)} +${a.spreadAfterFeesPct.toFixed(2)}% spread`,
          body: [
            `Buy ${a.buyAmm} → Sell ${a.sellAmm}`,
            `Spread: ${a.spreadPct.toFixed(2)}% (after fees: ${a.spreadAfterFeesPct.toFixed(2)}%)`,
            `Est. profit: $${a.estimatedProfitUsd.toFixed(2)} on $200`,
            `Burned liq: ${(a.burnedLiquidity * 100).toFixed(0)}%`,
            `Pool depth: ${a.poolDepthSol.toFixed(0)} SOL`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process prediction alerts
      for (const a of predictionAlerts.slice(0, 2)) {
        const key = `pred|${a.market1Id}|${a.market2Id}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `pred_${a.market1Id}_${a.market2Id}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'prediction_arb',
          title: `[PRED] ${a.eventTitle.slice(0, 50)} div ${a.divergencePct.toFixed(1)}%`,
          body: [
            `Event: ${a.eventTitle}`,
            `${a.venue1}: ${(a.probability1 * 100).toFixed(1)}% YES`,
            `${a.venue2}: ${(a.probability2 * 100).toFixed(1)}% YES`,
            `Divergence: ${a.divergencePct.toFixed(2)}%`,
            `Est. profit: $${a.estimatedProfitUsd.toFixed(2)} on $2000`,
            `Capital lock: ${a.capitalLockDays.toFixed(0)} days`,
            `End date: ${a.endDate}`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process sports alerts
      for (const a of sportsAlerts.slice(0, 3)) {
        const key = `sports|${a.sport}|${a.event}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `sports_${a.sport}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'sports_arb',
          title: `[SPORTS] ${a.event.slice(0, 40)} arb ${a.arbPct.toFixed(1)}%`,
          body: [
            `Event: ${a.event}`,
            `Sport: ${a.sport}`,
            `Arb: ${a.arbPct.toFixed(2)}% (total implied: ${(a.totalImpliedProb * 100).toFixed(1)}%)`,
            `Est. profit: $${a.estimatedProfitUsd.toFixed(2)} on $500 stake`,
            `Sharp book: ${a.hasSharpBook ? 'YES' : 'NO'}`,
            ...a.outcomes.map(o => `  ${o.label}: ${o.bestPrice} @ ${o.bestBook}`),
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process Boros alerts
      for (const a of borosAlerts.slice(0, 3)) {
        const key = `boros|${a.market.marketId}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `boros_${a.market.marketId}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'pendle_boros',
          title: `[BOROS] ${a.market.platform} ${a.market.underlying} spread ${a.spreadApr.toFixed(1)}%`,
          body: [
            `Market: ${a.market.name}`,
            `Mark APR: ${(a.market.markApr * 100).toFixed(2)}%  Floating: ${(a.market.floatingApr * 100).toFixed(2)}%`,
            `Spread: ${a.spreadApr.toFixed(2)}%  Direction: ${a.direction}`,
            `Est. profit: $${a.estimatedProfitUsd.toFixed(2)} on $5000`,
            `Maturity: ${a.daysToMaturity.toFixed(0)} days  OI: $${a.market.notionalOI.toFixed(0)}`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process tokenized equity alerts (only when actionable)
      for (const a of equityAlerts.filter(a => a.actionable).slice(0, 2)) {
        const key = `equity|${a.symbol}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `equity_${a.symbol}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'tokenized_equity',
          title: `[EQUITY] ${a.symbol} basis ${a.basisPct.toFixed(2)}% — ACTIONABLE`,
          body: [
            `Symbol: ${a.symbol}`,
            `Spot: $${a.spotPrice}  Perp: $${a.perpPrice}`,
            `Basis: ${a.basisPct.toFixed(2)}%`,
            `Spot spread: ${a.spotSpreadPct?.toFixed(1)}%  Perp spread: ${a.perpSpreadPct?.toFixed(1)}%`,
            `Spot depth: $${a.spotDepthUsd?.toFixed(0)}  Perp depth: $${a.perpDepthUsd?.toFixed(0)}`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process CexLikeDex price arb alerts
      for (const a of priceArbAlerts.slice(0, 3)) {
        const key = `pricearb|${a.asset}|${a.longVenue}|${a.shortVenue}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `pricearb_${a.asset}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'cexlike_dex_price_arb',
          title: `[PRICE] ${a.asset} ${a.priceSpreadPct.toFixed(1)}% spread`,
          body: [
            `Long ${a.longVenue} $${a.longPrice} → Short ${a.shortVenue} $${a.shortPrice}`,
            `Spread: ${a.priceSpreadPct.toFixed(2)}%  Profit: $${a.estimatedProfitUsd.toFixed(2)}`,
            `Long OI: $${a.longOiUsd.toFixed(0)}  Short OI: $${a.shortOiUsd.toFixed(0)}`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process HL AMM arb alerts
      for (const a of hlAmmAlerts.slice(0, 2)) {
        const key = `hlamm|${a.pair}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `hlamm_${a.pair}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'hl_amm_arb',
          title: `[HLAMM] ${a.pair} ${a.spreadPct.toFixed(2)}% spread`,
          body: [
            `AMM: ${a.ammPrice.toFixed(6)}  Orderbook: ${a.orderbookPrice.toFixed(6)}`,
            `Spread: ${a.spreadPct.toFixed(2)}%  Direction: ${a.direction}`,
            `Pool liq: $${a.poolLiquidityUsd.toFixed(0)}  Profit: $${a.estimatedProfitUsd.toFixed(2)}`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process HL LST arb alerts
      for (const a of hlLstAlerts.slice(0, 2)) {
        const key = `hllst|${a.pair}|${a.feeTier}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `hllst_${a.pair}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'hl_lst_arb',
          title: `[HLLST] ${a.pair} ${a.discountPct.toFixed(2)}% discount`,
          body: [
            `kHYPE price: ${a.khypePrice.toFixed(6)} WHYPE  Discount: ${a.discountPct.toFixed(2)}%`,
            `Net profit: ${a.estimatedProfitPct.toFixed(2)}% = $${a.estimatedProfitUsd.toFixed(2)} on $5k`,
            `Fee tier: ${a.feeTier/10000}%  Flashloan: ${a.flashloanFeePct.toFixed(2)}%`,
            `Liquidity: ${a.poolLiquidity.toString()}`,
            `Carry arb: buy kHYPE, queue 7-9 day withdrawal, receive HYPE`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process gold arb alerts
      for (const a of goldAlerts.slice(0, 2)) {
        const key = `gold|PAXG|XAUT`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `gold_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'gold_arb',
          title: `[GOLD] PAXG/XAUT ${a.spreadPct.toFixed(2)}% spread`,
          body: [
            `PAXG: $${a.paxgPrice.toFixed(2)}  XAUT: $${a.xautPrice.toFixed(2)}`,
            `Spread: ${a.spreadPct.toFixed(2)}%  Profit: $${a.estimatedProfitUsd.toFixed(2)}`,
            `Direction: ${a.direction}`,
            `Venues: ${a.venues.join(', ')}`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process equity perp cross-venue alerts
      for (const a of equityXvAlerts.slice(0, 2)) {
        const key = `eqxv|${a.asset}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `eqxv_${a.asset}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'equity_perp_cross_venue',
          title: `[EQXV] ${a.asset} ${a.spreadPct.toFixed(2)}% spread`,
          body: [
            `Backpack: $${a.backpackPrice.toFixed(2)}  HL: $${a.hlPrice.toFixed(2)}`,
            `Direction: ${a.direction}`,
            `Est. profit: $${a.estimatedProfitUsd.toFixed(2)} on $${2000}`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process LST yield alerts
      for (const a of lstYieldAlerts.slice(0, 3)) {
        const key = `lsty|${a.lst}|${a.expiry}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `lsty_${a.lst}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'lst_yield_comparison',
          title: `[LSTY] ${a.lst} ${a.bestApy.toFixed(2)}% APY (+${a.vsKhypeSpread.toFixed(2)}% vs kHYPE)`,
          body: [
            `LST: ${a.lst}  Expiry: ${a.expiry}`,
            `Underlying APY: ${a.underlyingApy.toFixed(2)}%  Implied APY: ${a.impliedApy.toFixed(2)}%`,
            `Best APY: ${a.bestApy.toFixed(2)}%  vs kHYPE spread: ${a.vsKhypeSpread.toFixed(2)}%`,
            `TVL: $${(a.tvlUsd / 1e6).toFixed(2)}M`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process PT-kHYPE yield arb alerts
      for (const a of ptKhypeAlerts.slice(0, 2)) {
        const key = `ptkh|${a.ptToken}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `ptkh_${a.ptToken}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'pt_khype_yield_arb',
          title: `[PTKH] ${a.ptToken} ${a.impliedFixedYieldApr.toFixed(2)}% APR (spread ${a.yieldSpreadApr.toFixed(2)}%)`,
          body: [
            `PT: ${a.ptToken}  Maturity: ${a.maturity} (${a.daysToMaturity.toFixed(0)}d)`,
            `Implied fixed: ${a.impliedFixedYieldApr.toFixed(2)}%  kHYPE floating: ${a.khypeFloatingYieldApr.toFixed(2)}%`,
            `Direction: ${a.direction}  Est. profit: $${a.estimatedProfitUsd.toFixed(2)}`,
            `Supply: ${a.ptTotalSupply.toFixed(0)} PT`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process PT yield arb alerts (cross-LST)
      for (const a of ptYieldArbAlerts.slice(0, 3)) {
        const key = `ptya|${a.lst}|${a.expiry}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `ptya_${a.lst}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'pt_yield_arb',
          title: `[PTYA] ${a.lst} PT ${a.impliedApyPct.toFixed(2)}% vs kHYPE ${a.vsKhypeSpreadPct > 0 ? '+' : ''}${a.vsKhypeSpreadPct.toFixed(2)}%`,
          body: [
            `LST: ${a.lst}  Maturity: ${a.expiry} (${a.daysToMaturity.toFixed(0)}d)`,
            `Implied: ${a.impliedApyPct.toFixed(2)}%  Underlying: ${a.underlyingApyPct.toFixed(2)}%  Spread: ${a.yieldSpreadPct.toFixed(2)}%`,
            `vs kHYPE funding: ${a.vsKhypeSpreadPct.toFixed(2)}%  Annualized: ${a.annualizedReturnPct.toFixed(2)}%`,
            `Est. profit: $${a.estimatedProfitUsd.toFixed(2)} on $5k  TVL: $${(a.tvlUsd / 1e6).toFixed(2)}M`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process Euler lending arb alerts
      for (const a of eulerLendingArbAlerts.slice(0, 3)) {
        const key = `eulr|${a.assetSymbol}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `eulr_${a.assetSymbol}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'euler_lending_arb',
          title: `[EULR] ${a.assetSymbol} ${a.spreadPct.toFixed(2)}% spread (Euler HL)`,
          body: [
            `Deposit: ${a.depositVault.name} @ ${a.depositVault.apyPct.toFixed(2)}% APR`,
            `Borrow:  ${a.borrowVault.name} @ ${a.borrowVault.apyPct.toFixed(2)}% APR`,
            `Spread:  ${a.spreadPct.toFixed(2)}%  CF: ${a.collateralFactorPct}%`,
            `Est. profit: $${a.estimatedProfitUsd.toFixed(2)}/yr on $${5000} collateral`,
            `Combined liq: $${(a.totalLiquidityUsd / 1000).toFixed(0)}k`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Clean dedup map
      const cutoff = Date.now() - DEDUP_WINDOW_MS;
      for (const [k, ts] of seenOpps.entries()) {
        if (ts < cutoff) seenOpps.delete(k);
      }
    } catch (err) {
      console.error(`[scan ${scanCount}] failed:`, err);
    }
  }

  await tick();
  setInterval(tick, SCAN_INTERVAL_MS);

  // CRITICAL: catch unhandled errors so the scanner doesn't silently exit
  process.on('unhandledRejection', (reason) => {
    console.error(`[${new Date().toISOString()}] UNHANDLED REJECTION:`, reason);
  });
  process.on('uncaughtException', (err) => {
    console.error(`[${new Date().toISOString()}] UNCAUGHT EXCEPTION:`, err);
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await alerter.send('Multi-strategy scanner offline (SIGINT).').catch(() => {});
    pnl.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await alerter.send('Multi-strategy scanner offline (SIGTERM).').catch(() => {});
    pnl.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
