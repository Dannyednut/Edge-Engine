/**
 * Perp-funding scanner runner — boots the strategy, polls Sharpe+VOOI
 * every minute, fires Telegram alerts when edges cross threshold.
 *
 * Usage: pnpm --filter @edge/scanner start:funding
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 *   SHARPE_API_KEY (optional — uses public mirror if unset)
 *   VOOI_API_TOKEN (optional — needed for execution, not for scan)
 *   SCAN_INTERVAL_MS (default 60000)
 */

import { loadConfig } from '@edge/config';
import { TelegramAlerter } from '@edge/alerts';
import { PnlDb } from '@edge/pnl';
import { SharpeClient } from '@edge/sharpe-client';
import { VooiClient } from '@edge/vooi-client';
import { PerpFundingStrategy } from '../strategies/perp-funding.js';

// Resolve repo root (4 levels up: runners/ → src/ → scanner/ → packages/ → repo)
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
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
const TOP_N_ALERTS = 5;
const MIN_APR_FOR_ALERT = Number(process.env.MIN_APR_FOR_ALERT ?? 8);

async function main() {
  console.log('── Edge-Engine / Perp-Funding Scanner ────────────');
  const cfg = loadConfig(REPO_ROOT);

  if (!cfg.alerts.telegram.botToken) {
    console.error('❌ TELEGRAM_BOT_TOKEN not set');
    process.exit(1);
  }
  if (!cfg.alerts.telegram.chatId) {
    console.error('❌ TELEGRAM_CHAT_ID not set (run: pnpm --filter @edge/alerts test to discover)');
    process.exit(1);
  }

  const alerter = new TelegramAlerter({
    botToken: cfg.alerts.telegram.botToken,
    chatId: cfg.alerts.telegram.chatId,
  });
  const pnl = new PnlDb({ path: 'data/edge-engine.sqlite', risk: cfg.risk });

  const sharpe = new SharpeClient({ apiKey: cfg.apis.sharpe?.apiKey });
  const vooi   = new VooiClient({ apiToken: cfg.apis.vooi?.apiToken });

  const stratParams = (cfg.strategies as any).perp_funding || {};
  const strategy = new PerpFundingStrategy(sharpe, vooi, {
    minSpreadApr: (stratParams.min_spread_apr ?? 0.08) as number,
    longVenues:   stratParams.long_venues  ?? ['pacifica', 'paradex'],
    shortVenues:  stratParams.short_venues ?? ['hyperliquid', 'dydx'],
    useVooiExecutor: stratParams.use_vooi_executor ?? true,
    vooiVenueSet: ['hyperliquid', 'lighter', 'aster', 'extended', 'trade.xyz', 'kinetiq', 'binance', 'bybit', 'mexc'],
  });

  console.log(`  Strategy: ${strategy.id}`);
  console.log(`  Long venues:  ${stratParams.long_venues?.join(', ')}`);
  console.log(`  Short venues: ${stratParams.short_venues?.join(', ')}`);
  console.log(`  Min APR: ${(stratParams.min_spread_apr ?? 0.08) * 100}%`);
  console.log(`  Scan interval: ${SCAN_INTERVAL_MS}ms`);
  console.log('── Initialising ──────────────────────────────────');

  // Send boot-up message
  await alerter.info('Perp-Funding Scanner Online',
    [
      `Strategy: \`${strategy.id}\``,
      `Long venues:  ${(stratParams.long_venues  ?? []).join(', ')}`,
      `Short venues: ${(stratParams.short_venues ?? []).join(', ')}`,
      `Min APR threshold: ${((stratParams.min_spread_apr ?? 0.08) * 100).toFixed(1)}%`,
      `Scan interval: ${SCAN_INTERVAL_MS / 1000}s`,
      `VOOI executor: ${stratParams.use_vooi_executor ? 'enabled (apiToken=' + (cfg.apis.vooi?.apiToken ? 'set' : 'NOT SET') + ')' : 'disabled'}`,
      '',
      '_Scanning will begin in 5 seconds._',
    ].join('\n'));

  // Wait 5 seconds before first scan
  await new Promise(r => setTimeout(r, 5000));

  let scanCount = 0;
  const seenAssets = new Map<string, number>(); // asset+venue → last alert ts
  const DEDUP_WINDOW_MS = 5 * 60_000;

  async function tick() {
    scanCount++;
    const start = Date.now();
    try {
      const alerts = await strategy.scan();
      const filtered = alerts.filter(a => a.netApr >= MIN_APR_FOR_ALERT);
      const top = filtered.slice(0, TOP_N_ALERTS);
      const newAlerts = top.filter(a => {
        const key = `${a.asset}|${a.longVenue}|${a.shortVenue}`;
        const lastTs = seenAssets.get(key) ?? 0;
        if (Date.now() - lastTs < DEDUP_WINDOW_MS) return false;
        seenAssets.set(key, Date.now());
        return true;
      });

      console.log(`[scan ${scanCount}] ${filtered.length} opps ≥ ${MIN_APR_FOR_ALERT}% APR, ${newAlerts.length} new (of ${alerts.length} total) in ${Date.now() - start}ms`);

      for (const a of newAlerts) {
        await alerter.sendAlert({
          id: `funding_${a.asset}_${a.longVenue}_${a.shortVenue}_${Date.now()}`,
          ts: Date.now(),
          severity: 'opportunity',
          strategyId: strategy.id,
          title: `${a.asset} funding arb · ${a.netApr.toFixed(1)}% APR${a.vooiExecutable ? ' · VOOI-executable' : ''}`,
          body: [
            `*Long* ${a.longVenue}  →  *Short* ${a.shortVenue}`,
            `Net APR: *${a.netApr.toFixed(2)}%*`,
            `Price spread: ${a.priceSpreadPct.toFixed(3)}%`,
            `Long OI: $${(a.longOiUsd / 1e6).toFixed(2)}M`,
            `Short OI: $${(a.shortOiUsd / 1e6).toFixed(2)}M`,
            `Source: \`${a.source}\`  Confidence: ${(a.confidence * 100).toFixed(0)}%`,
            `VOOI executable: ${a.vooiExecutable ? '✅ yes — atomic paired-leg via POST /arbitrage-orders' : '❌ no — would need direct venue SDKs'}`,
            '',
            `_Capital required: $5,000 split across both legs._`,
            `_Capital lock: 7-14 days typical._`,
          ].join('\n'),
          channels: ['telegram'],
        });
      }

      // Clean up old dedup keys
      const cutoff = Date.now() - DEDUP_WINDOW_MS;
      for (const [k, ts] of seenAssets.entries()) {
        if (ts < cutoff) seenAssets.delete(k);
      }
    } catch (err) {
      console.error(`[scan ${scanCount}] failed:`, err);
      await alerter.sendAlert({
        id: `scan_err_${Date.now()}`,
        ts: Date.now(),
        severity: 'warning',
        title: 'Funding scanner error',
        body: `Scan #${scanCount} failed:\n\`${String(err).slice(0, 300)}\``,
        channels: ['telegram'],
      }).catch(() => {});
    }
  }

  // Run first tick immediately, then on interval
  await tick();
  setInterval(tick, SCAN_INTERVAL_MS);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await alerter.info('Perp-Funding Scanner Offline', 'Bot received SIGINT, shutting down.').catch(() => {});
    pnl.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await alerter.info('Perp-Funding Scanner Offline', 'Bot received SIGTERM, shutting down.').catch(() => {});
    pnl.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
