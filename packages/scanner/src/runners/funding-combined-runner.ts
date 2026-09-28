/**
 * Combined perp-funding runner — runs BOTH:
 *   - PerpFundingStrategy (any-venue Sharpe+VOOI cross-validation)
 *   - CexHlFundingArbStrategy (CEX spot + HL perp — higher APR)
 *
 * Fires Telegram alerts on opportunities. Auto-executes via VOOI when:
 *   - VOOI API token configured
 *   - autoExecute flag is true
 *   - RiskGuard preExec passes
 *
 * Usage: pnpm --filter @edge/scanner start:funding-combined
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig } from '@edge/config';
import { TelegramAlerter } from '@edge/alerts';
import { PnlDb } from '@edge/pnl';
import { RiskGuard } from '@edge/risk';
import { SharpeClient } from '@edge/sharpe-client';
import { VooiClient } from '@edge/vooi-client';
import { PerpFundingStrategy, type PerpFundingAlert } from '../strategies/perp-funding.js';
import { CexHlFundingArbStrategy, type CexHlFundingAlert } from '../strategies/cex-hl-funding-arb.js';
import { VooiExecutor } from '../strategies/vooi-executor.js';

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
const MIN_APR_FOR_ALERT = Number(process.env.MIN_APR_FOR_ALERT ?? 8);
const AUTO_EXECUTE = process.env.AUTO_EXECUTE === 'true';
const DRY_RUN = process.env.DRY_RUN !== 'false';   // default true — safe

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Edge-Engine / Combined Perp-Funding Scanner');
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
  const guard = new RiskGuard({ pnl, envelope: cfg.risk, alerter });

  const sharpe = new SharpeClient({ apiKey: cfg.apis.sharpe?.apiKey });
  const vooi   = new VooiClient({ apiToken: cfg.apis.vooi?.apiToken });

  const vooiExecutor = new VooiExecutor({
    vooi,
    alerter,
    minAprToExecute: MIN_APR_FOR_ALERT / 100,
    maxPriceSpreadPct: 1.0,
    defaultNotionalUsd: 5000,
    defaultLeverage: 2,
    maxHoldHours: 72,
    dryRun: DRY_RUN,
  });

  // Strategy 1: any-venue perp funding (existing)
  const perpFundingStrat = new PerpFundingStrategy(sharpe, vooi, {
    minSpreadApr: 0.08,
    longVenues: ['pacifica', 'paradex', 'binance', 'okx', 'bybit', 'mexc', 'gate', 'hyperliquid'],
    shortVenues: ['hyperliquid', 'dydx', 'binance', 'okx', 'bybit', 'mexc', 'gate'],
    useVooiExecutor: !!cfg.apis.vooi?.apiToken,
    vooiVenueSet: ['hyperliquid', 'lighter', 'aster', 'extended', 'trade.xyz', 'kinetiq', 'robinhood', 'ondo', 'binance', 'bybit', 'mexc', 'gate'],
  });

  // Strategy 2: CEX spot + HL perp (new — higher APR)
  const cexHlStrat = new CexHlFundingArbStrategy(sharpe, vooi, {
    minNetApr: 0.05,
    cexVenues: ['binance', 'okx', 'bybit', 'mexc', 'gate'],
    hlVenueName: 'Hyperliquid',
    useVooiExecutor: !!cfg.apis.vooi?.apiToken,
    vooiVenueSet: ['hyperliquid', 'lighter', 'aster', 'extended', 'trade.xyz', 'kinetiq', 'robinhood', 'ondo', 'binance', 'bybit', 'mexc', 'gate'],
    autoExecute: AUTO_EXECUTE,
    maxNotionalUsd: 5000,
    minHlFundingApr: 0.02,
  });

  console.log(`  Strategies: [${perpFundingStrat.id}, ${cexHlStrat.id}]`);
  console.log(`  Min APR for alert: ${MIN_APR_FOR_ALERT}%`);
  console.log(`  Auto-execute: ${AUTO_EXECUTE ? 'ON' : 'OFF'}`);
  console.log(`  Dry-run: ${DRY_RUN ? 'ON (no real orders)' : 'OFF (real orders will be placed!)'}`);
  console.log(`  VOOI executor: ${cfg.apis.vooi?.apiToken ? 'ready' : 'no token'}`);
  console.log(`  Scan interval: ${SCAN_INTERVAL_MS / 1000}s`);
  console.log('═══════════════════════════════════════════════════');

  // Send boot message
  await alerter.info('Combined Perp-Funding Scanner Online',
    [
      `Strategies: \`${perpFundingStrat.id}\`, \`${cexHlStrat.id}\``,
      `Auto-execute: ${AUTO_EXECUTE ? 'ON' : 'OFF'}`,
      `Dry-run: ${DRY_RUN ? 'ON (no real orders)' : 'OFF (real orders!)'}`,
      `Min APR: ${MIN_APR_FOR_ALERT}%`,
      `Scan interval: ${SCAN_INTERVAL_MS / 1000}s`,
      '',
      '_Scanning will begin in 5 seconds._',
    ].join('\n'));

  await new Promise(r => setTimeout(r, 5000));

  let scanCount = 0;
  const seenOpps = new Map<string, number>();
  const DEDUP_WINDOW_MS = 5 * 60_000;

  async function tick() {
    scanCount++;
    const start = Date.now();
    try {
      // Run both strategies in parallel
      const [perpAlerts, cexHlAlerts] = await Promise.all([
        perpFundingStrat.scan(),
        cexHlStrat.scan().catch(err => {
          console.warn(`[scan ${scanCount}] cex_hl_funding_arb failed:`, err);
          return [] as CexHlFundingAlert[];
        }),
      ]);

      const filteredPerp = perpAlerts.filter(a => a.netApr >= MIN_APR_FOR_ALERT);
      const filteredCexHl = cexHlAlerts.filter(a => a.netSpreadApr >= MIN_APR_FOR_ALERT);

      console.log(`[scan ${scanCount}] perp_funding: ${filteredPerp.length} opps | cex_hl: ${filteredCexHl.length} opps | ${Date.now() - start}ms`);

      // Send alerts for new opps (deduplicated)
      const newAlerts: Array<{ key: string; alert: PerpFundingAlert | CexHlFundingAlert; type: 'perp' | 'cex_hl' }> = [];
      for (const a of filteredPerp.slice(0, 3)) {
        const key = `perp|${a.asset}|${a.longVenue}|${a.shortVenue}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) > DEDUP_WINDOW_MS) {
          seenOpps.set(key, Date.now());
          newAlerts.push({ key, alert: a, type: 'perp' });
        }
      }
      for (const a of filteredCexHl.slice(0, 3)) {
        const key = `cex_hl|${a.asset}|${a.cexVenue}`;
        if ((Date.now() - (seenOpps.get(key) ?? 0)) > DEDUP_WINDOW_MS) {
          seenOpps.set(key, Date.now());
          newAlerts.push({ key, alert: a, type: 'cex_hl' });
        }
      }

      for (const { alert, type } of newAlerts) {
        if (type === 'perp') {
          const a = alert as PerpFundingAlert;
          await alerter.sendAlert({
            id: `perp_${a.asset}_${a.longVenue}_${a.shortVenue}_${Date.now()}`,
            ts: Date.now(),
            severity: 'opportunity',
            strategyId: 'perp_funding',
            title: `[PERP] ${a.asset} ${a.netApr.toFixed(1)}% APR${a.vooiExecutable ? ' · VOOI-exec' : ''}`,
            body: [
              `*Long* ${a.longVenue}  →  *Short* ${a.shortVenue}`,
              `Net APR: *${a.netApr.toFixed(2)}%*`,
              `Price spread: ${a.priceSpreadPct.toFixed(3)}%`,
              `Long OI: $${(a.longOiUsd / 1e6).toFixed(2)}M / Short OI: $${(a.shortOiUsd / 1e6).toFixed(2)}M`,
              `Source: \`${a.source}\`  Confidence: ${(a.confidence * 100).toFixed(0)}%`,
              `VOOI: ${a.vooiExecutable ? '✅' : '❌'}`,
            ].join('\n'),
            channels: ['telegram'],
          });

          // Auto-execute if enabled
          if (AUTO_EXECUTE && a.vooiExecutable && cfg.apis.vooi?.apiToken) {
            try {
              await guard.preExec({
                strategyId: 'perp_funding',
                opportunityId: `${a.asset}_${a.longVenue}_${a.shortVenue}`,
                sizedLegs: [],
                gasPriceMedian: 0,
                gasPriceUsed: 0,
              });
              const result = await vooiExecutor.executeArb({
                asset: a.asset,
                longVenue: a.longVenue,
                shortVenue: a.shortVenue,
                notionalUsd: 5000,
                leverage: 2,
              });
              console.log(`  → executed: ${result.orderId} status=${result.status}`);
              pnl.openPosition({
                opportunityId: result.orderId,
                strategyId: 'perp_funding',
                legs: [],
                costBasisUsd: 5000,
              });
            } catch (err) {
              console.warn(`  → exec failed:`, err);
            }
          }
        } else {
          const a = alert as CexHlFundingAlert;
          await alerter.sendAlert({
            id: `cex_hl_${a.asset}_${a.cexVenue}_${Date.now()}`,
            ts: Date.now(),
            severity: 'opportunity',
            strategyId: 'cex_hl_funding_arb',
            title: `[CEX-HL] ${a.asset} ${a.netSpreadApr.toFixed(1)}% APR · ${a.cexVenue}↔Hyperliquid`,
            body: [
              `*Long perp* ${a.cexVenue}  →  *Short perp* Hyperliquid`,
              `Net spread APR: *${a.netSpreadApr.toFixed(2)}%*`,
              `HL funding: ${a.hlFundingApr.toFixed(2)}% APR`,
              `CEX funding: ${a.cexFundingApr.toFixed(2)}% APR`,
              `Price spread: ${a.priceSpreadPct.toFixed(3)}%`,
              `CEX OI: $${(a.cexOiUsd / 1e6).toFixed(2)}M / HL OI: $${(a.hlOiUsd / 1e6).toFixed(2)}M`,
              `Source: \`${a.source}\`  Confidence: ${(a.confidence * 100).toFixed(0)}%`,
              `VOOI atomic exec: ${a.vooiExecutable ? '✅' : '❌ (need direct ccxt+HL SDK)'}`,
              '',
              `_Higher APR than CEX-only spot-perp basis (~0%). HL funding floor = 10.95% APR; CEX funding compressed to ~0%._`,
            ].join('\n'),
            channels: ['telegram'],
          });
        }
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
    await alerter.info('Combined Scanner Offline', 'SIGINT received.').catch(() => {});
    pnl.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await alerter.info('Combined Scanner Offline', 'SIGTERM received.').catch(() => {});
    pnl.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
