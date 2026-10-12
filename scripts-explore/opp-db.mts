/**
 * Opportunity Database (SQLite via node:sqlite)
 *
 * Persists every observed opportunity from VOOI + HL scanners.
 * Enables:
 *   - "Which opps are recurring?" (high confidence = real)
 *   - "Which opps are stale?" (appeared once, never again)
 *   - "What's the average spread/funding for asset X?"
 *   - "Has this opp been alerted in the last 24h?"
 *
 * Schema:
 *   opportunities(id, ts, type, asset, venues, spread, funding, profit5k, alerted)
 *   alerts(id, ts, type, asset, venues, message_id)
 *   hourly_stats(hour, asset, type, avg_spread, max_spread, count)
 *
 * Usage:
 *   npx tsx scripts-explore/opp-db.mts            # CLI query
 *   npx tsx scripts-explore/opp-db.mts --record   # record a snapshot
 *   npx tsx scripts-explore/opp-db.mts --stats    # show stats
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

const DB_PATH = resolve(REPO_ROOT, 'data', 'opportunities.db');
const VOI_API = 'https://perps-api.vooi.io';

// Ensure data dir exists
import { mkdirSync } from 'node:fs';
mkdirSync(resolve(REPO_ROOT, 'data'), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS opportunities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    asset TEXT NOT NULL,
    venues TEXT NOT NULL,
    spread REAL,
    funding REAL,
    profit5k REAL,
    alerted INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_opp_ts ON opportunities(ts);
  CREATE INDEX IF NOT EXISTS idx_opp_asset ON opportunities(asset);
  CREATE INDEX IF NOT EXISTS idx_opp_type ON opportunities(type);

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    asset TEXT NOT NULL,
    venues TEXT,
    message_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_alert_ts ON alerts(ts);

  CREATE TABLE IF NOT EXISTS hourly_stats (
    hour TEXT NOT NULL,
    asset TEXT NOT NULL,
    type TEXT NOT NULL,
    avg_spread REAL,
    max_spread REAL,
    avg_funding REAL,
    count INTEGER,
    PRIMARY KEY (hour, asset, type)
  );
`);

const insertOpp = db.prepare(`
  INSERT INTO opportunities (ts, type, asset, venues, spread, funding, profit5k)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const upsertHourly = db.prepare(`
  INSERT INTO hourly_stats (hour, asset, type, avg_spread, max_spread, avg_funding, count)
  VALUES (?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(hour, asset, type) DO UPDATE SET
    avg_spread = (avg_spread * count + excluded.avg_spread) / (count + 1),
    max_spread = MAX(max_spread, excluded.max_spread),
    avg_funding = (avg_funding * count + excluded.avg_funding) / (count + 1),
    count = count + 1
`);

async function vooiScan(params: any): Promise<any> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const url = `${VOI_API}/arbitrage-scanner?${q.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return { items: [], total: 0 };
  return res.json();
}

async function recordSnapshot(): Promise<number> {
  const now = Date.now();
  const hour = new Date().toISOString().slice(0,13); // YYYY-MM-DDTHH
  let count = 0;

  // Price spread
  const priceResp = await vooiScan({ limit: 50, orderBy: 'priceSpread', orderDirection: 'desc', minPriceSpread: 0.005 });
  for (const item of (priceResp?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spreadPct = (p.priceSpread || 0) * 100;
      const profit5k = 5000 * spreadPct / 100 - 5000 * 0.003;
      const venues = `${p.long?.exchange}→${p.short?.exchange}`;
      insertOpp.run(now, 'PRICE', item.asset, venues, spreadPct, null, profit5k);
      upsertHourly.run(hour, item.asset, 'PRICE', spreadPct, spreadPct, null);
      count++;
    }
  }

  // Funding rate
  const fundResp = await vooiScan({ limit: 50, orderBy: 'fundingRate', orderDirection: 'desc', minFundingRate: 0.0001 });
  for (const item of (fundResp?.items || [])) {
    for (const p of (item.pairs || [])) {
      const funding = (p.fundingRate || 0) * 365 * 100;
      const profit5k = 5000 * funding / 100 / 365;
      const venues = `${p.long?.exchange}→${p.short?.exchange}`;
      insertOpp.run(now, 'FUNDING', item.asset, venues, null, funding, profit5k);
      upsertHourly.run(hour, item.asset, 'FUNDING', null, null, funding);
      count++;
    }
  }

  return count;
}

function showStats() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Opportunity Database Stats');
  console.log('═══════════════════════════════════════════════════\n');

  // Total counts
  const totalRow = db.prepare('SELECT COUNT(*) as n, MIN(ts) as first, MAX(ts) as last FROM opportunities').get() as any;
  console.log(`Total opportunities recorded: ${totalRow.n}`);
  console.log(`First: ${totalRow.first ? new Date(totalRow.first).toISOString() : 'n/a'}`);
  console.log(`Last:  ${totalRow.last ? new Date(totalRow.last).toISOString() : 'n/a'}\n`);

  // By type
  console.log('── By Type ──');
  const typeRows = db.prepare('SELECT type, COUNT(*) as n, AVG(spread) as avg_spread, MAX(spread) as max_spread, AVG(funding) as avg_funding, MAX(funding) as max_funding FROM opportunities GROUP BY type').all() as any[];
  for (const r of typeRows) {
    console.log(`  ${r.type}: ${r.n} opps, avg spread=${(r.avg_spread ?? 0).toFixed(2)}%, max spread=${(r.max_spread ?? 0).toFixed(2)}%, avg funding=${(r.avg_funding ?? 0).toFixed(0)}%/yr, max funding=${(r.max_funding ?? 0).toFixed(0)}%/yr`);
  }
  console.log('');

  // Top recurring assets (high confidence opps)
  console.log('── Top 15 Most Recurring Assets (HIGH CONFIDENCE) ──');
  const recurringRows = db.prepare(`
    SELECT asset, type, COUNT(*) as n, COUNT(DISTINCT venues) as venue_pairs, AVG(spread) as avg_spread, MAX(spread) as max_spread, AVG(funding) as avg_funding, MAX(funding) as max_funding
    FROM opportunities
    GROUP BY asset, type
    HAVING n >= 2
    ORDER BY n DESC, max_spread DESC, max_funding DESC
    LIMIT 15
  `).all() as any[];
  if (recurringRows.length === 0) {
    console.log('  (none yet — run --record a few times)');
  } else {
    for (const r of recurringRows) {
      const metric = r.type === 'PRICE'
        ? `spread avg=${(r.avg_spread ?? 0).toFixed(2)}% max=${(r.max_spread ?? 0).toFixed(2)}%`
        : `funding avg=${(r.avg_funding ?? 0).toFixed(0)}%/yr max=${(r.max_funding ?? 0).toFixed(0)}%/yr`;
      console.log(`  ${r.asset.padEnd(20)} ${r.type.padEnd(8)} n=${String(r.n).padStart(4)} pairs=${r.venue_pairs} ${metric}`);
    }
  }
  console.log('');

  // Last 24h alerts
  const since = Date.now() - 24 * 60 * 60 * 1000;
  console.log('── Last 24h Activity ──');
  const recentRow = db.prepare('SELECT COUNT(*) as n FROM opportunities WHERE ts >= ?').get(since) as any;
  console.log(`  Recent opportunities: ${recentRow.n}`);
  const alertRow = db.prepare('SELECT COUNT(*) as n FROM alerts WHERE ts >= ?').get(since) as any;
  console.log(`  Alerts sent: ${alertRow.n}`);
}

function showTopNow() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Top 10 Opportunities by Confidence');
  console.log('═══════════════════════════════════════════════════\n');

  const rows = db.prepare(`
    SELECT asset, type, COUNT(*) as n, COUNT(DISTINCT venues) as venue_pairs,
           AVG(spread) as avg_spread, MAX(spread) as max_spread,
           AVG(funding) as avg_funding, MAX(funding) as max_funding,
           MAX(ts) as last_seen
    FROM opportunities
    WHERE ts >= ?
    GROUP BY asset, type
    ORDER BY n DESC, max_spread DESC, max_funding DESC
    LIMIT 10
  `).all(Date.now() - 24 * 60 * 60 * 1000) as any[];

  if (rows.length === 0) {
    console.log('No data yet. Run: npx tsx scripts-explore/opp-db.mts --record');
    return;
  }

  console.log('Asset              | Type     | N  | Pairs | Avg Spread | Max Spread | Avg Funding | Max Funding | Last Seen');
  console.log('───────────────────|──────────|────|───────|────────────|────────────|─────────────|─────────────|───────────');
  for (const r of rows) {
    const last = r.last_seen ? new Date(r.last_seen).toISOString().slice(11,19) : '-';
    console.log(
      `${r.asset.padEnd(18)} | ${r.type.padEnd(8)} | ${String(r.n).padStart(2)} | ${String(r.venue_pairs).padStart(5)} | ${(r.avg_spread ?? 0).toFixed(2).padStart(10)}% | ${(r.max_spread ?? 0).toFixed(2).padStart(10)}% | ${(r.avg_funding ?? 0).toFixed(0).padStart(11)}% | ${(r.max_funding ?? 0).toFixed(0).padStart(11)}% | ${last}`
    );
  }
}

async function main() {
  const cmd = process.argv[2] || '--stats';

  if (cmd === '--record') {
    const n = await recordSnapshot();
    console.log(`[opp-db] recorded ${n} opportunities at ${new Date().toISOString()}`);
  } else if (cmd === '--top') {
    showTopNow();
  } else if (cmd === '--stats') {
    showStats();
  } else if (cmd === '--loop') {
    console.log('[opp-db] starting loop — recording every 5 min');
    while (true) {
      try {
        const n = await recordSnapshot();
        console.log(`[opp-db] ${new Date().toISOString()} recorded ${n} opps`);
      } catch (e) {
        console.error('[opp-db] error:', e);
      }
      await new Promise(r => setTimeout(r, 5 * 60 * 1000));
    }
  } else {
    console.log('Usage: opp-db.mts [--record|--stats|--top|--loop]');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
