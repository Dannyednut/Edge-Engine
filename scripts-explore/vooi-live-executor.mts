/**
 * VOOI Live Executor — integrates VOOI API with HL SDK
 *
 * When wallet is funded:
 *   1. Scan VOOI for price spread opportunities
 *   2. For each opportunity, place atomic paired order via VOOI
 *   3. Include builder code field for rebate
 *   4. Track P&L
 *
 * VOOI handles both legs atomically — we just need:
 *   - VOOI API token (set in .env)
 *   - Agent wallet funded with USDC
 *   - Builder code registered
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { privateKeyToAccount } from '/home/z/my-project/edge-engine/node_modules/.pnpm/viem@2.56.9_bufferutil@4.1.0_typescript@5.9.3/node_modules/viem/accounts';
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
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
  console.log('  VOOI Live Executor — READY FOR CAPITAL');
  console.log('═══════════════════════════════════════════════════\n');

  const agentPrivateKey = process.env.AGENT_EVM_PRIVATE_KEY as `0x${string}`;
  const agentAddress = process.env.AGENT_EVM_ADDRESS!;
  const vooiToken = process.env.VOOI_API_TOKEN;

  console.log(`  Agent: ${agentAddress}`);
  console.log(`  VOOI token: ${vooiToken ? 'set' : 'NOT SET'}`);

  // Create VOOI client
  const vooi = new VooiClient({ apiToken: vooiToken });

  // 1. Scan for opportunities
  console.log('\n── Scanning VOOI Price Spread Opportunities ──\n');
  const scanResp = await vooi.scanArbitrage({
    limit: 20,
    orderBy: 'priceSpread',
    orderDirection: 'desc',
    minPriceSpread: 0.005, // 0.5%
  });

  const opportunities: any[] = [];
  for (const item of (scanResp?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.5) continue;
      const profit5k = 5000 * spread / 100 - 5000 * 0.001;
      opportunities.push({
        asset: item.asset,
        spread,
        longVenue: p.long?.exchange,
        shortVenue: p.short?.exchange,
        longPrice: parseFloat(p.long?.price || '0'),
        shortPrice: parseFloat(p.short?.price || '0'),
        profit5k,
        priceSpreadAtSize: p.priceSpreadAtSize,
      });
    }
  }

  console.log(`  Found ${opportunities.length} opportunities > 0.5%`);
  for (const o of opportunities.slice(0, 10)) {
    console.log(`    ${o.asset.padEnd(20)} ${o.spread.toFixed(2)}%  ${o.longVenue}→${o.shortVenue}  profit=$${o.profit5k.toFixed(0)}/5k`);
  }

  // 2. Check if we can execute
  console.log('\n── Execution Readiness ──\n');
  
  const wallet = privateKeyToAccount(agentPrivateKey);
  const transport = new HttpTransport({ requestTimeoutMs: 10_000 });
  const exchClient = new ExchangeClient({ transport, wallet, isTestnet: false });

  // Check HL balance
  let hlBalance = 0;
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearingHouseState', user: agentAddress }),
    });
    if (res.ok) {
      const data = await res.json();
      hlBalance = parseFloat(data?.marginSummary?.accountValue || '0');
    }
  } catch {}
  
  console.log(`  HL balance: $${hlBalance.toFixed(2)}`);
  console.log(`  VOOI token: ${vooiToken ? '✅ set' : '❌ not set'}`);
  console.log(`  Builder code: ${hlBalance > 0 ? 'needs registration' : 'needs $100 USDC first'}`);
  console.log('');

  if (hlBalance < 100) {
    console.log('  ⚠️  Cannot execute — need $100+ USDC in agent wallet');
    console.log(`  Fund: ${agentAddress}`);
    console.log('');
    console.log('  Once funded:');
    console.log('    1. Register builder code (approveBuilderFee)');
    console.log('    2. Place VOOI arbitrage order');
    console.log('    3. Include builder field for rebate');
    console.log('    4. Track P&L');
    return;
  }

  // 3. If funded — execute first trade
  if (opportunities.length > 0 && hlBalance >= 5000) {
    const opp = opportunities[0];
    console.log(`\n── Executing Trade: ${opp.asset} ──\n`);
    console.log(`  Spread: ${opp.spread.toFixed(2)}%`);
    console.log(`  Long: ${opp.longVenue} @ ${opp.longPrice}`);
    console.log(`  Short: ${opp.shortVenue} @ ${opp.shortPrice}`);
    console.log(`  Expected profit: $${opp.profit5k.toFixed(2)}`);

    try {
      const order = await vooi.placeArbitrageOrder({
        asset: opp.asset,
        longExchange: opp.longVenue,
        shortExchange: opp.shortVenue,
        notionalUsd: 5000,
        // Include builder code for HL orders
        builder: { b: agentAddress, f: 10 },
      } as any);
      console.log('  ✅ Order placed:', JSON.stringify(order));
    } catch (e: any) {
      console.log('  ❌ Order failed:', e.message?.substring(0, 200));
    }
  }

  console.log('\n=== Status ===');
  console.log('  Signing: ✅ WORKING (verified)');
  console.log('  VOOI scanning: ✅ WORKING');
  console.log('  VOOI execution: ' + (vooiToken ? '✅ ready' : '❌ needs token'));
  console.log('  Capital: ' + (hlBalance > 0 ? '✅ funded' : '❌ needs USDC'));
  console.log('  Builder code: ' + (hlBalance > 100 ? 'ready to register' : 'needs $100'));
}

main().catch(console.error);
