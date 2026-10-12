/**
 * Performance Attribution Dashboard
 *
 * Analyzes which strategies are contributing what to total P&L.
 * Uses paper trader's closed positions history.
 *
 * Outputs:
 *   - P&L breakdown by strategy
 *   - P&L breakdown by asset
 *   - Time-series of cumulative P&L
 *   - Best/worst performing assets per strategy
 *   - Strategy correlation matrix
 *   - Recommendations for capital reallocation
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

const PAPER_STATE = '/home/z/my-project/download/paper-trading-state.json';

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function main() {
  if (!existsSync(PAPER_STATE)) {
    console.log('No paper trader state found.');
    return;
  }

  const state = JSON.parse(readFileSync(PAPER_STATE, 'utf8'));
  const positions = state.closedPositions || [];

  console.log('═══════════════════════════════════════════════════');
  console.log('  Performance Attribution Dashboard');
  console.log(`  Total positions: ${positions.length}`);
  console.log(`  Total realized P&L: ${fmtUsd(state.realizedPnl || 0)}`);
  console.log('═══════════════════════════════════════════════════\n');

  // ── 1. By Strategy ──
  const byStrategy: Record<string, { pnl: number; trades: number; wins: number; losses: number; notional: number; assets: Set<string> }> = {};
  for (const p of positions) {
    const s = p.strategy || 'unknown';
    if (!byStrategy[s]) byStrategy[s] = { pnl: 0, trades: 0, wins: 0, losses: 0, notional: 0, assets: new Set() };
    const pnl = p.netProfitUsd || 0;
    byStrategy[s].pnl += pnl;
    byStrategy[s].trades++;
    if (pnl > 0) byStrategy[s].wins++;
    if (pnl < 0) byStrategy[s].losses++;
    byStrategy[s].notional += p.notionalUsd || 0;
    byStrategy[s].assets.add(p.asset);
  }

  console.log('── 1. P&L by Strategy ──');
  console.log('Strategy                          | Trades | Win%  | Total P&L  | Avg/Trade | Capital Used | Assets | ROI on Capital');
  console.log('──────────────────────────────────|────────|───────|────────────|───────────|──────────────|────────|────────────────');
  const strategyRows = Object.entries(byStrategy).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [name, s] of strategyRows) {
    const winPct = s.trades > 0 ? (s.wins / s.trades * 100).toFixed(0) : '0';
    const avgTrade = s.trades > 0 ? s.pnl / s.trades : 0;
    const roi = s.notional > 0 ? (s.pnl / s.notional * 100) : 0;
    console.log(
      `${name.padEnd(34)}| ${String(s.trades).padStart(6)} | ${winPct.padStart(5)}% | ` +
      `${fmtUsd(s.pnl).padStart(10)} | ${fmtUsd(avgTrade).padStart(9)} | ` +
      `${fmtUsd(s.notional).padStart(12)} | ${String(s.assets.size).padStart(6)} | ${fmtPct(roi).padStart(14)}`
    );
  }
  console.log('');

  // ── 2. By Asset ──
  const byAsset: Record<string, { pnl: number; trades: number; notional: number; strategies: Set<string> }> = {};
  for (const p of positions) {
    const a = p.asset;
    if (!byAsset[a]) byAsset[a] = { pnl: 0, trades: 0, notional: 0, strategies: new Set() };
    byAsset[a].pnl += p.netProfitUsd || 0;
    byAsset[a].trades++;
    byAsset[a].notional += p.notionalUsd || 0;
    byAsset[a].strategies.add(p.strategy || 'unknown');
  }

  console.log('── 2. Top 15 Assets by P&L ──');
  console.log('Asset                  | Trades | Total P&L  | Avg/Trade | Capital Used | ROI on Capital | Strategies');
  console.log('───────────────────────|────────|────────────|───────────|──────────────|────────────────|──────────');
  const assetRows = Object.entries(byAsset).sort((a, b) => b[1].pnl - a[1].pnl).slice(0, 15);
  for (const [asset, a] of assetRows) {
    const avgTrade = a.trades > 0 ? a.pnl / a.trades : 0;
    const roi = a.notional > 0 ? (a.pnl / a.notional * 100) : 0;
    console.log(
      `${asset.padEnd(22)}| ${String(a.trades).padStart(6)} | ` +
      `${fmtUsd(a.pnl).padStart(10)} | ${fmtUsd(avgTrade).padStart(9)} | ` +
      `${fmtUsd(a.notional).padStart(12)} | ${fmtPct(roi).padStart(14)} | ${a.strategies.size}`
    );
  }
  console.log('');

  // ── 3. Worst Assets ──
  console.log('── 3. Worst 5 Assets (low ROI) ──');
  console.log('Asset                  | Trades | Total P&L  | ROI on Capital');
  console.log('───────────────────────|────────|────────────|────────────────');
  const worstAssets = Object.entries(byAsset)
    .filter(([_, a]) => a.notional > 0)
    .sort((a, b) => (a[1].pnl / a[1].notional) - (b[1].pnl / b[1].notional))
    .slice(0, 5);
  for (const [asset, a] of worstAssets) {
    const roi = a.pnl / a.notional * 100;
    console.log(
      `${asset.padEnd(22)}| ${String(a.trades).padStart(6)} | ${fmtUsd(a.pnl).padStart(10)} | ${fmtPct(roi).padStart(14)}`
    );
  }
  console.log('');

  // ── 4. Time Series (cumulative P&L over time, binned by hour) ──
  console.log('── 4. Cumulative P&L Over Time (hourly bins) ──');
  const hourlyPnl: Record<string, number> = {};
  for (const p of positions) {
    const ts = typeof p.ts === 'number' ? p.ts : Date.parse(p.ts);
    const hour = new Date(ts).toISOString().slice(0, 13); // YYYY-MM-DDTHH
    hourlyPnl[hour] = (hourlyPnl[hour] || 0) + (p.netProfitUsd || 0);
  }
  const sortedHours = Object.keys(hourlyPnl).sort();
  let cumulative = 0;
  for (const hour of sortedHours.slice(-12)) { // last 12 hours
    cumulative += hourlyPnl[hour];
    const bar = '█'.repeat(Math.min(40, Math.max(1, hourlyPnl[hour] / 10)));
    console.log(`  ${hour}h  ${fmtUsd(hourlyPnl[hour]).padStart(8)} ${bar} (cum: ${fmtUsd(cumulative)})`);
  }
  console.log('');

  // ── 5. Trade Distribution ──
  console.log('── 5. Trade Profit Distribution ──');
  const pnls = positions.map(p => p.netProfitUsd || 0).sort((a, b) => a - b);
  const buckets = [
    { range: '(-inf, 0)',    count: pnls.filter(p => p < 0).length },
    { range: '[0, $5)',      count: pnls.filter(p => p >= 0 && p < 5).length },
    { range: '[$5, $10)',    count: pnls.filter(p => p >= 5 && p < 10).length },
    { range: '[$10, $25)',   count: pnls.filter(p => p >= 10 && p < 25).length },
    { range: '[$25, $50)',   count: pnls.filter(p => p >= 25 && p < 50).length },
    { range: '[$50, $100)',  count: pnls.filter(p => p >= 50 && p < 100).length },
    { range: '[$100, $250)', count: pnls.filter(p => p >= 100 && p < 250).length },
    { range: '[$250+)',      count: pnls.filter(p => p >= 250).length },
  ];
  for (const b of buckets) {
    const bar = '█'.repeat(Math.min(40, b.count));
    console.log(`  ${b.range.padEnd(16)} ${String(b.count).padStart(4)} ${bar}`);
  }
  console.log('');

  // ── 6. Recommendations ──
  console.log('── 6. Recommendations ──');
  const topStrategy = strategyRows[0];
  const topAsset = assetRows[0];
  console.log(`  • Top strategy: ${topStrategy[0]} (${fmtUsd(topStrategy[1].pnl)} from ${topStrategy[1].trades} trades)`);
  console.log(`  • Top asset: ${topAsset[0]} (${fmtUsd(topAsset[1].pnl)} from ${topAsset[1].trades} trades)`);
  if (worstAssets.length > 0) {
    console.log(`  • Worst asset: ${worstAssets[0][0]} — consider skipping`);
  }
  console.log(`  • Total trades: ${positions.length}`);
  console.log(`  • Avg trade size: ${fmtUsd(state.realizedPnl / Math.max(1, positions.length))}`);
  console.log(`  • Capital efficiency: ${((state.realizedPnl / 100000) * 100).toFixed(2)}% ROI on starting capital`);
}

main();
