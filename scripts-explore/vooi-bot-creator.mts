/**
 * VOOI Bot Creator
 * 
 * Creates a VOOI arbitrage bot that:
 * 1. Continuously scans for price spread opportunities
 * 2. Automatically places atomic paired orders
 * 3. Includes builder code for rebate
 * 4. Tracks all executions
 * 
 * This is NOT paper trading — this creates a REAL bot via VOOI's bot API
 * that executes when capital is available.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { VooiClient } from '../packages/vooi-client/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const BOT_LOG = '/home/z/my-project/download/vooi-bots.json';

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  VOOI Bot Creator — Real Automated Trading Bot');
  console.log('═══════════════════════════════════════════════════\n');

  const vooiToken = process.env.VOOI_API_TOKEN;
  const agentAddress = process.env.AGENT_EVM_ADDRESS;

  if (!vooiToken) {
    console.log('❌ VOOI_API_TOKEN not set');
    return;
  }

  const vooi = new VooiClient({ apiToken: vooiToken });

  // 1. Scan for best opportunities to configure bot
  console.log('── Scanning for Bot Configuration ──\n');
  const scan = await vooi.scanArbitrage({
    limit: 50,
    orderBy: 'priceSpread',
    orderDirection: 'desc',
    minPriceSpread: 0.005,
  });

  // Find best asset+venue pairs for bot
  const bestPairs: any[] = [];
  for (const item of (scan?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.5) continue;
      bestPairs.push({
        asset: item.asset,
        spread,
        longExchange: p.long?.exchange,
        shortExchange: p.short?.exchange,
        volume: p.long?.volume24h || 0,
      });
    }
  }
  bestPairs.sort((a, b) => b.spread - a.spread);

  console.log(`Found ${bestPairs.length} viable pairs for bot:`);
  for (const p of bestPairs.slice(0, 10)) {
    console.log(`  ${p.asset.padEnd(20)} ${p.spread.toFixed(2)}%  ${p.longExchange}→${p.shortExchange}`);
  }

  // 2. Create VOOI bot for top opportunity
  console.log('\n── Creating VOOI Arbitrage Bot ──\n');
  if (bestPairs.length > 0) {
    const best = bestPairs[0];
    console.log(`  Asset: ${best.asset}`);
    console.log(`  Long: ${best.longExchange}`);
    console.log(`  Short: ${best.shortExchange}`);
    console.log(`  Spread: ${best.spread.toFixed(2)}%`);
    console.log('');

    try {
      const bot = await vooi.createBot({
        asset: best.asset,
        longExchange: best.longExchange,
        shortExchange: best.shortExchange,
        notionalUsd: 5000,
        // Builder code for rebate
        builder: agentAddress,
      } as any);
      
      console.log('✅ Bot created!');
      console.log('Bot ID:', bot.id);
      console.log('Status:', bot.status);
      
      // Log bot
      const bots = existsSync(BOT_LOG) ? JSON.parse(readFileSync(BOT_LOG, 'utf8')) : [];
      bots.push({ ...bot, createdAt: Date.now() });
      writeFileSync(BOT_LOG, JSON.stringify(bots, null, 2));
    } catch (e: any) {
      console.log('❌ Bot creation failed:', e.message?.substring(0, 200));
      console.log('\n  This may require:');
      console.log('    1. VOOI account with sufficient balance');
      console.log('    2. Approved API token for bot creation');
      console.log('    3. Capital deposited to VOOI');
    }
  }

  // 3. List existing bots
  console.log('\n── Existing VOOI Bots ──\n');
  try {
    const bots = await vooi.listBots();
    console.log(`Found ${bots?.length || 0} bots`);
    for (const b of (bots || []).slice(0, 5)) {
      console.log(`  ID: ${b.id}  Status: ${b.status}  Asset: ${b.asset}`);
    }
  } catch (e: any) {
    console.log('Error listing bots:', e.message?.substring(0, 100));
  }

  // 4. Bot configuration for continuous operation
  console.log('\n── Bot Configuration for Continuous Operation ──\n');
  const config = {
    scanInterval: 60, // seconds
    minSpread: 0.5, // %
    maxSpread: 20, // % (skip unrealistic)
    notionalPerTrade: 5000,
    maxConcurrentBots: 3,
    stopLossPct: 5,
    takeProfitPct: 2,
    builderCode: agentAddress,
    builderFeeBps: 10,
    exchanges: ['hyperliquid', 'mexc', 'gate', 'binance', 'bybit', 'aster', 'lighter', 'robinhood'],
    assets: bestPairs.slice(0, 10).map(p => p.asset),
  };
  console.log('Configuration:');
  console.log(JSON.stringify(config, null, 2));
  
  writeFileSync('/home/z/my-project/download/vooi-bot-config.json', JSON.stringify(config, null, 2));
  console.log('\nConfig saved to /home/z/my-project/download/vooi-bot-config.json');
}

main().catch(console.error);
