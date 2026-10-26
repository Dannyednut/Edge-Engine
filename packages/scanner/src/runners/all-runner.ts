/**
 * Multi-strategy runner — evaluates configured scanners and dispatches alerts.
 *
 * Instantiation does NOT imply economic validation or execution readiness:
 * incomplete strategy models are monitoring-only or research-only, and this
 * file contains no live-order submission path.
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
import { buildStrategyConfigs } from './strategy-configs.js';
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
import { HlSpotBasisScanner, type HlSpotBasisAlert } from '../strategies/hl-spot-basis-scanner.js';
import { HlpYieldScanner, type HlpYieldAlert } from '../strategies/hlp-yield-scanner.js';

import { DefiLlamaYieldScanner, type YieldPoolAlert } from '../strategies/defillama-yield-scanner.js';
import { RwaTreasuryScanner, type RwaYieldAlert } from '../strategies/rwa-treasury-scanner.js';
import { StablecoinDepegScanner, type DepegAlert } from '../strategies/stablecoin-depeg-scanner.js';
import { LiquidationBackrunScanner, type LiquidationAlert } from '../strategies/liquidation-backrun-scanner.js';
import { OrderbookImbalanceScanner, type OrderbookAlert } from '../strategies/orderbook-imbalance-scanner.js';
import { FundingDivergenceScanner, type FundingDivergenceAlert } from '../strategies/funding-divergence-scanner.js';
import { AirdropFarmingScanner, type AirdropAlert } from '../strategies/airdrop-farming-scanner.js';
import { LeverageLoopScanner, type LeverageLoopAlert } from '../strategies/leverage-loop-scanner.js';
import { WhaleSignalScanner, type WhaleSignalAlert } from '../strategies/whale-signal-scanner.js';
import { CexDexBridgeScanner, type CexDexBridgeAlert } from '../strategies/cex-dex-bridge-scanner.js';
import { CrossDexArbScanner, type CrossDexArbAlert } from '../strategies/cross-dex-arb-scanner.js';

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
    if (k === 'EDGE_EXECUTION_AUTH') continue;
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

  // ─── Config-driven strategy params ────────────────────────────────
  // All strategy constructor params are built by the pure function
  // buildStrategyConfigs() in strategy-configs.ts. This separates config
  // resolution from client creation, making the config mapping unit-testable
  // without starting the trading system. See strategy-configs.ts for the
  // full unit-convention documentation and the list of deliberate
  // corrections vs. the pre-refactor hardcoded values.
  const sc = buildStrategyConfigs(cfg);

  // Strategy 1: perp funding (any venue)
  const perpFunding = new PerpFundingStrategy(sharpe, vooi, sc.perpFunding);

  // Strategy 2: CEX-HL funding arb
  const cexHlArb = new CexHlFundingArbStrategy(sharpe, vooi, sc.cexHlArb);

  // Strategy 3: DEX-CEX flashloan
  const dexCexFlashloan = new DexCexFlashloanStrategy(sharpe, sc.dexCexFlashloan);

  // Strategy 4: Solana memecoin arb
  const solanaArb = new SolanaMultiAmmArbStrategy(pump, sc.solanaArb);

  // Strategy 5: Prediction market arb
  const predictionArb = new PredictionArbStrategy(sc.predictionArb);

  // Strategy 6: Sportsbook arb
  const sportsArb = new SportsArbStrategy(process.env.ODDS_API_KEY || undefined, sc.sportsArb);

  // Strategy 7: Pendle Boros funding rate swap arb
  const pendleBoros = new PendleBorosScanner(sc.pendleBoros);

  // Strategy 8: Tokenized equity arb (monitoring-only on Backpack)
  const tokenizedEquity = new TokenizedEquityScanner(sc.tokenizedEquity);

  // Strategy 9: CEX-like DEX price spread arb (VOOI)
  const cexLikeDexArb = new CexLikeDexPriceArbStrategy(vooi, sc.cexLikeDexArb);

  // Strategy 10: HL AMM vs orderbook arb
  const hlAmmArb = new HlAmmArbScanner(sc.hlAmmArb);

  // Strategy 11: HL LST (kHYPE/WHYPE) carry arb
  const hlLstArb = new HlLstArbScanner(sc.hlLstArb);

  // Strategy 12: Tokenized gold (PAXG vs XAUT)
  const goldArb = new GoldArbScanner(sc.goldArb);

  // Strategy 13: Equity perp cross-venue (HL HIP-3 ↔ Backpack)
  const equityPerpCrossVenue = new EquityPerpCrossVenueScanner(sc.equityPerpCrossVenue);

  // Strategy 14: LST yield comparison (kHYPE vs vkHYPE vs stHYPE etc.)
  const lstYield = new LstYieldComparisonScanner(sc.lstYield);

  // Strategy 15: PT-kHYPE fixed vs floating yield arb
  const ptKhypeArb = new PtKhypeYieldArbScanner(sc.ptKhypeArb);

  // Strategy 16: PT yield arb across ALL HL LSTs (broader coverage)
  const ptYieldArb = new PtYieldArbScanner(sc.ptYieldArb);

  // Strategy 17: Euler HL lending arb (cross-vault rate spreads)
  const eulerLendingArb = new EulerLendingArbScanner(sc.eulerLendingArb);

  // Strategy 18: HL spot vs perp basis arb
  const hlSpotBasis = new HlSpotBasisScanner(sc.hlSpotBasis);

  // Strategy 19: HLP vault yield monitor
  const hlpYield = new HlpYieldScanner(sc.hlpYield);

  // ─── New strategies (migrated from scripts-explore) ────────────────
  const defiLlamaYield = new DefiLlamaYieldScanner(sc.defiLlamaYield);
  const rwaTreasury = new RwaTreasuryScanner(sc.rwaTreasury);
  const stablecoinDepeg = new StablecoinDepegScanner(sc.stablecoinDepeg);
  const liquidationBackrun = new LiquidationBackrunScanner(sc.liquidationBackrun);
  const orderbookImbalance = new OrderbookImbalanceScanner(sc.orderbookImbalance);
  const fundingDivergence = new FundingDivergenceScanner(sc.fundingDivergence);
  const airdropFarming = new AirdropFarmingScanner(sc.airdropFarming);
  const leverageLoop = new LeverageLoopScanner(sc.leverageLoop);
  const whaleSignal = new WhaleSignalScanner(sc.whaleSignal);
  const cexDexBridge = new CexDexBridgeScanner(sc.cexDexBridge);
  const crossDexArb = new CrossDexArbScanner(sc.crossDexArb);

  console.log(`  Strategies: [perp_funding, cex_hl_funding_arb, dex_cex_flashloan, solana_memecoin_arb, prediction_arb, sports_arb, pendle_boros, tokenized_equity, cexlike_dex_price_arb, hl_amm_arb, hl_lst_arb, gold_arb, equity_perp_xvenue, lst_yield, pt_khype_yield, pt_yield_arb, euler_lending_arb, hl_spot_basis, hlp_yield, defillama_yield, rwa_treasury, stablecoin_depeg, liquidation_backrun, orderbook_imbalance, funding_divergence, airdrop_farming, leverage_loop, whale_signal, cex_dex_bridge, cross_dex_arb]`);
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

      const [perpAlerts, cexHlAlerts, dexCexAlerts, solanaAlerts, predictionAlerts, borosAlerts, equityAlerts, priceArbAlerts, hlAmmAlerts, hlLstAlerts, goldAlerts, equityXvAlerts, lstYieldAlerts, ptKhypeAlerts, ptYieldArbAlerts, eulerLendingArbAlerts, hlSpotBasisAlerts, hlpYieldAlerts, defiLlamaAlerts, rwaAlerts, depegAlerts, liquidationAlerts, orderbookAlerts, fundingDivAlerts, airdropAlerts, leverageAlerts, whaleAlerts, bridgeAlerts, crossDexAlerts] = await Promise.all([
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
        hlSpotBasis.scan().catch(e => { console.warn(`hl_spot_basis failed: ${e.message}`); return [] as HlSpotBasisAlert[]; }),
        hlpYield.scan().catch(e => { console.warn(`hlp_yield failed: ${e.message}`); return [] as HlpYieldAlert[]; }),
        defiLlamaYield.scan().catch(e => { console.warn(`defillama failed: ${e.message}`); return [] as YieldPoolAlert[]; }),
        rwaTreasury.scan().catch(e => { console.warn(`rwa failed: ${e.message}`); return [] as RwaYieldAlert[]; }),
        stablecoinDepeg.scan().catch(e => { console.warn(`depeg failed: ${e.message}`); return [] as DepegAlert[]; }),
        liquidationBackrun.scan().catch(e => { console.warn(`liq failed: ${e.message}`); return [] as LiquidationAlert[]; }),
        orderbookImbalance.scan().catch(e => { console.warn(`orderbook failed: ${e.message}`); return [] as OrderbookAlert[]; }),
        fundingDivergence.scan().catch(e => { console.warn(`fund_div failed: ${e.message}`); return [] as FundingDivergenceAlert[]; }),
        airdropFarming.scan().catch(e => { console.warn(`airdrop failed: ${e.message}`); return [] as AirdropAlert[]; }),
        leverageLoop.scan().catch(e => { console.warn(`lev_loop failed: ${e.message}`); return [] as LeverageLoopAlert[]; }),
        whaleSignal.scan().catch(e => { console.warn(`whale failed: ${e.message}`); return [] as WhaleSignalAlert[]; }),
        cexDexBridge.scan().catch(e => { console.warn(`bridge failed: ${e.message}`); return [] as CexDexBridgeAlert[]; }),
        crossDexArb.scan().catch(e => { console.warn(`cross_dex failed: ${e.message}`); return [] as CrossDexArbAlert[]; }),
      ]);

      const sportsStr = shouldScanSports ? `=${sportsAlerts.length}` : '=skip';
      console.log(`[scan ${scanCount}] perp=${perpAlerts.length} cex_hl=${cexHlAlerts.length} dex_cex=${dexCexAlerts.length} solana=${solanaAlerts.length} pred=${predictionAlerts.length} boros=${borosAlerts.length} equity=${equityAlerts.length} price=${priceArbAlerts.length} hlamm=${hlAmmAlerts.length} hllst=${hlLstAlerts.length} gold=${goldAlerts.length} eqxv=${equityXvAlerts.length} lsty=${lstYieldAlerts.length} ptkh=${ptKhypeAlerts.length} ptya=${ptYieldArbAlerts.length} eulr=${eulerLendingArbAlerts.length} hlsp=${hlSpotBasisAlerts.length} hlp=${hlpYieldAlerts.length} dfly=${defiLlamaAlerts.length} rwa=${rwaAlerts.length} depeg=${depegAlerts.length} liq=${liquidationAlerts.length} ob=${orderbookAlerts.length} fundiv=${fundingDivAlerts.length} airdrop=${airdropAlerts.length} levloop=${leverageAlerts.length} whale=${whaleAlerts.length} bridge=${bridgeAlerts.length} crossdex=${crossDexAlerts.length} sports${sportsStr} | ${Date.now() - start}ms`);

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

      // Process cex_hl alerts — EM-STRAT-005 §2: provenance model.
      // Per-leg rates from Sharpe /funding/rates are third-party-sourced
      // (same provider as cross-exchange). Until venue-native corroboration
      // is wired, EVERY alert is non-actionable and MUST use 'info' severity.
      // The alert body explicitly labels the provenance and reference nature.
      for (const a of cexHlAlerts.slice(0, 2)) {
        const key = `cex_hl|${a.asset}|${a.cexVenue}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        const fmtOrNull = (v: number | null, digits = 2) =>
          v === null ? 'UNAVAILABLE' : v.toFixed(digits);
        await alerter.sendAlert({
          id: `cex_hl_${a.asset}_${a.cexVenue}_${Date.now()}`,
          ts: Date.now(),
          severity: a.actionable ? 'opportunity' : 'info',
          strategyId: 'cex_hl_funding_arb',
          title: a.actionable
            ? `[CEX-HL] ${a.asset} ${a.netSpreadApr!.toFixed(1)}% APR · ${a.cexVenue}↔HL`
            : `[CEX-HL-REF] ${a.asset} ${a.cexVenue}↔HL — third-party-sourced (not independently verified)`,
          body: [
            `Long perp ${a.cexVenue} -> Short perp Hyperliquid`,
            a.actionable
              ? `Net spread APR: ${a.netSpreadApr!.toFixed(2)}% (independently corroborated)`
              : `Net spread APR: ${fmtOrNull(a.netSpreadApr)} (third-party-sourced — REFERENCE ONLY)`,
            `HL funding (raw, Sharpe): ${fmtOrNull(a.hlFundingApr)}% / CEX funding (raw, Sharpe): ${fmtOrNull(a.cexFundingApr)}%`,
            `Sharpe netApr (third-party reference): ${fmtOrNull(a.sharpeNetApr)}%`,
            `Provenance: ${a.provenance}`,
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

      // Process CexLikeDex price arb alerts — convergence trades, not instant profit.
      // EM-STRAT-005 §1: this strategy is monitoring-only. Every alert MUST
      // use 'info' severity (never 'opportunity'). estimatedProfitUsd is
      // always null. The observed spread is a SIGNAL, not a verified profit.
      for (const a of priceArbAlerts.slice(0, 3)) {
        const key = `pricearb|${a.asset}|${a.longVenue}|${a.shortVenue}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `pricearb_${a.asset}_${Date.now()}`,
          ts: Date.now(),
          severity: 'info', // EM-STRAT-005 §1: always info (monitoring-only)
          strategyId: 'cexlike_dex_price_arb',
          title: `[PRICE-CONVERGENCE-MONITOR] ${a.asset} ${a.effectiveSpreadPct.toFixed(1)}% spread (monitoring only)`,
          body: [
            `MONITORING ONLY — convergence-economics model not yet implemented`,
            `CONVERGENCE TRADE: result depends on close-out, fees, funding, margin, time`,
            `Long ${a.longVenue} $${a.longPrice} -> Short ${a.shortVenue} $${a.shortPrice}`,
            `Headline: ${a.headlineSpreadPct.toFixed(2)}%  At-size: ${a.atSizeSpreadPct?.toFixed(2) ?? 'UNAVAILABLE'}%  Effective: ${a.effectiveSpreadPct.toFixed(2)}%`,
            `Funding 1h (diagnostic): ${a.fundingSpread1h !== null ? a.fundingSpread1h.toFixed(4) + '%' : 'UNAVAILABLE'}`,
            `Est. profit: UNAVAILABLE (convergence-economics model incomplete)`,
            `Economics complete: ${a.economicsComplete}  Actionable: ${a.actionable}  Monitoring only: ${a.monitoringOnly}`,
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
          title: `[HLLST] ${a.pair} ${a.grossDiscountPct.toFixed(2)}% discount (anchor: ${a.redemptionAnchor.toFixed(4)})`,
          body: [
            `Market price: ${a.marketPrice.toFixed(6)} kHYPE/WHYPE  Anchor: ${a.redemptionAnchor.toFixed(6)}`,
            `Gross discount: ${a.grossDiscountPct.toFixed(2)}%  Net profit: ${a.netProfitPct.toFixed(2)}% = $${a.estimatedProfitUsd.toFixed(2)}`,
            `Withdrawal delay: ${a.withdrawalDelaySec !== null ? a.withdrawalDelaySec + 's' : 'UNAVAILABLE'}  Anchor fresh: ${a.anchorFresh}  Anchor block ts: ${a.anchorBlockTs !== null ? a.anchorBlockTs : 'UNAVAILABLE'}`,
            // EM-STRAT-004: fee tier is in hundredths of a bip (e.g., 100 → 0.01%).
            // Display as pct directly using the corrected conversion (fee/10000).
            `Fee tier: ${a.feeTier} (${a.ammFeePct.toFixed(4)}%)  Flashloan: ${a.flashloanFeePct.toFixed(2)}%`,
            `Liquidity: ${a.poolLiquidity.toString()}`,
            `Carry arb: buy kHYPE, queue withdrawal, receive HYPE at anchor rate`,
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

      // ─── EM-STRAT-014-B2: PT-kHYPE alerts are RESEARCH-ONLY. ───────────
      // ptKhypeAlerts carry `researchOnly: true` (see pt-khype-yield-arb.ts).
      // The scanner fails closed: no validated PT price source is wired, so
      // `ptKhypeAlerts` is empty in production and this loop never executes.
      // Defense-in-depth: even if a future edit injects a price source and
      // alerts flow through, they MUST be dispatched with severity 'info'
      // (NOT 'opportunity') and a [PTKH-RESEARCH] prefix. A research-only
      // alert must never be presented as an actionable economic opportunity.
      // Regression: strategy-labeling.test.ts asserts this presenter block
      // does not assign severity 'opportunity' to pt_khype alerts.
      for (const a of ptKhypeAlerts.slice(0, 2)) {
        // Hard guard: only research-only alerts may pass. If a future edit
        // emits researchOnly: false without re-validating the price source
        // and updating this contract, suppress rather than risk an actionable
        // presentation of an unverified signal.
        if (a.researchOnly !== true) continue;
        const key = `ptkh|${a.ptToken}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `ptkh_${a.ptToken}_${Date.now()}`,
          ts: Date.now(),
          severity: 'info',
          strategyId: 'pt_khype_yield_arb',
          title: `[PTKH-RESEARCH] ${a.ptToken} ${a.impliedFixedYieldApr.toFixed(2)}% APR (spread ${a.yieldSpreadApr.toFixed(2)}%)`,
          body: [
            `RESEARCH-ONLY — not an actionable opportunity. PT price source not validated for operational dispatch.`,
            `PT: ${a.ptToken}  Maturity: ${a.maturity} (${a.daysToMaturity.toFixed(0)}d)`,
            `PT price (kHYPE): ${a.ptPrice.toFixed(4)}  Implied fixed: ${a.impliedFixedYieldApr.toFixed(2)}%  kHYPE floating: ${a.khypeFloatingYieldApr.toFixed(2)}%`,
            `Direction: ${a.direction}  Est. profit: $${a.estimatedProfitUsd.toFixed(2)} (illustrative, not executable)`,
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
      // EM-STRAT-004: Euler alerts are monitoring-only — supply APY, spread,
      // and profit are null (cannot be verified). NEVER display these as
      // verified-zero values; use 'UNAVAILABLE' explicitly. Severity is
      // 'info', NOT 'opportunity'.
      for (const a of eulerLendingArbAlerts.slice(0, 3)) {
        const key = `eulr|${a.assetSymbol}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `eulr_${a.assetSymbol}_${Date.now()}`,
          ts: Date.now(),
          severity: 'info',
          strategyId: 'euler_lending_arb',
          title: `[EULR-MONITOR] ${a.assetSymbol} borrow ${a.depositVault.borrowApyPct.toFixed(2)}% - ${a.borrowVault.borrowApyPct.toFixed(2)}%`,
          body: [
            `MONITORING ONLY — supply APY unavailable, cannot compute spread`,
            `Deposit vault: ${a.depositVault.name} (borrow ${a.depositVault.borrowApyPct.toFixed(2)}%)`,
            `Borrow vault:  ${a.borrowVault.name} (borrow ${a.borrowVault.borrowApyPct.toFixed(2)}%)`,
            `Supply APY (deposit): ${a.depositVault.supplyApyPct === null ? 'UNAVAILABLE' : a.depositVault.supplyApyPct.toFixed(2) + '%'}`,
            `Supply APY (borrow):  ${a.borrowVault.supplyApyPct === null ? 'UNAVAILABLE' : a.borrowVault.supplyApyPct.toFixed(2) + '%'}`,
            `Spread: ${a.spreadPct === null ? 'UNAVAILABLE' : a.spreadPct.toFixed(2) + '%'}`,
            `Profit: ${a.estimatedProfitUsd === null ? 'UNAVAILABLE (cannot estimate)' : '$' + a.estimatedProfitUsd.toFixed(0)}`,
            `Borrowable: ${a.borrowable}  CF: ${a.collateralFactorPct}% (assumed)`,
            `Combined liq: ${a.totalLiquidityUsd !== null ? '$' + (a.totalLiquidityUsd / 1000).toFixed(0) + 'k' : 'UNAVAILABLE'}`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process HL spot basis alerts (only fire for actionable basis, not monitoring)
      for (const a of hlSpotBasisAlerts.filter(a => a.basisPct !== undefined && Math.abs(a.basisPct!) >= 1.0).slice(0, 3)) {
        const key = `hlsp|${a.spotName}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `hlsp_${a.spotName}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'hl_spot_basis',
          title: `[HLSP] ${a.pair} basis ${a.basisPct!.toFixed(2)}%`,
          body: [
            `Spot: ${a.spotName} $${a.spotPrice.toFixed(4)}  Perp: ${a.perpName} $${a.perpPrice!.toFixed(4)}`,
            `Basis: ${a.basisPct!.toFixed(2)}%  Direction: ${a.basisDirection}`,
            `24h volume: $${(a.volume24h / 1000).toFixed(0)}k`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Process HLP yield alerts (ENTRY signal when APR > 15%, WARNING when < -5%)
      for (const a of hlpYieldAlerts) {
        if (a.signal === 'NEUTRAL') continue;  // only alert on ENTRY or WARNING
        const key = `hlp|${a.signal}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `hlp_${a.signal}_${Date.now()}`,
          ts: Date.now(),
          severity: a.signal === 'ENTRY' ? 'opportunity' : 'warning',
          strategyId: 'hlp_yield',
          title: `[HLP] ${a.signal} — 7d APR ${a.apr7d.toFixed(1)}% (TVL $${(a.tvlUsd / 1e6).toFixed(0)}M)`,
          body: [
            `Vault: ${a.vaultName}`,
            `TVL: $${a.tvlUsd.toLocaleString()}`,
            `1d APR: ${a.apr1d.toFixed(2)}%`,
            `7d APR: ${a.apr7d.toFixed(2)}%`,
            `30d APR: ${a.apr30d.toFixed(2)}%`,
            a.signal === 'ENTRY' ? '✅ Good time to deposit — APR above 15%' : '⚠️ Drawdown in progress — avoid depositing',
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // ─── New strategy alerts (migrated from scripts-explore) ─────────

      // Process DefiLlama yield alerts (top 3 by risk-adjusted yield)
      for (const a of defiLlamaAlerts.filter(a => a.apy > 10 && a.riskScore <= 3).slice(0, 3)) {
        const key = `dfly|${a.symbol}|${a.project}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `dfly_${a.symbol}_${a.project}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity' as const,
          strategyId: 'defillama_yield',
          title: `[YIELD] ${a.symbol} ${a.apy.toFixed(1)}% APY on ${a.project}`,
          body: `Chain: ${a.chain}\nTVL: $${(a.tvlUsd / 1e6).toFixed(2)}M\n30d APY: ${a.apy30d.toFixed(1)}%\nRisk: ${a.riskScore}/10\nDaily on $10k: $${a.dailyProfitOn10k.toFixed(2)}`,
          channels: ['telegram'],
        });
      }

      // Process RWA Treasury alerts
      for (const a of rwaAlerts.filter(a => a.apy > 3).slice(0, 2)) {
        const key = `rwa|${a.symbol}|${a.project}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `rwa_${a.symbol}_${Date.now()}`,
          ts: Date.now(),
          severity: 'info' as const,
          strategyId: 'rwa_treasury',
          title: `[RWA] ${a.symbol} ${a.apy.toFixed(2)}% APY — ${a.backingAsset}`,
          body: `Project: ${a.project}\nChain: ${a.chain}\nTVL: $${(a.tvlUsd / 1e6).toFixed(2)}M\nRisk: ${a.riskScore}/10`,
          channels: ['telegram'],
        });
      }

      // Process depeg alerts (only BUY or SHORT, not WATCH)
      for (const a of depegAlerts.filter(a => a.action !== 'WATCH')) {
        const key = `depeg|${a.stablecoin}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `depeg_${a.stablecoin}_${Date.now()}`,
          ts: Date.now(),
          severity: a.riskScore >= 7 ? 'critical' as const : 'warning' as const,
          strategyId: 'stablecoin_depeg',
          title: `[DEPEG] ${a.stablecoin} at $${a.price.toFixed(4)} (${a.depegPct.toFixed(2)}%)`,
          body: `Action: ${a.action}\nPotential profit on $10k: $${a.potentialProfitOn10k.toFixed(0)}\nRisk: ${a.riskScore}/10`,
          channels: ['telegram'],
        });
      }

      // Process liquidation backrun alerts (SQUEEZE or CASCADE only)
      for (const a of liquidationAlerts.filter(a => a.severity !== 'MONITOR')) {
        const key = `liq|${a.coin}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `liq_${a.coin}_${Date.now()}`,
          ts: Date.now(),
          severity: a.severity === 'SQUEEZE_IMMINENT' ? 'critical' as const : 'warning' as const,
          strategyId: 'liquidation_backrun',
          title: `[LIQ] ${a.coin} ${a.direction} — ${a.severity}`,
          body: `Funding: ${a.fundingAnnual.toFixed(0)}/yr\nOI: $${(a.oi / 1e6).toFixed(2)}M\nLiquidator profit: $${(a.liquidatorProfitPotential / 1000).toFixed(1)}k`,
          channels: ['telegram'],
        });
      }

      // Process orderbook imbalance alerts (BULLISH or BEARISH only)
      for (const a of orderbookAlerts.filter(a => a.signal !== 'NEUTRAL')) {
        const key = `ob|${a.coin}|${a.signal}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `ob_${a.coin}_${a.signal}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity' as const,
          strategyId: 'orderbook_imbalance',
          title: `[ORDERBOOK] ${a.coin} ${a.signal} — ${(a.imbalance * 100).toFixed(1)}%`,
          body: `Mid: $${a.midPrice.toFixed(2)}\nBid: $${(a.bidLiquidity / 1e6).toFixed(2)}M / Ask: $${(a.askLiquidity / 1e6).toFixed(2)}M`,
          channels: ['telegram'],
        });
      }

      // Process funding divergence alerts (top 3)
      for (const a of fundingDivAlerts.slice(0, 3)) {
        const key = `fundiv|${a.asset}|${a.type}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `fundiv_${a.asset}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity' as const,
          strategyId: 'funding_divergence',
          title: `[FUND DIV] ${a.asset} ${a.divergence.toFixed(0)}/yr — ${a.type}`,
          body: `Direction: ${a.direction}\nDaily on $5k: $${a.dailyProfitOn5k.toFixed(2)}`,
          channels: ['telegram'],
        });
      }

      // Process whale signal alerts (STRONG only)
      for (const a of whaleAlerts.filter(a => a.signal === 'STRONG').slice(0, 3)) {
        const key = `whale|${a.type}|${a.asset}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `whale_${a.asset}_${a.type}_${Date.now()}`,
          ts: Date.now(),
          severity: a.type === 'TVL_BEARISH' ? 'warning' as const : 'opportunity' as const,
          strategyId: 'whale_signal',
          title: `[WHALE] ${a.asset} ${a.type}`,
          body: `${a.detail}\nAction: ${a.action}\nTVL: $${(a.tvlUsd / 1e6).toFixed(2)}M`,
          channels: ['telegram'],
        });
      }

      // Process CEX-DEX bridge alerts (top 3)
      for (const a of bridgeAlerts.slice(0, 3)) {
        const key = `bridge|${a.asset}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: `bridge_${a.asset}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity' as const,
          strategyId: 'cex_dex_bridge',
          title: `[BRIDGE] ${a.asset} ${a.spreadPct.toFixed(3)}% spread`,
          body: `Buy: ${a.buyVenue} @ $${a.buyPrice.toFixed(4)}\nSell: ${a.sellVenue} @ $${a.sellPrice.toFixed(4)}\nNet on $10k: $${a.netProfitOn10k.toFixed(2)}`,
          channels: ['telegram'],
        });
      }

      // Process cross-DEX price-divergence alerts (monitor-only).
      // Public pool prices and reserves are discovery data, not executable quotes.
      for (const a of crossDexAlerts.slice(0, 3)) {
        const key = 'crossdex|' + a.pairKey + '|' + a.dex1PoolId + '|' + a.dex2PoolId;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) < DEDUP_WINDOW_MS) continue;
        seenOpps.set(key, Date.now());
        await alerter.sendAlert({
          id: 'crossdex_' + a.pairKey + '_' + Date.now(),
          ts: Date.now(),
          severity: 'info',
          strategyId: 'cross_dex_arb',
          title: '[CROSS-DEX-MONITOR] ' + a.pair + ' ' + a.spreadPct.toFixed(2) + '% gross reference divergence',
          body: [
            'MONITORING ONLY — not a verified arbitrage or executable route',
            a.dex1Name + ': ' + a.dex1Price.toPrecision(8) + ' ' + a.priceBasis + ' (reserve $' + a.reserve1Usd.toFixed(0) + ')',
            a.dex2Name + ': ' + a.dex2Price.toPrecision(8) + ' ' + a.priceBasis + ' (reserve $' + a.reserve2Usd.toFixed(0) + ')',
            'Gross reference-price divergence: ' + a.spreadPct.toFixed(3) + '%',
            'Net profit: UNAVAILABLE; pool-specific fees, trade-size slippage, gas and route execution are not modeled.',
            'Token IDs: ' + a.token0Id + ' | ' + a.token1Id,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Clean dedup map
      const cutoff = Date.now() - DEDUP_WINDOW_MS;
      for (const [k, ts] of seenOpps.entries()) {
        if (ts < cutoff) seenOpps.delete(k);
      }

      // ─── EM-STRAT-004 / EM-STRAT-005 / EM-STRAT-014-B2: Non-actionable strategy enforcement ─
      // airdropAlerts and leverageAlerts carry `researchOnly: true` — they
      // are based on static campaign/rate tables, NOT live market data.
      // eulerLendingArbAlerts carry `monitoringOnly: true` — supply APY
      // cannot be verified, so no actionable spread/profit can be computed.
      // priceArbAlerts (CexLikeDex) carry `monitoringOnly: true` (EM-STRAT-005 §1)
      // — the convergence-economics model is incomplete; no verified profit
      // estimate is produced.
      // ptKhypeAlerts carry `researchOnly: true` (EM-STRAT-014-B2) — no
      // validated PT price source is wired and all discovered instruments are
      // expired; the scanner fails closed. Any emitted alert is research-only.
      //
      // Policy: NONE of these alerts may be sent through `alerter.sendAlert()`
      // with `severity: 'opportunity'` (or 'critical'). They are dispatched
      // above with 'info' severity only. The per-scan log line records their
      // counts for observability.
      //
      // Regression tests in `strategy-labeling.test.ts` verify:
      //   1. airdropAlerts[i].researchOnly === true
      //   2. leverageAlerts[i].researchOnly === true
      //   3. eulerLendingArbAlerts[i].monitoringOnly === true
      //   4. priceArbAlerts[i].monitoringOnly === true (EM-STRAT-005 §1)
      //   5. ptKhypeAlerts[i].researchOnly === true (EM-STRAT-014-B2)
      //   6. This file does not call alerter.sendAlert() with severity
      //      'opportunity' for any of those five alert types.
      void airdropAlerts;       // observed but never alerted as opportunity
      void leverageAlerts;      // observed but never alerted as opportunity
      void eulerLendingArbAlerts; // monitoring-only: handled above with 'info' severity
      // priceArbAlerts are dispatched above with 'info' severity (monitoring-only)
      // ptKhypeAlerts are dispatched above with 'info' severity (research-only, EM-STRAT-014-B2)
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
    console.log(`\n[${new Date().toISOString()}] SIGINT received, shutting down...`);
    await alerter.send('Multi-strategy scanner offline (SIGINT).').catch(() => {});
    pnl.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    console.log(`[${new Date().toISOString()}] SIGTERM received, shutting down...`);
    await alerter.send('Multi-strategy scanner offline (SIGTERM).').catch(() => {});
    pnl.close();
    process.exit(0);
  });
  // Detect SIGHUP (terminal disconnect) — common when running in background
  process.on('SIGHUP', () => {
    console.log(`[${new Date().toISOString()}] SIGHUP received — ignoring (background mode)`);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
