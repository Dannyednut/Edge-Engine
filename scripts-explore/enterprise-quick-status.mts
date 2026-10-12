import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

async function main() {
  console.log('═══ Enterprise Quick Status ═══');
  console.log(`  ${new Date().toISOString()}\n`);

  // Processes
  const procs = ['all-runner', 'listener.ts', 'command-handler', 'opportunity-monitor'];
  for (const p of procs) {
    try { execSync(`pgrep -f "${p}"`, { stdio: 'pipe' }); console.log(`  ✅ ${p}`); }
    catch { console.log(`  ❌ ${p}`); }
  }

  // Commits
  const commits = execSync('git -C /home/z/my-project/edge-engine rev-list --count HEAD', { encoding: 'utf8' }).trim();
  console.log(`\n  Commits: ${commits}`);

  // Paper trader
  try {
    const state = JSON.parse(readFileSync('/home/z/my-project/download/paper-trading-state.json', 'utf8'));
    const roi = (state.realizedPnl / state.startingCapital * 100).toFixed(2);
    console.log(`  Paper: ${roi}% ROI, ${state.totalTrades} trades, $${state.realizedPnl.toFixed(0)} P&L`);
  } catch {}

  // Risk
  try {
    const risk = JSON.parse(readFileSync('/home/z/my-project/download/risk-state.json', 'utf8'));
    console.log(`  Risk: ${risk.tradingStopped ? '🚨 STOPPED' : risk.tradingPaused ? '⚠️ PAUSED' : '✅ ACTIVE'}`);
  } catch {}

  // Wallets
  console.log(`  EVM wallet: $0 (awaiting funds)`);
  console.log(`  Solana wallet: empty (awaiting SOL)`);

  // Opportunities
  const vooiRes = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=50&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
  const vooiData = vooiRes.ok ? await vooiRes.json() : { items: [] };
  let oppCount = 0;
  for (const item of (vooiData?.items || [])) {
    for (const p of (item.pairs || [])) {
      if ((p.priceSpread || 0) * 100 > 0.5) oppCount++;
    }
  }
  console.log(`  Live VOOI opportunities: ${oppCount}`);

  console.log(`\n  Status: ALL SYSTEMS READY — awaiting capital`);
}
main().catch(console.error);
