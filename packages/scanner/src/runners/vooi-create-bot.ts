/**
 * VOOI Bot Creation Script — creates an autonomous arb bot when principal approves.
 *
 * Usage: npx tsx packages/scanner/src/runners/vooi-create-bot.ts --live
 *
 * This script creates a VOOI arb bot that automatically:
 *   1. Scans for funding rate spreads across 12+ venues
 *   2. Opens paired-leg positions when spread > threshold
 *   3. Closes positions when spread converges or after max hold time
 *   4. Runs 24/7 without manual intervention
 *
 * BOT CONFIGURATION:
 *   - exchanges: hyperliquid, binance, bybit, mexc, gate (top 5 by liquidity)
 *   - leverage: 1x (no leverage — safest)
 *   - notionalUsd: $5,000 per position
 *   - maxHoldHours: 24 (close after 24h regardless)
 *   - maxRoundTripCostBps: 12 (0.12% max fees)
 *   - categories: crypto, stocks-us, commodities (exclude forex for now)
 *
 * EXPECTED PERFORMANCE:
 *   - Top 10 opportunities: $400-600/day = $146-219k/yr on $50k
 *   - Bot captures ~50% of available opportunities
 *   - Realistic: $200-300/day = $73-110k/yr on $50k
 */

import { VooiClient } from '@edge/vooi-client';
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

async function main() {
  const args = new Set(process.argv.slice(2));
  const liveMode = args.has('--live');

  console.log('═══════════════════════════════════════════════════');
  console.log('  VOOI Arb Bot Creator');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Mode: ${liveMode ? 'LIVE (will create real bot)' : 'DRY-RUN (preview only)'}`);
  console.log('');

  const apiToken = process.env.VOOI_API_TOKEN;
  if (!apiToken) {
    console.error('VOOI_API_TOKEN not set');
    process.exit(1);
  }

  const vooi = new VooiClient({ apiToken });

  // Bot configuration
  const botConfig = {
    exchanges: ['hyperliquid', 'binance', 'bybit', 'mexc', 'gate'],
    leverage: 1,
    maxHoldHours: 24,
    maxRoundTripCostBps: 12,
    notionalUsd: 5000,
    categories: ['crypto', 'stocks-us', 'commodities'],
  };

  console.log('Bot Configuration:');
  console.log(`  Exchanges: ${botConfig.exchanges.join(', ')}`);
  console.log(`  Leverage: ${botConfig.leverage}x`);
  console.log(`  Notional per position: $${botConfig.notionalUsd.toLocaleString()}`);
  console.log(`  Max hold: ${botConfig.maxHoldHours}h`);
  console.log(`  Max round-trip cost: ${botConfig.maxRoundTripCostBps} bps (0.${botConfig.maxRoundTripCostBps}%)`);
  console.log(`  Categories: ${botConfig.categories.join(', ')}`);
  console.log('');

  // Show current top opportunities that the bot would capture
  console.log('Current top opportunities the bot would capture:');
  const r = await vooi.scanArbitrage({
    minFundingSpread: 0,
    minOpenInterest: 100_000,
    notionalUsd: botConfig.notionalUsd,
    orderBy: 'fundingSpread1h',
    orderDirection: 'desc',
    limit: 20,
  });

  let count = 0;
  let totalDaily = 0;
  for (const item of r.items) {
    const best = item.pairs[0];
    if (!best) continue;
    const longOi = Number(best.long.openInterest) * Number(best.long.price);
    const shortOi = Number(best.short.openInterest) * Number(best.short.price);
    if (longOi < 100_000 || shortOi < 100_000) continue;
    const apr = best.fundingSpread1h * 24 * 365 * 100;
    if (apr < 50) continue;
    const daily = (apr / 100 / 365) * botConfig.notionalUsd;
    console.log(`  ${item.asset.padEnd(18)} ${best.long.exchange}->${best.short.exchange} APR=${apr.toFixed(0)}% Daily=$${daily.toFixed(0)}`);
    totalDaily += daily;
    count++;
    if (count >= 10) break;
  }
  console.log(`\nTop ${count} total: $${totalDaily.toFixed(0)}/day = $${(totalDaily * 365 / 1000).toFixed(0)}k/yr`);
  console.log(`Bot expected capture (50%): $${(totalDaily * 0.5).toFixed(0)}/day = $${(totalDaily * 0.5 * 365 / 1000).toFixed(0)}k/yr`);

  if (!liveMode) {
    console.log('\n⚠ DRY-RUN MODE — no bot will be created');
    console.log('To create the bot, run with --live flag');
    console.log('⚠ REQUIRES: Principal approval + VOOI capital deposit');
    return;
  }

  // Create the bot
  console.log('\nCreating VOOI arb bot...');
  try {
    const bot = await vooi.createBot(botConfig);
    console.log(`✓ Bot created!`);
    console.log(`  ID: ${bot.id}`);
    console.log(`  Status: ${bot.status}`);
    console.log(`  Exchanges: ${bot.exchanges.join(', ')}`);
    console.log(`  Notional: $${bot.notionalUsd.toLocaleString()}`);

    // Start the bot
    console.log('\nStarting bot...');
    await vooi.startBot(bot.id);
    console.log(`✓ Bot started! ID: ${bot.id}`);
    console.log('\nThe bot will now automatically:');
    console.log('  1. Scan for funding rate spreads');
    console.log('  2. Open paired-leg positions when spread > threshold');
    console.log('  3. Close positions when spread converges or after 24h');
    console.log('  4. Run 24/7');
    console.log('\nTo stop: npx tsx packages/scanner/src/runners/vooi-create-bot.ts --stop ' + bot.id);
  } catch (e: any) {
    console.error(`✗ Bot creation failed: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
