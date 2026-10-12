// HIP-3 Tokenized Stocks Arb Scanner
// HL HIP-3 has tokenized stocks (NVDA, TSLA, AAPL, etc.) — compare to Yahoo prices

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..');

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

async function getYahooPrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HIP-3 Tokenized Stocks Arb Scanner');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get all HL perp universe
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta[0].universe || [];
  const ctxs = meta[1] || [];

  // Look for stock-like tickers (4-char uppercase, like NVDA, TSLA, AAPL)
  const stockLike: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    // Heuristic: typical stock tickers are 1-5 chars, all caps, may have . or -
    if (markPx > 1 && /^[A-Z][A-Z.\-]{0,5}$/.test(name) && vol > 1000) {
      stockLike.push({ name, markPx, vol });
    }
  }

  console.log(`── Found ${stockLike.length} stock-like HL perps ──\n`);
  console.log('Top 30 by volume:');

  // Sort by volume descending
  stockLike.sort((a, b) => b.vol - a.vol);

  // Show top 30
  for (const s of stockLike.slice(0, 30)) {
    console.log(`  ${s.name.padEnd(8)} $${s.markPx.toFixed(4).padStart(12)}  vol=$${(s.vol/1000).toFixed(0).padStart(7)}k`);
  }

  // 2. Try matching each with Yahoo Finance
  console.log('\n── Cross-Venue Stock Arb Scan (HL perp vs Yahoo) ──');
  const arbs: any[] = [];
  const noMatch: string[] = [];

  // Limit to top 30 to avoid rate limits
  for (const s of stockLike.slice(0, 30)) {
    const yPx = await getYahooPrice(s.name);
    if (yPx && yPx > 0) {
      const spread = ((s.markPx - yPx) / yPx) * 100;
      const flag = Math.abs(spread) > 1 ? ' ⚠️' : '';
      console.log(`  ${s.name.padEnd(8)} HL=$${s.markPx.toFixed(4).padStart(10)}  Yahoo=$${yPx.toFixed(4).padStart(10)}  spread=${spread.toFixed(3).padStart(7)}%${flag}`);
      if (Math.abs(spread) > 1) {
        arbs.push({ name: s.name, hl: s.markPx, yahoo: yPx, spreadPct: spread });
      }
    } else {
      noMatch.push(s.name);
    }
  }

  if (noMatch.length > 0) {
    console.log(`\n  Tickers without Yahoo match (likely crypto/memecoin): ${noMatch.join(', ')}`);
  }

  // 3. Arb summary
  console.log('\n── Arbitrage Summary ──');
  if (arbs.length === 0) {
    console.log('  ✅ No arbs > 1% found');
    console.log('  HL perps tracking Yahoo stocks efficiently');
  } else {
    for (const a of arbs) {
      const direction = a.spreadPct > 0 ? 'SHORT HL / LONG STOCK' : 'LONG HL / SHORT STOCK';
      const profit10k = Math.abs(a.spreadPct) / 100 * 10000;
      console.log(`  ${a.name}: ${a.spreadPct.toFixed(3)}% — ${direction}`);
      console.log(`    Profit on $10k: $${profit10k.toFixed(0)}/cycle`);
    }
  }

  // 4. Capital required analysis
  console.log('\n── Capital Requirements ──');
  if (arbs.length > 0) {
    const maxArb = arbs.reduce((max, a) => Math.abs(a.spreadPct) > Math.abs(max.spreadPct) ? a : max);
    console.log(`  Max arb: ${maxArb.name} at ${maxArb.spreadPct.toFixed(3)}%`);
    console.log(`  Capital needed per arb: $10k (5k each side)`);
    console.log(`  Estimated cycles/year: 100 (assuming weekly deviations)`);
    console.log(`  Expected annual profit: $${(Math.abs(maxArb.spreadPct) * 100 * 100).toFixed(0)}/yr per $10k`);
  }

  console.log('\n=== Verdict ===');
  console.log('HIP-3 tokenized stocks scanner:');
  console.log(`  Scanned ${stockLike.length} stock-like HL perps`);
  console.log(`  Found ${arbs.length} cross-venue arbs > 1%`);
  console.log('');
  console.log('Most HL perps are crypto (NEAR, SOL, BTC), NOT stocks.');
  console.log('HIP-3 tokenized stocks need different API endpoint to query.');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Query HIP-3 markets specifically (not regular perps)');
  console.log('  2. Compare HIP-3 stock prices to Yahoo');
  console.log('  3. Build alert when spread > 1%');
  console.log('  4. Execute via VOOI (already supports some HIP-3 markets)');
}

main().catch(console.error);
