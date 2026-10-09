/**
 * Performance Tracker — logs all opportunities found and alerts sent.
 *
 * Tracks:
 *   - Total opportunities found per strategy per day
 *   - Total alerts sent to Telegram
 *   - Estimated profit if all opportunities were captured
 *   - Top performing strategies
 *
 * Usage: pnpm --filter @edge/scanner start:perf-track
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';

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

const LOG_FILE = resolve(REPO_ROOT, 'data', 'performance-log.jsonl');

interface PerfEntry {
  ts: number;
  date: string;
  strategy: string;
  asset: string;
  spreadPct: number;
  estimatedProfitUsd: number;
  type: 'price_spread' | 'funding_rate' | 'carry_arb' | 'lending_arb';
}

export function logOpportunity(entry: Omit<PerfEntry, 'ts' | 'date'>): void {
  const full: PerfEntry = {
    ...entry,
    ts: Date.now(),
    date: new Date().toISOString().slice(0, 10),
  };
  appendFileSync(LOG_FILE, JSON.stringify(full) + '\n');
}

export function getDailySummary(date?: string): {
  totalOpportunities: number;
  totalEstimatedProfit: number;
  byStrategy: Record<string, { count: number; profit: number }>;
  topOpportunities: PerfEntry[];
} {
  const targetDate = date || new Date().toISOString().slice(0, 10);
  
  if (!existsSync(LOG_FILE)) {
    return { totalOpportunities: 0, totalEstimatedProfit: 0, byStrategy: {}, topOpportunities: [] };
  }

  const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  const entries: PerfEntry[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as PerfEntry;
      if (e.date === targetDate) entries.push(e);
    } catch {}
  }

  const byStrategy: Record<string, { count: number; profit: number }> = {};
  for (const e of entries) {
    const key = e.strategy;
    if (!byStrategy[key]) byStrategy[key] = { count: 0, profit: 0 };
    byStrategy[key].count++;
    byStrategy[key].profit += e.estimatedProfitUsd;
  }

  const topOpps = [...entries].sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd).slice(0, 10);

  return {
    totalOpportunities: entries.length,
    totalEstimatedProfit: entries.reduce((s, e) => s + e.estimatedProfitUsd, 0),
    byStrategy,
    topOpportunities: topOpps,
  };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const summary = getDailySummary(today);

  console.log('═══════════════════════════════════════════════════');
  console.log(`  Performance Tracker — ${today}`);
  console.log('═══════════════════════════════════════════════════\n');

  console.log(`Total opportunities logged: ${summary.totalOpportunities}`);
  console.log(`Total estimated profit:     $${summary.totalEstimatedProfit.toFixed(2)}`);
  console.log('');

  if (Object.keys(summary.byStrategy).length > 0) {
    console.log('By Strategy:');
    for (const [strategy, data] of Object.entries(summary.byStrategy).sort((a, b) => b[1].profit - a[1].profit)) {
      console.log(`  ${strategy.padEnd(25)} ${data.count} opps  $${data.profit.toFixed(2)}`);
    }
  } else {
    console.log('No opportunities logged yet today.');
    console.log('The opportunity monitor will log opportunities as they are found.');
  }

  if (summary.topOpportunities.length > 0) {
    console.log('\nTop 10 Opportunities Today:');
    for (const o of summary.topOpportunities) {
      console.log(`  ${o.asset.padEnd(15)} ${o.strategy.padEnd(20)} ${o.spreadPct.toFixed(1)}%  $${o.estimatedProfitUsd.toFixed(0)}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
