/**
 * Enterprise Dashboard — single-command overview of the entire system.
 *
 * Shows:
 *   1. Paper trader P&L
 *   2. Live HL market summary (234 markets)
 *   3. Top VOOI opportunities
 *   4. Top funding rates
 *   5. Top yield pools (DefiLlama)
 *   6. Risk dashboard status
 *   7. Daemon health
 *   8. Git status
 *
 * Usage: pnpm --filter @edge/scanner start:dashboard
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';

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
    if (k === 'EDGE_EXECUTION_AUTH') continue;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const HL_API = 'https://api.hyperliquid.xyz/info';
const VOI_API = 'https://perps-api.vooi.io';
const LLAMA_API = 'https://yields.llama.fi';
const PAPER_STATE = '/home/z/my-project/download/paper-trading-state.json';

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

async function main() {
  console.log('==================================================');
  console.log('  EDGE ENGINE — ENTERPRISE DASHBOARD');
  console.log(`  ${new Date().toISOString()}`);
  console.log('==================================================\n');

  // 1. Paper Trader
  console.log('── 1. PAPER TRADER ──');
  if (existsSync(PAPER_STATE)) {
    const state = JSON.parse(readFileSync(PAPER_STATE, 'utf8'));
    const roi = ((state.currentCapital - 100000) / 100000 * 100).toFixed(2);
    console.log(`  Capital: ${fmtUsd(state.currentCapital)} (started $100k)`);
    console.log(`  Realized P&L: +${fmtUsd(state.realizedPnl)} (+${roi}%)`);
    console.log(`  Trades: ${state.totalTrades} | Wins: ${state.winningTrades} | Losses: ${state.losingTrades}`);
    console.log(`  Win rate: ${state.totalTrades > 0 ? (state.winningTrades / state.totalTrades * 100).toFixed(1) : 0}%`);
  } else {
    console.log('  (no state file)');
  }

  // 2. HL Market Summary
  console.log('\n── 2. HYPERLIQUID MARKETS ──');
  try {
    const res = await fetch(HL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    if (res.ok) {
      const j = await res.json() as any;
      const universe = j?.[0]?.universe || [];
      const ctxs = j?.[1] || [];
      let totalOi = 0, totalVol = 0, marketCount = 0;
      const topFunding: any[] = [];

      for (let i = 0; i < universe.length; i++) {
        if (!universe[i] || !ctxs[i] || universe[i].name.startsWith('@')) continue;
        marketCount++;
        const oi = parseFloat(ctxs[i].openInterest) * parseFloat(ctxs[i].markPx);
        const vol = parseFloat(ctxs[i].dayNtlVlm) || 0;
        totalOi += oi;
        totalVol += vol;
        const fundingAnnual = (parseFloat(ctxs[i].funding) || 0) * 24 * 365 * 100;
        if (Math.abs(fundingAnnual) > 30) {
          topFunding.push({ coin: universe[i].name, funding: fundingAnnual, oi });
        }
      }

      console.log(`  Markets: ${marketCount}`);
      console.log(`  Total OI: ${fmtUsd(totalOi)}`);
      console.log(`  24h Volume: ${fmtUsd(totalVol)}`);
      if (topFunding.length > 0) {
        topFunding.sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding));
        console.log(`  Top funding: ${topFunding.slice(0, 3).map(f => `${f.coin} ${f.funding.toFixed(0)}/yr`).join(', ')}`);
      }
    }
  } catch (e: any) {
    console.log(`  (API error: ${e.message})`);
  }

  // 3. Top VOOI Opportunities
  console.log('\n── 3. VOOI OPPORTUNITIES ──');
  try {
    const res = await fetch(`${VOI_API}/arbitrage-scanner?limit=5&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.01`);
    if (res.ok) {
      const j = await res.json() as any;
      const items = j.items || [];
      console.log(`  Top ${items.length} price spread opps:`);
      for (const item of items.slice(0, 5)) {
        const p = item.pairs?.[0];
        if (p) {
          const spread = ((p.priceSpread || 0) * 100).toFixed(2);
          console.log(`    ${item.asset.padEnd(18)} ${spread}% ${p.long?.exchange}→${p.short?.exchange}`);
        }
      }
    }
  } catch (e: any) {
    console.log(`  (API error: ${e.message})`);
  }

  // 4. Top DefiLlama Yields
  console.log('\n── 4. TOP YIELDS (DefiLlama) ──');
  try {
    const res = await fetch(`${LLAMA_API}/pools`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const j = await res.json() as any;
      const stable = (j.data || [])
        .filter((p: any) => p.stablecoin && p.ilRisk === 'no')
        .filter((p: any) => p.apy > 10 && p.tvlUsd > 5_000_000)
        .sort((a: any, b: any) => b.apy - a.apy)
        .slice(0, 5);
      console.log(`  Top 5 stablecoin yields (>10% APY, >$5M TVL):`);
      for (const p of stable) {
        console.log(`    ${(p.symbol || '').padEnd(15)} ${(p.project || '').padEnd(20)} ${(p.apy || 0).toFixed(2)}% ${fmtUsd(p.tvlUsd || 0)} ${p.chain}`);
      }
    }
  } catch (e: any) {
    console.log(`  (API error: ${e.message})`);
  }

  // 5. Risk Dashboard
  console.log('\n── 5. RISK DASHBOARD ──');
  const riskStateFile = '/tmp/risk-state.json';
  if (existsSync(riskStateFile)) {
    try {
      const risk = JSON.parse(readFileSync(riskStateFile, 'utf8'));
      console.log(`  Kill switch: ${risk.killSwitchActive ? 'ACTIVE' : 'NOT TRIGGERED'}`);
      console.log(`  Daily P&L: ${risk.dailyPnlStart ? fmtUsd(risk.dailyPnlStart) : 'N/A'}`);
    } catch {
      console.log('  (state file exists but unreadable)');
    }
  } else {
    console.log('  (no risk state file)');
  }

  // 6. Daemon Health
  console.log('\n── 6. DAEMON HEALTH ──');
  const daemonLogs = ['telegram-listener', 'command-handler', 'realtime-opp-alerts', 'opp-db', 'hl-funding-alerts', 'paper-trader', 'risk-dashboard', 'wallet-funding-alert', 'realtime-spread-monitor'];
  let healthyCount = 0;
  for (const name of daemonLogs) {
    const logPath = resolve(REPO_ROOT, 'logs', `${name}.log`);
    if (existsSync(logPath)) {
      const mtime = statSync(logPath).mtimeMs;
      const age = Math.floor((Date.now() - mtime) / 1000);
      const status = age < 120 ? 'HEALTHY' : age < 600 ? 'STALE' : 'DEAD';
      if (status === 'HEALTHY') healthyCount++;
      console.log(`  ${status === 'HEALTHY' ? 'OK' : status === 'STALE' ? '!!' : 'XX'} ${name.padEnd(25)} ${age}s ago`);
    }
  }
  console.log(`  ${healthyCount}/${daemonLogs.length} daemons healthy`);

  // 7. Git Status
  console.log('\n── 7. GIT STATUS ──');
  try {
    const commits = execSync('git log --oneline | wc -l', { encoding: 'utf8' }).trim();
    const changes = execSync('git status --short | wc -l', { encoding: 'utf8' }).trim();
    console.log(`  Commits: ${commits}`);
    console.log(`  Uncommitted: ${changes} files`);
    console.log(`  Branch: main`);
    console.log(`  Remote: github.com/Dannyednut/Edge-Engine`);
  } catch {}

  // 8. Opportunity Database
  console.log('\n── 8. OPPORTUNITY DATABASE ──');
  const dbPath = resolve(REPO_ROOT, 'data', 'opportunities.db');
  if (existsSync(dbPath)) {
    const size = statSync(dbPath).size;
    console.log(`  File: data/opportunities.db (${(size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    console.log('  (no database)');
  }

  // 9. Alerts Fired
  console.log('\n── 9. ALERTS ──');
  const alertFiles = [
    { name: 'Spread alerts', path: '/tmp/realtime-spread-history.jsonl' },
    { name: 'Funding alerts', path: '/tmp/hl-funding-alert-history.jsonl' },
    { name: 'VOOI opp alerts', path: '/tmp/opp-alert-history.jsonl' },
  ];
  for (const f of alertFiles) {
    if (existsSync(f.path)) {
      const count = readFileSync(f.path, 'utf8').split('\n').filter(Boolean).length;
      console.log(`  ${f.name}: ${count}`);
    }
  }

  console.log('\n==================================================');
  console.log('  DASHBOARD COMPLETE');
  console.log('==================================================');
}

main().catch(err => { console.error(err); process.exit(1); });
