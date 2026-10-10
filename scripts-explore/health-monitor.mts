/**
 * Enterprise Health Monitor
 * Runs continuously, checks all systems
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function checkHL() {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
    });
    return res.ok ? '✅' : '❌';
  } catch { return '❌'; }
}

async function checkVOOI() {
  try {
    const res = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=1');
    return res.ok ? '✅' : '❌';
  } catch { return '❌'; }
}

async function checkPumpApi() {
  try {
    const res = await fetch('https://api.pumpapi.io', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return res.status === 200 || res.status === 400 ? '✅' : '❌';
  } catch { return '❌'; }
}

function checkProc(pattern: string): boolean {
  try { execSync(`pgrep -f "${pattern}"`, { stdio: 'pipe' }); return true; } catch { return false; }
}

async function main() {
  const hl = await checkHL();
  const vooi = await checkVOOI();
  const pump = await checkPumpApi();
  
  const scanner = checkProc('all-runner');
  const listener = checkProc('listener.ts');
  const cmdHandler = checkProc('command-handler');
  const oppMonitor = checkProc('opportunity-monitor');

  // Check paper trader
  let paperRoi = 'N/A';
  try {
    const state = JSON.parse(readFileSync('/home/z/my-project/download/paper-trading-state.json', 'utf8'));
    paperRoi = `${(state.realizedPnl / state.startingCapital * 100).toFixed(2)}%`;
  } catch {}

  // Check risk state
  let riskStatus = 'N/A';
  try {
    const risk = JSON.parse(readFileSync('/home/z/my-project/download/risk-state.json', 'utf8'));
    riskStatus = risk.tradingStopped ? '🚨 STOPPED' : risk.tradingPaused ? '⚠️ PAUSED' : '✅ ACTIVE';
  } catch {}

  console.log('═══════════════════════════════════════════════════');
  console.log('  Enterprise Health Monitor');
  console.log(`  ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');
  
  console.log('── External APIs ──');
  console.log(`  HL API:       ${hl}`);
  console.log(`  VOOI API:     ${vooi}`);
  console.log(`  PumpApi:      ${pump}`);
  
  console.log('\n── Background Processes ──');
  console.log(`  Scanner:      ${scanner ? '✅' : '❌'}`);
  console.log(`  Listener:     ${listener ? '✅' : '❌'}`);
  console.log(`  Cmd Handler:  ${cmdHandler ? '✅' : '❌'}`);
  console.log(`  Opp Monitor:  ${oppMonitor ? '✅' : '❌'}`);
  
  console.log('\n── Enterprise State ──');
  console.log(`  Risk:         ${riskStatus}`);
  console.log(`  Paper ROI:    ${paperRoi}`);
  console.log(`  Commits:      ${execSync('git -C ' + REPO_ROOT + ' rev-list --count HEAD', { encoding: 'utf8' }).trim()}`);
  
  const allHealthy = hl === '✅' && vooi === '✅' && scanner && listener && cmdHandler && oppMonitor;
  console.log(`\n  Overall: ${allHealthy ? '✅ ALL SYSTEMS HEALTHY' : '⚠️ ISSUES DETECTED'}`);
}

main().catch(console.error);
