// Comprehensive Funding Rate Database
// Build historical funding rate database for all HL perps
// Use for:
//   - Funding rate divergence strategy
//   - Mean reversion signals
//   - Strategy backtesting
//   - Risk management

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
const FUNDING_DB = '/home/z/my-project/download/comprehensive-funding-db.json';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function loadDb(): Record<string, { ts: number; funding: number; markPx: number; vol: number; oi: number }[]> {
  if (existsSync(FUNDING_DB)) {
    return JSON.parse(readFileSync(FUNDING_DB, 'utf8'));
  }
  return {};
}

function saveDb(db: Record<string, any[]>) {
  writeFileSync(FUNDING_DB, JSON.stringify(db, null, 2));
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Comprehensive Funding Rate Database Builder');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get current funding for all perps
  console.log('── Loading current funding rates ──');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta[0].universe || [];
  const ctxs = meta[1] || [];

  let db = loadDb();
  console.log(`  Existing DB: ${Object.keys(db).length} perps\n`);

  const now = Date.now();
  let updated = 0;

  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const funding = parseFloat(ctxs[i]?.funding || '0');
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const oi = parseFloat(ctxs[i]?.openInterest || '0') * markPx;

    if (funding !== 0 && markPx > 0) {
      if (!db[name]) db[name] = [];
      db[name].push({ ts: now, funding, markPx, vol, oi });
      // Keep last 720 entries (30 days at 1hr interval)
      if (db[name].length > 720) db[name] = db[name].slice(-720);
      updated++;
    }
  }

  saveDb(db);
  console.log(`  Updated: ${updated} perps`);
  console.log(`  Total in DB: ${Object.keys(db).length}\n`);

  // 2. Also fetch historical funding for top 10 perps (last 30 days)
  console.log('── Fetching Historical Funding (top 10 perps, 30 days) ──\n');
  const topPerps = Object.entries(db)
    .map(([coin, history]) => ({ coin, vol: history[history.length - 1]?.vol || 0 }))
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 10);

  for (const { coin } of topPerps) {
    try {
      const histFunding = await hlInfo({
        type: 'fundingHistory',
        coin,
        startTime: Date.now() - 30 * 24 * 60 * 60 * 1000,
        endTime: Date.now(),
      });
      if (Array.isArray(histFunding) && histFunding.length > 0) {
        console.log(`  ${coin}: ${histFunding.length} historical funding events`);
        // Merge into DB (deduplicate by timestamp)
        for (const f of histFunding) {
          const ts = f.time;
          const rate = parseFloat(f.fundingRate || f.deltaRate || '0');
          // Check if already exists
          const existing = db[coin].find(e => e.ts === ts);
          if (!existing) {
            db[coin].push({ ts, funding: rate, markPx: 0, vol: 0, oi: 0 });
          }
        }
        // Sort by timestamp
        db[coin].sort((a, b) => a.ts - b.ts);
        // Keep last 720
        if (db[coin].length > 720) db[coin] = db[coin].slice(-720);
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e: any) {
      console.log(`  ${coin}: Error - ${e.message}`);
    }
  }

  saveDb(db);

  // 3. Compute statistics
  console.log('\n── Funding Rate Statistics ──\n');
  console.log('Coin      | Data Points | Mean Funding/h | StdDev     | Min        | Max        | Current');
  console.log('──────────|─────────────|────────────────|────────────|────────────|────────────|────────────');
  const stats: any[] = [];
  for (const [coin, history] of Object.entries(db)) {
    if (history.length < 10) continue;
    const fundings = history.map(h => h.funding);
    const mean = fundings.reduce((s, x) => s + x, 0) / fundings.length;
    const variance = fundings.reduce((s, x) => s + (x - mean) ** 2, 0) / fundings.length;
    const std = Math.sqrt(variance);
    const min = Math.min(...fundings);
    const max = Math.max(...fundings);
    const current = fundings[fundings.length - 1];
    stats.push({ coin, points: history.length, mean, std, min, max, current });
    console.log(`${coin.padEnd(10)}| ${history.length.toString().padStart(11)} | ${(mean*100).toFixed(5).padStart(14)}%| ${(std*100).toFixed(5).padStart(10)}%| ${(min*100).toFixed(5).padStart(10)}%| ${(max*100).toFixed(5).padStart(10)}%| ${(current*100).toFixed(5)}%`);
  }

  // 4. Top divergence signals
  console.log('\n── Top Divergence Signals (current vs mean) ──\n');
  stats.sort((a, b) => {
    const zA = a.std > 0 ? Math.abs((a.current - a.mean) / a.std) : 0;
    const zB = b.std > 0 ? Math.abs((b.current - b.mean) / b.std) : 0;
    return zB - zA;
  });

  for (const s of stats.slice(0, 15)) {
    const z = s.std > 0 ? (s.current - s.mean) / s.std : 0;
    const signal = z > 1.5 ? 'SHORT (funding high)' : z < -1.5 ? 'LONG (funding low)' : 'NEUTRAL';
    console.log(`  ${s.coin.padEnd(10)} z=${z.toFixed(2).padStart(6)}  current=${(s.current*100).toFixed(5)}%  mean=${(s.mean*100).toFixed(5)}%  ${signal}`);
  }

  console.log('\n=== Verdict ===');
  console.log(`Funding database built with ${Object.keys(db).length} perps.`);
  console.log(`  Historical data: ${stats.filter(s => s.points > 100).length} perps with 100+ data points`);
  console.log(`  Divergence signals: ${stats.filter(s => Math.abs((s.current - s.mean) / Math.max(0.0001, s.std)) > 1.5).length} perps with |z| > 1.5`);
  console.log('');
  console.log('Use cases:');
  console.log('  1. Funding rate divergence strategy');
  console.log('  2. Mean reversion signals');
  console.log('  3. Strategy backtesting');
  console.log('  4. Risk management');
  console.log('  5. Market intelligence');
}

main().catch(console.error);
