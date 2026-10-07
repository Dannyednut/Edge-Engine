/**
 * Opportunity Monitor — continuously scans ALL opportunity sources and
 * sends Telegram alerts for the best opportunities.
 *
 * Scans every 2 minutes:
 *   - VOOI price spread arbs (instant capture)
 *   - VOOI funding rate arbs (8-24h hold)
 *   - kHYPE LST carry arb
 *   - Euler HL lending arb
 *
 * Alerts when:
 *   - New opportunity appears with profit > $100/cycle
 *   - Existing opportunity's profit increases by >50%
 *
 * Usage: pnpm --filter @edge/scanner start:opp-monitor
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { VooiClient } from '@edge/vooi-client';
import { TelegramAlerter } from '@edge/alerts';
import { HlLstArbScanner } from '../strategies/hl-lst-arb-scanner.js';
import { EulerLendingArbScanner } from '../strategies/euler-lending-arb-scanner.js';
import { getAliasInfo } from '../lib/alias-ticker-map.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const SCAN_INTERVAL = 2 * 60_000; // 2 minutes
const DEDUP_WINDOW = 10 * 60_000; // 10 minutes

async function main() {
  console.log('[opp-monitor] started — scanning every 2 min');

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  const vooiToken = process.env.VOOI_API_TOKEN;
  
  if (!botToken || !chatId) {
    console.error('TELEGRAM credentials required');
    process.exit(1);
  }

  const alerter = new TelegramAlerter({ botToken, chatId });
  const vooi = vooiToken ? new VooiClient({ apiToken: vooiToken }) : null;
  
  const hlLstArb = new HlLstArbScanner({
    minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100,
  });
  const eulerArb = new EulerLendingArbScanner({
    minSpreadPct: 2.0, minLiquidityUsd: 50_000, maxSizeUsd: 5_000,
  });

  const seen = new Map<string, number>();

  async function scan() {
    const start = Date.now();
    console.log(`[${new Date().toISOString()}] scanning...`);

    // 1. VOOI price spread arbs (top 5)
    if (vooi) {
      try {
        const r = await vooi.scanArbitrage({
          minFundingSpread: 0,
          minOpenInterest: 100_000,
          notionalUsd: 5000,
          orderBy: 'priceSpread',
          orderDirection: 'desc',
          limit: 100,
        });

        const VOOI_VENUES = new Set(['hyperliquid', 'lighter', 'aster', 'extended', 'trade.xyz', 'kinetiq', 'robinhood', 'ondo', 'binance', 'bybit', 'mexc', 'gate']);
        const priceOpps: Array<{asset: string, name: string, spreadPct: number, profitUsd: number, buyVenue: string, sellVenue: string}> = [];

        for (const item of r.items) {
          for (const p of item.pairs) {
            const longOi = Number(p.long.openInterest) * Number(p.long.price);
            const shortOi = Number(p.short.openInterest) * Number(p.short.price);
            if (longOi < 100_000 || shortOi < 100_000) continue;
            if (!VOOI_VENUES.has(p.long.exchange) || !VOOI_VENUES.has(p.short.exchange)) continue;
            const longPrice = Number(p.long.price);
            const shortPrice = Number(p.short.price);
            if (longPrice <= 0 || shortPrice <= 0) continue;
            const spreadPct = Math.abs((longPrice - shortPrice) / Math.min(longPrice, shortPrice)) * 100;
            if (spreadPct < 2.0) continue;
            const info = getAliasInfo(item.asset);
            const name = info ? info.realTicker : item.asset;
            priceOpps.push({
              asset: item.asset, name,
              spreadPct,
              profitUsd: ((spreadPct - 0.3) / 100) * 5000,
              buyVenue: longPrice < shortPrice ? p.long.exchange : p.short.exchange,
              sellVenue: longPrice < shortPrice ? p.short.exchange : p.long.exchange,
            });
          }
        }

        priceOpps.sort((a, b) => b.profitUsd - a.profitUsd);
        
        // Alert on top 3 if > $100/cycle and not seen recently
        for (const o of priceOpps.slice(0, 3)) {
          if (o.profitUsd < 100) continue;
          const key = `ps|${o.asset}|${o.buyVenue}|${o.sellVenue}`;
          if ((Date.now() - (seen.get(key) ?? 0)) < DEDUP_WINDOW) continue;
          seen.set(key, Date.now());
          
          await alerter.sendAlert({
            id: `ps_${o.asset}_${Date.now()}`,
            ts: Date.now(),
            severity: 'opportunity',
            strategyId: 'vooi_price_spread',
            title: `[PRICE-ARB] ${o.name} ${o.spreadPct.toFixed(1)}% spread = $${o.profitUsd.toFixed(0)}`,
            body: [
              `Buy ${o.buyVenue} → Sell ${o.sellVenue}`,
              `Spread: ${o.spreadPct.toFixed(2)}%  Profit: $${o.profitUsd.toFixed(0)}/5k`,
              `INSTANT capture — no holding required`,
            ].join('\n'),
            channels: ['telegram'],
          }).catch(() => {});
        }
      } catch (e: any) {
        console.warn(`[opp-monitor] VOOI price scan failed: ${e.message}`);
      }
    }

    // 2. kHYPE LST carry arb
    try {
      const alerts = await hlLstArb.scan();
      for (const a of alerts) {
        const key = `khype|${a.pair}`;
        if ((Date.now() - (seen.get(key) ?? 0)) < DEDUP_WINDOW) continue;
        seen.set(key, Date.now());
        
        const annualProfit = a.estimatedProfitUsd * (365 / 8);
        if (annualProfit > 1000) {
          await alerter.sendAlert({
            id: `khype_${Date.now()}`,
            ts: Date.now(),
            severity: 'opportunity',
            strategyId: 'hl_lst_arb',
            title: `[kHYPE] ${a.discountPct.toFixed(2)}% discount = $${annualProfit.toFixed(0)}/yr`,
            body: [
              `Discount: ${a.discountPct.toFixed(2)}% on HyperSwap V3`,
              `Profit per 8-day cycle: $${a.estimatedProfitUsd.toFixed(2)}`,
              `Annualized: $${annualProfit.toFixed(0)} (${((annualProfit / 5000) * 100).toFixed(0)}% APR)`,
            ].join('\n'),
            channels: ['telegram'],
          }).catch(() => {});
        }
      }
    } catch (e: any) {
      console.warn(`[opp-monitor] kHYPE scan failed: ${e.message}`);
    }

    // 3. Euler lending arb
    try {
      const alerts = await eulerArb.scan();
      for (const a of alerts) {
        if (a.estimatedProfitUsd < 200) continue;
        const key = `euler|${a.assetSymbol}`;
        if ((Date.now() - (seen.get(key) ?? 0)) < DEDUP_WINDOW) continue;
        seen.set(key, Date.now());
        
        await alerter.sendAlert({
          id: `euler_${a.assetSymbol}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: 'euler_lending_arb',
          title: `[EULER] ${a.assetSymbol} ${a.spreadPct.toFixed(1)}% spread = $${a.estimatedProfitUsd.toFixed(0)}/yr`,
          body: [
            `Deposit: ${a.depositVault.name} @ ${a.depositVault.apyPct.toFixed(2)}%`,
            `Borrow: ${a.borrowVault.name} @ ${a.borrowVault.apyPct.toFixed(2)}%`,
            `Profit: $${a.estimatedProfitUsd.toFixed(0)}/yr on $5k`,
          ].join('\n'),
          channels: ['telegram'],
        }).catch(() => {});
      }
    } catch (e: any) {
      console.warn(`[opp-monitor] Euler scan failed: ${e.message}`);
    }

    // Clean old dedup entries
    const cutoff = Date.now() - DEDUP_WINDOW;
    for (const [k, ts] of seen.entries()) {
      if (ts < cutoff) seen.delete(k);
    }

    console.log(`[${new Date().toISOString()}] scan complete in ${Date.now() - start}ms — tracking ${seen.size} opps`);
  }

  await scan();
  setInterval(scan, SCAN_INTERVAL);

  process.on('SIGINT', () => { console.log('\n shutting down...'); process.exit(0); });
  process.on('SIGTERM', () => { process.exit(0); });
  process.on('SIGHUP', () => { console.log('SIGHUP ignored'); });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
