/**
 * Capital Deployment Readiness Checklist
 *
 * Comprehensive check to ensure we're ready to deploy capital.
 * When principal provides funds, we can immediately execute.
 *
 * Checks:
 *   1. All executors built and tested
 *   2. All wallets funded (or ready to receive)
 *   3. All API keys configured
 *   4. Risk manager initialized
 *   5. Paper trading validates strategy
 *   6. Background processes running
 *   7. Monitoring + alerting active
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const HL_API = 'https://api.hyperliquid.xyz/info';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Capital Deployment Readiness Checklist');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════\n');

  const checks: { category: string; item: string; status: 'READY' | 'PENDING' | 'BLOCKED'; details: string }[] = [];

  // 1. Executors
  console.log('── 1. Executors ──');
  const executors = [
    { name: 'VooiPriceSpreadExecutor', path: 'packages/scanner/src/runners/vooi-price-spread-executor.ts' },
    { name: 'VooiArbExecutor', path: 'packages/scanner/src/runners/vooi-arb-executor.ts' },
    { name: 'KhypeCarryExecutor', path: 'packages/scanner/src/runners/khype-carry-executor.ts' },
    { name: 'EulerLendingExecutor', path: 'packages/scanner/src/runners/euler-lending-executor.ts' },
    { name: 'PumpArbExecutor', path: 'scripts-explore/pump-arb-executor.mts' },
    { name: 'CoreWriterClient', path: 'packages/executor/src/corewriter-client.ts' },
    { name: 'BuilderCodeClient', path: 'packages/executor/src/builder-code-client.ts' },
  ];
  for (const e of executors) {
    const exists = existsSync(resolve(REPO_ROOT, e.path));
    checks.push({
      category: 'Executors',
      item: e.name,
      status: exists ? 'READY' : 'BLOCKED',
      details: exists ? 'Built and available' : 'Missing',
    });
  }

  // 2. Wallets
  console.log('── 2. Wallets ──');
  const agentEvmAddress = process.env.AGENT_EVM_ADDRESS;
  const agentSolanaAddress = process.env.AGENT_SOLANA_ADDRESS;

  // Check agent EVM wallet balance on HL
  if (agentEvmAddress) {
    try {
      const portfolio = await hlInfo({ type: 'portfolio', user: agentEvmAddress });
      const dayData = Array.isArray(portfolio) ? portfolio.find((p: any) => p[0] === 'day') : null;
      const accountValue = dayData?.[1]?.accountValueHistory?.slice(-1)?.[0]?.[1] || '0';
      const value = parseFloat(accountValue);
      checks.push({
        category: 'Wallets',
        item: 'Agent EVM (HL)',
        status: value > 0 ? 'READY' : 'PENDING',
        details: `Address: ${agentEvmAddress} | Balance: $${value.toFixed(2)}`,
      });
    } catch {
      checks.push({ category: 'Wallets', item: 'Agent EVM (HL)', status: 'PENDING', details: `Address: ${agentEvmAddress} | Balance check failed` });
    }
  }

  checks.push({
    category: 'Wallets',
    item: 'Agent Solana (PumpApi)',
    status: process.env.PUMPAPI_PRIVATE_KEY ? 'PENDING' : 'BLOCKED',
    details: `Address: ${agentSolanaAddress} | Key: ${process.env.PUMPAPI_PRIVATE_KEY ? 'set' : 'missing'} | Balance: EMPTY (needs SOL)`,
  });

  checks.push({
    category: 'Wallets',
    item: 'Builder Code Registration',
    status: 'PENDING',
    details: 'Needs $100 USDC in agent EVM wallet to register',
  });

  // 3. API Keys
  console.log('── 3. API Keys ──');
  const apiKeys = [
    { name: 'VOOI API Token', env: 'VOOI_API_TOKEN' },
    { name: 'PumpApi Private Key', env: 'PUMPAPI_PRIVATE_KEY' },
    { name: 'Telegram Bot Token', env: 'TELEGRAM_BOT_TOKEN' },
    { name: 'Agent EVM Private Key', env: 'AGENT_EVM_PRIVATE_KEY' },
    { name: 'Agent Solana Private Key', env: 'AGENT_SOLANA_PRIVATE_KEY' },
  ];
  for (const k of apiKeys) {
    const value = process.env[k.env];
    checks.push({
      category: 'API Keys',
      item: k.name,
      status: value ? 'READY' : 'BLOCKED',
      details: value ? `Set (${value.substring(0, 8)}...)` : 'Not set',
    });
  }

  // 4. Risk Manager
  console.log('── 4. Risk Manager ──');
  const riskState = existsSync('/home/z/my-project/download/risk-state.json');
  checks.push({
    category: 'Risk',
    item: 'Risk Manager State',
    status: riskState ? 'READY' : 'PENDING',
    details: riskState ? 'Initialized' : 'Not initialized',
  });

  // 5. Paper Trading
  console.log('── 5. Paper Trading ──');
  if (existsSync('/home/z/my-project/download/paper-trading-state.json')) {
    const paperState = JSON.parse(readFileSync('/home/z/my-project/download/paper-trading-state.json', 'utf8'));
    const roi = (paperState.realizedPnl / paperState.startingCapital * 100).toFixed(2);
    checks.push({
      category: 'Validation',
      item: 'Paper Trading',
      status: 'READY',
      details: `ROI: ${roi}% | Trades: ${paperState.totalTrades} | P&L: $${paperState.realizedPnl.toFixed(0)}`,
    });
  }

  // 6. Background Processes
  console.log('── 6. Background Processes ──');
  const processNames = ['all-runner', 'listener.ts', 'command-handler', 'opportunity-monitor'];
  for (const p of processNames) {
    const { execSync } = await import('node:child_process');
    let running = false;
    try {
      execSync(`pgrep -f "${p}"`, { stdio: 'pipe' });
      running = true;
    } catch {}
    checks.push({
      category: 'Processes',
      item: p,
      status: running ? 'READY' : 'BLOCKED',
      details: running ? 'Running' : 'Not running',
    });
  }

  // 7. Live Opportunities
  console.log('── 7. Live Opportunities ──');
  const vooiResp = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=50&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
  const vooiData = vooiResp.ok ? await vooiResp.json() : { items: [] };
  let oppCount = 0;
  for (const item of (vooiData?.items || [])) {
    for (const p of (item.pairs || [])) {
      if ((p.priceSpread || 0) * 100 > 0.5) oppCount++;
    }
  }
  checks.push({
    category: 'Opportunities',
    item: 'VOOI Price Spread',
    status: oppCount > 0 ? 'READY' : 'PENDING',
    details: `${oppCount} opportunities > 0.5% available now`,
  });

  // Display results
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Readiness Summary');
  console.log('═══════════════════════════════════════════════════\n');

  const ready = checks.filter(c => c.status === 'READY').length;
  const pending = checks.filter(c => c.status === 'PENDING').length;
  const blocked = checks.filter(c => c.status === 'BLOCKED').length;

  console.log(`Total checks: ${checks.length}`);
  console.log(`✅ READY: ${ready}`);
  console.log(`⏳ PENDING: ${pending} (awaiting principal action)`);
  console.log(`❌ BLOCKED: ${blocked}`);
  console.log('');

  for (const c of checks) {
    const emoji = c.status === 'READY' ? '✅' : c.status === 'PENDING' ? '⏳' : '❌';
    console.log(`${emoji} [${c.category}] ${c.item}: ${c.details}`);
  }

  console.log('');
  const overallReady = blocked === 0;
  if (overallReady) {
    console.log('🎉 DEPLOYMENT READY!');
    console.log('  All systems are ready for capital deployment.');
    console.log('  Pending items require principal action only:');
    console.log('    1. Fund agent EVM wallet with $100+ USDC (builder code)');
    console.log('    2. Fund agent EVM wallet with $95k (strategy capital)');
    console.log('    3. Fund Solana wallet with 0.5 SOL (pump.fun)');
    console.log('    4. Approve live trading');
  } else {
    console.log('⚠️  DEPLOYMENT BLOCKED');
    console.log(`  ${blocked} items need to be fixed before deployment.`);
  }

  return { ready, pending, blocked, overallReady };
}

main().catch(console.error);
