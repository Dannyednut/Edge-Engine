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

  console.log(`  Strategies: [perp_funding, cex_hl_funding_arb, dex_cex_flashloan, solana_memecoin_arb, prediction_arb, sports_arb]`);
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

      const [perpAlerts, cexHlAlerts, dexCexAlerts, solanaAlerts, predictionAlerts] = await Promise.all([
        perpFunding.scan().catch(e => { console.warn(`perp_funding failed: ${e.message}`); return [] as PerpFundingAlert[]; }),
        cexHlArb.scan().catch(e => { console.warn(`cex_hl failed: ${e.message}`); return [] as CexHlFundingAlert[]; }),
        dexCexFlashloan.scan().catch(e => { console.warn(`dex_cex failed: ${e.message}`); return [] as DexCexArbAlert[]; }),
        solanaArb.scan().catch(e => { console.warn(`solana failed: ${e.message}`); return [] as SolanaArbAlert[]; }),
        predictionArb.scan().catch(e => { console.warn(`prediction failed: ${e.message}`); return [] as PredictionArbAlert[]; }),
      ]);

      const sportsStr = shouldScanSports ? `=${sportsAlerts.length}` : '=skip';
      console.log(`[scan ${scanCount}] perp=${perpAlerts.length} cex_hl=${cexHlAlerts.length} dex_cex=${dexCexAlerts.length} solana=${solanaAlerts.length} pred=${predictionAlerts.length} sports${sportsStr} | ${Date.now() - start}ms`);

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
