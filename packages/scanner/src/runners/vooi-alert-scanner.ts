/**
 * VooiAlertScanner — monitors VOOI for new high-APR perp funding opportunities.
 *
 * Sends Telegram alerts when:
 *   - New opportunity appears with APR > 500%
 *   - Existing opportunity's APR increases by >100% (surge)
 *   - Top 10 daily profit total changes by >20%
 *
 * Usage: pnpm --filter @edge/scanner start:vooi-alerts
 * (runs as a loop, checking every 5 minutes)
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { VooiClient } from '@edge/vooi-client';
import { TelegramAlerter } from '@edge/alerts';
import { getAliasInfo } from '../lib/alias-ticker-map.js';

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

const SCAN_INTERVAL_MS = 5 * 60_000; // 5 minutes
const MIN_ALERT_APR = 500; // only alert on >500% APR
const SURGE_THRESHOLD = 100; // alert if APR increases by >100%

interface OppTracker {
  asset: string;
  apr: number;
  longVenue: string;
  shortVenue: string;
  longOi: number;
  shortOi: number;
  dailyProfit: number;
  firstSeen: number;
}

async function main() {
  console.log('[vooi-alerts] started — scanning every 5 min for >500% APR opportunities');

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required');
    process.exit(1);
  }

  const alerter = new TelegramAlerter({ botToken, chatId });
  const vooi = new VooiClient({ apiToken: process.env.VOOI_API_TOKEN });

  const seenOpps = new Map<string, OppTracker>();

  async function scan() {
    try {
      const r = await vooi.scanArbitrage({
        minFundingSpread: 0,
        minOpenInterest: 100_000,
        notionalUsd: 5000,
        orderBy: 'fundingSpread1h',
        orderDirection: 'desc',
        limit: 50,
      });

      const currentTop: Array<{asset: string, name: string, apr: number, daily: number, longVenue: string, shortVenue: string, longOi: number, shortOi: number}> = [];

      for (const item of r.items) {
        const best = item.pairs[0];
        if (!best) continue;
        const longOi = Number(best.long.openInterest) * Number(best.long.price);
        const shortOi = Number(best.short.openInterest) * Number(best.short.price);
        if (longOi < 100_000 || shortOi < 100_000) continue;
        const apr = best.fundingSpread1h * 24 * 365 * 100;
        if (apr < 100) continue; // track all >100% APR

        const info = getAliasInfo(item.asset);
        const name = info ? `${info.realTicker} (${info.realName})` : item.asset;

        currentTop.push({
          asset: item.asset,
          name,
          apr,
          daily: (apr / 100 / 365) * 5000,
          longVenue: best.long.exchange,
          shortVenue: best.short.exchange,
          longOi, shortOi,
        });
      }

      currentTop.sort((a, b) => b.daily - a.daily);

      // Check for NEW high-APR opportunities (>500%)
      for (const o of currentTop) {
        if (o.apr < MIN_ALERT_APR) continue;
        const key = `${o.asset}|${o.longVenue}|${o.shortVenue}`;
        const prev = seenOpps.get(key);

        if (!prev) {
          // NEW opportunity
          seenOpps.set(key, {
            asset: o.asset, apr: o.apr,
            longVenue: o.longVenue, shortVenue: o.shortVenue,
            longOi: o.longOi, shortOi: o.shortOi,
            dailyProfit: o.daily,
            firstSeen: Date.now(),
          });

          // Alert only if it's truly new (not seen in last 30 min)
          await alerter.sendAlert({
            id: `vooi_new_${o.asset}_${Date.now()}`,
            ts: Date.now(),
            severity: 'opportunity',
            strategyId: 'vooi_perp_funding',
            title: `[VOOI-NEW] ${o.name.slice(0, 30)} ${o.apr.toFixed(0)}% APR`,
            body: [
              `Asset: ${o.name}`,
              `Pair: ${o.longVenue} -> ${o.shortVenue}`,
              `APR: ${o.apr.toFixed(0)}%  Daily: $${o.daily.toFixed(0)}/5k`,
              `OI: $${(o.longOi / 1e6).toFixed(0)}M / $${(o.shortOi / 1e6).toFixed(0)}M`,
              `Execution: VOOI atomic paired-leg`,
            ].join('\n'),
            channels: ['telegram'],
          }).catch(() => {});
        } else if (o.apr > prev.apr + SURGE_THRESHOLD) {
          // SURGE — APR increased by >100%
          const surge = o.apr - prev.apr;
          prev.apr = o.apr;

          await alerter.sendAlert({
            id: `vooi_surge_${o.asset}_${Date.now()}`,
            ts: Date.now(),
            severity: 'opportunity',
            strategyId: 'vooi_perp_funding',
            title: `[VOOI-SURGE] ${o.name.slice(0, 30)} +${surge.toFixed(0)}% APR (now ${o.apr.toFixed(0)}%)`,
            body: [
              `Asset: ${o.name}`,
              `APR surged: ${(prev.apr - surge).toFixed(0)}% -> ${o.apr.toFixed(0)}%`,
              `Daily: $${o.daily.toFixed(0)}/5k`,
              `Pair: ${o.longVenue} -> ${o.shortVenue}`,
            ].join('\n'),
            channels: ['telegram'],
          }).catch(() => {});
        } else {
          // Update tracker
          prev.apr = o.apr;
          prev.dailyProfit = o.daily;
        }
      }

      // Clean old entries (not seen in last 30 min)
      const cutoff = Date.now() - 30 * 60_000;
      for (const [key, tracker] of seenOpps.entries()) {
        const stillExists = currentTop.some(o => `${o.asset}|${o.longVenue}|${o.shortVenue}` === key);
        if (!stillExists && tracker.firstSeen < cutoff) {
          seenOpps.delete(key);
        }
      }

      console.log(`[vooi-alerts] scan complete — tracking ${seenOpps.size} opps, top: ${currentTop[0]?.name || 'none'} at ${currentTop[0]?.apr.toFixed(0) || 0}% APR`);
    } catch (e: any) {
      console.error(`[vooi-alerts] scan failed: ${e.message}`);
    }
  }

  // Initial scan
  await scan();

  // Loop every 5 minutes
  setInterval(scan, SCAN_INTERVAL_MS);

  process.on('SIGINT', () => {
    console.log('\n[vooi-alerts] shutting down...');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
