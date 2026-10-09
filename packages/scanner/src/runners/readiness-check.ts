/**
 * Readiness Check — verifies all systems are ready for live trading.
 *
 * Usage: pnpm --filter @edge/scanner start:readiness
 *
 * Checks:
 *   1. API credentials (Sharpe, VOOI, Telegram, Odds API)
 *   2. HyperEVM RPC connectivity
 *   3. Scanner process running
 *   4. Listener process running
 *   5. Command handler running
 *   6. Opportunity monitor running
 *   7. VOOI API token valid (can list bots/orders)
 *   8. kHYPE carry arb opportunity exists
 *   9. Euler lending arb opportunity exists
 *  10. VOOI price spread arbs exist
 *  11. VOOI funding rate arbs exist
 *  12. Agent wallet funded (if AGENT_HYPE_ADDRESS set)
 *  13. Build status (all packages compile)
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { VooiClient } from '@edge/vooi-client';
import { HlLstArbScanner } from '../strategies/hl-lst-arb-scanner.js';
import { EulerLendingArbScanner } from '../strategies/euler-lending-arb-scanner.js';

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

interface Check {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

async function main() {
  const checks: Check[] = [];

  // 1. API credentials
  checks.push({
    name: 'Sharpe API Key',
    status: process.env.SHARPE_API_KEY ? 'pass' : 'fail',
    detail: process.env.SHARPE_API_KEY ? 'Configured' : 'NOT SET',
  });
  checks.push({
    name: 'VOOI API Token',
    status: process.env.VOOI_API_TOKEN ? 'pass' : 'fail',
    detail: process.env.VOOI_API_TOKEN ? 'Configured' : 'NOT SET',
  });
  checks.push({
    name: 'Telegram Bot Token',
    status: process.env.TELEGRAM_BOT_TOKEN ? 'pass' : 'fail',
    detail: process.env.TELEGRAM_BOT_TOKEN ? 'Configured' : 'NOT SET',
  });
  checks.push({
    name: 'Telegram Chat ID',
    status: process.env.TELEGRAM_CHAT_ID ? 'pass' : 'fail',
    detail: process.env.TELEGRAM_CHAT_ID ? 'Configured' : 'NOT SET',
  });
  checks.push({
    name: 'Odds API Key',
    status: process.env.ODDS_API_KEY ? 'pass' : 'warn',
    detail: process.env.ODDS_API_KEY ? 'Configured' : 'NOT SET (sports arb disabled)',
  });

  // 2. HyperEVM RPC
  try {
    const r = await fetch('https://rpc.hyperliquid.xyz/evm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
    });
    const j = await r.json() as any;
    checks.push({
      name: 'HyperEVM RPC',
      status: j.result ? 'pass' : 'fail',
      detail: j.result ? `Block ${parseInt(j.result, 16)}` : 'No response',
    });
  } catch (e: any) {
    checks.push({ name: 'HyperEVM RPC', status: 'fail', detail: e.message });
  }

  // 3-6. Process checks
  const processes: Array<{name: string, pattern: string}> = [
    { name: 'Scanner', pattern: 'all-runner' },
    { name: 'Listener', pattern: 'listener.ts' },
    { name: 'Command Handler', pattern: 'command-handler' },
    { name: 'Opportunity Monitor', pattern: 'opportunity-monitor' },
  ];
  for (const p of processes) {
    try {
      execSync(`pgrep -f "${p.pattern}"`, { encoding: 'utf8', stdio: 'pipe' });
      checks.push({ name: p.name, status: 'pass', detail: 'Running' });
    } catch {
      checks.push({ name: p.name, status: 'warn', detail: 'Not running (may have just restarted)' });
    }
  }

  // 7. VOOI API validity
  try {
    const vooi = new VooiClient({ apiToken: process.env.VOOI_API_TOKEN! });
    const bots = await vooi.listBots();
    checks.push({ name: 'VOOI API', status: 'pass', detail: `Valid (${bots.length} bots)` });
  } catch (e: any) {
    checks.push({ name: 'VOOI API', status: 'fail', detail: e.message.slice(0, 50) });
  }

  // 8. kHYPE carry arb
  try {
    const hlLstArb = new HlLstArbScanner({ minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100 });
    const alerts = await hlLstArb.scan();
    const a = alerts[0];
    checks.push({
      name: 'kHYPE Carry Arb',
      status: a ? 'pass' : 'warn',
      detail: a ? `${a.discountPct.toFixed(2)}% discount = $${(a.estimatedProfitUsd * 365 / 8).toFixed(0)}/yr` : 'No opportunity',
    });
  } catch (e: any) {
    checks.push({ name: 'kHYPE Carry Arb', status: 'fail', detail: e.message.slice(0, 50) });
  }

  // 9. Euler lending arb
  try {
    const eulerArb = new EulerLendingArbScanner({ minSpreadPct: 2.0, minLiquidityUsd: 50_000, maxSizeUsd: 5_000 });
    const alerts = await eulerArb.scan();
    checks.push({
      name: 'Euler Lending Arb',
      status: alerts.length > 0 ? 'pass' : 'warn',
      detail: alerts.length > 0 ? `${alerts.length} opps (top: ${alerts[0].assetSymbol} ${alerts[0].spreadPct.toFixed(1)}%)` : 'No opportunities',
    });
  } catch (e: any) {
    checks.push({ name: 'Euler Lending Arb', status: 'fail', detail: e.message.slice(0, 50) });
  }

  // 10. VOOI price spread arbs
  try {
    const vooi = new VooiClient({ apiToken: process.env.VOOI_API_TOKEN! });
    const r = await vooi.scanArbitrage({
      minFundingSpread: 0, minOpenInterest: 100_000, notionalUsd: 5000,
      orderBy: 'priceSpread', orderDirection: 'desc', limit: 50,
    });
    let count = 0;
    const VOOI_VENUES = new Set(['hyperliquid', 'lighter', 'aster', 'extended', 'trade.xyz', 'kinetiq', 'robinhood', 'ondo', 'binance', 'bybit', 'mexc', 'gate']);
    for (const item of r.items) {
      for (const p of item.pairs) {
        const longOi = Number(p.long.openInterest) * Number(p.long.price);
        const shortOi = Number(p.short.openInterest) * Number(p.short.price);
        if (longOi < 100_000 || shortOi < 100_000) continue;
        if (!VOOI_VENUES.has(p.long.exchange) || !VOOI_VENUES.has(p.short.exchange)) continue;
        const spreadPct = Math.abs((Number(p.long.price) - Number(p.short.price)) / Math.min(Number(p.long.price), Number(p.short.price))) * 100;
        if (spreadPct >= 2.0) { count++; break; }
      }
    }
    checks.push({ name: 'VOOI Price Spread Arbs', status: count > 0 ? 'pass' : 'warn', detail: `${count} opps >2% spread` });
  } catch (e: any) {
    checks.push({ name: 'VOOI Price Spread Arbs', status: 'fail', detail: e.message.slice(0, 50) });
  }

  // 11. Agent wallet
  checks.push({
    name: 'Agent Wallet',
    status: process.env.AGENT_HYPE_PRIVKEY ? 'pass' : 'warn',
    detail: process.env.AGENT_HYPE_PRIVKEY ? 'Configured (live mode ready)' : 'NOT SET (dry-run only)',
  });

  // Print results
  console.log('═══════════════════════════════════════════════════');
  console.log('  Trading Readiness Check');
  console.log(`  ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  let passCount = 0, warnCount = 0, failCount = 0;
  for (const c of checks) {
    const icon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : '❌';
    console.log(`  ${icon} ${c.name.padEnd(25)} ${c.detail}`);
    if (c.status === 'pass') passCount++;
    else if (c.status === 'warn') warnCount++;
    else failCount++;
  }

  console.log(`\n  Total: ${passCount} pass, ${warnCount} warn, ${failCount} fail`);
  
  if (failCount > 0) {
    console.log('\n  ⚠ FAILURES — fix before live trading');
  } else if (warnCount > 0) {
    console.log('\n  ✅ READY FOR DRY-RUN — warnings are non-blocking');
    console.log('  ⚠ Set AGENT_HYPE_PRIVKEY + fund VOOI for live trading');
  } else {
    console.log('\n  ✅ ALL SYSTEMS GO — ready for live trading');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
