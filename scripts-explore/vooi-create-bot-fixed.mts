/**
 * VOOI Bot Creator — Fixed with correct API format
 * 
 * VooiBotRequest requires:
 *   exchanges: string[] (min 2)
 *   leverage: number
 *   notionalUsd: number
 *   maxHoldHours?: number (default 24)
 *   maxRoundTripCostBps?: number (default 12)
 *   requiredExchange?: string
 *   categories?: string[]
 *   symbols?: string[]
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

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  VOOI Bot Creator — Fixed Format');
  console.log('═══════════════════════════════════════════════════\n');

  const vooiToken = process.env.VOOI_API_TOKEN;
  if (!vooiToken) { console.log('❌ No VOOI token'); return; }

  const vooi = new VooiClient({ apiToken: vooiToken });

  // 1. Scan for best opportunities
  console.log('── Scanning Opportunities ──\n');
  const scan = await vooi.scanArbitrage({
    limit: 50,
    orderBy: 'priceSpread',
    orderDirection: 'desc',
    minPriceSpread: 0.005,
  });

  // Group by exchange pairs
  const exchangePairs: Record<string, { count: number; totalSpread: number; assets: string[] }> = {};
  for (const item of (scan?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.5) continue;
      const key = `${p.long?.exchange}+${p.short?.exchange}`;
      if (!exchangePairs[key]) exchangePairs[key] = { count: 0, totalSpread: 0, assets: [] };
      exchangePairs[key].count++;
      exchangePairs[key].totalSpread += spread;
      exchangePairs[key].assets.push(item.asset);
    }
  }

  // Sort by count (most opportunities)
  const sortedPairs = Object.entries(exchangePairs)
    .map(([key, data]) => ({ exchanges: key.split('+'), ...data, avgSpread: data.totalSpread / data.count }))
    .sort((a, b) => b.count - a.count);

  console.log('Best exchange pairs for bot:');
  for (const p of sortedPairs.slice(0, 10)) {
    console.log(`  ${p.exchanges.join(' → ')}  ${p.count} opps  avg=${p.avgSpread.toFixed(2)}%  assets: ${p.assets.slice(0, 3).join(', ')}`);
  }

  // 2. Create bot with correct format
  console.log('\n── Creating VOOI Bot ──\n');
  
  // Use top exchange pair
  if (sortedPairs.length > 0) {
    const best = sortedPairs[0];
    console.log(`Exchanges: ${best.exchanges.join(', ')}`);
    console.log(`Opportunities: ${best.count}`);
    console.log(`Avg spread: ${best.avgSpread.toFixed(2)}%`);
    
    try {
      const bot = await vooi.createBot({
        exchanges: best.exchanges,
        leverage: 1,
        notionalUsd: 5000,
        maxHoldHours: 24,
        maxRoundTripCostBps: 12, // 0.12% max round-trip cost
        symbols: best.assets.slice(0, 10), // trade top 10 assets
      });
      
      console.log('\n✅ Bot created successfully!');
      console.log('Bot ID:', bot.id);
      console.log('Status:', bot.status);
      console.log('Exchanges:', bot.exchanges);
      console.log('Notional:', bot.notionalUsd);
      console.log('Leverage:', bot.leverage);
      
      // Save bot
      const bots = existsSync('/home/z/my-project/download/vooi-bots.json') 
        ? JSON.parse(readFileSync('/home/z/my-project/download/vooi-bots.json', 'utf8')) 
        : [];
      bots.push({ ...bot, createdAt: Date.now() });
      writeFileSync('/home/z/my-project/download/vooi-bots.json', JSON.stringify(bots, null, 2));
      console.log('\nBot saved to vooi-bots.json');
      
    } catch (e: any) {
      console.log('\n❌ Bot creation error:', e.message?.substring(0, 300));
      console.log('\n  Possible reasons:');
      console.log('    1. VOOI account needs capital deposited');
      console.log('    2. API token needs bot creation permissions');
      console.log('    3. Account verification required');
    }
  }

  // 3. List existing bots
  console.log('\n── Existing Bots ──\n');
  try {
    const data = await vooi.listBots();
    console.log(`Bots: ${data?.items?.length || 0}`);
    for (const b of (data?.items || [])) {
      console.log(`  ${b.id} ${b.status} ${b.exchanges?.join(',')} $${b.notionalUsd}`);
    }
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 100));
  }
}

main().catch(console.error);
