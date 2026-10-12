import { readFileSync } from 'node:fs';
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
  const vooi = new VooiClient({ apiToken: process.env.VOOI_API_TOKEN });

  // Try different exchange combinations
  const combos = [
    ['hyperliquid', 'mexc'],
    ['hyperliquid', 'gate'],
    ['hyperliquid', 'binance'],
    ['hyperliquid', 'bybit'],
    ['hyperliquid', 'aster'],
    ['hyperliquid', 'lighter'],
    ['hyperliquid', 'robinhood'],
    ['hyperliquid', 'ondo'],
    ['aster', 'lighter'],
  ];

  for (const exchanges of combos) {
    console.log(`Trying ${exchanges.join(' + ')}...`);
    try {
      const bot = await vooi.createBot({
        exchanges,
        leverage: 1,
        notionalUsd: 100, // small to test
        maxHoldHours: 24,
        maxRoundTripCostBps: 12,
      });
      console.log(`✅ Bot created with ${exchanges.join(' + ')}!`);
      console.log('Bot:', JSON.stringify(bot, null, 2));
      return; // success — stop trying
    } catch (e: any) {
      const msg = e.message || '';
      if (msg.includes('Connect or reconnect')) {
        console.log(`  ❌ Need to connect ${msg.match(/(\w+,?\s*\w+)/)?.[0] || 'exchanges'}`);
      } else {
        console.log(`  ❌ ${msg.substring(0, 100)}`);
      }
    }
  }

  console.log('\n⚠️  No exchange combination worked.');
  console.log('Need to connect exchanges via VOOI dashboard:');
  console.log('  https://ultra.vooi.io');
  console.log('  Settings → API Connections → Connect each exchange');
}

main().catch(console.error);
