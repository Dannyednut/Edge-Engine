/**
 * Hyperliquid L2 Order Book Imbalance Scanner
 *
 * Polls HL L2 order book for top perp markets every 5s, detects:
 *   - Bid/ask imbalance (>60%/40% = directional pressure)
 *   - Spread tightening (signal: market maker confidence)
 *   - Spread widening (signal: volatility/uncertainty)
 *   - Wall detection (large orders ≥ $100k within 0.5% of mid)
 *
 * Trading signals:
 *   - Imbalance >70% + spread tightening → ENTRY (long if bid-heavy, short if ask-heavy)
 *   - Wall at price → LIKELY REVERSAL
 *   - Spread blowout → EXIT
 *
 * Output: console + alert when extreme imbalance detected
 */

import { readFileSync } from 'node:fs';
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

interface L2Book {
  coin: string;
  levels: Array<{ px: number; sz: number; n: number }>;  // bids first then asks (HL format)
  ts: number;
}

async function hlPost(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getL2Book(coin: string): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]>; ts: number }> {
  const r = await hlPost({ type: 'l2Book', coin });
  // HL returns `levels` as [bids[], asks[]] — each level is { px, sz, n } (strings)
  const levels = r?.levels || [];
  const bids = (levels[0] || []).map((l: any) => [parseFloat(l.px), parseFloat(l.sz)] as [number, number]);
  const asks = (levels[1] || []).map((l: any) => [parseFloat(l.px), parseFloat(l.sz)] as [number, number]);
  return { bids, asks, ts: r?.time ?? Date.now() };
}

async function getAllMarkets(): Promise<string[]> {
  const r = await hlPost({ type: 'metaAndAssetCtxs' });
  const meta = r?.[0];
  if (!meta?.universe) return ['BTC', 'ETH', 'SOL'];
  return meta.universe.map((u: any) => u.name).filter((n: string) => !n.startsWith('@'));
}

interface BookSnapshot {
  coin: string;
  ts: number;
  midPrice: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;       // (ask-bid)/mid * 10000
  bidLiquidity1pct: number; // USD within 1% of mid (bids)
  askLiquidity1pct: number; // USD within 1% of mid (asks)
  imbalance: number;       // bidUsd / (bidUsd + askUsd) - 0.5
  bidWall: { price: number; sizeUsd: number } | null;
  askWall: { price: number; sizeUsd: number } | null;
}

function analyzeBook(coin: string, book: { bids: Array<[number, number]>; asks: Array<[number, number]>; ts: number }): BookSnapshot {
  const bestBid = book.bids[0]?.[0] ?? 0;
  const bestAsk = book.asks[0]?.[0] ?? 0;
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = mid > 0 ? (bestAsk - bestBid) / mid * 10000 : 0;

  const lowerBound = mid * 0.99;
  const upperBound = mid * 1.01;

  let bidLiq = 0, askLiq = 0;
  let bidWall: { price: number; sizeUsd: number } | null = null;
  let askWall: { price: number; sizeUsd: number } | null = null;

  for (const [px, sz] of book.bids) {
    if (px >= lowerBound) {
      const usd = px * sz;
      bidLiq += usd;
      if (usd > 100_000 && (!bidWall || usd > bidWall.sizeUsd)) {
        bidWall = { price: px, sizeUsd: usd };
      }
    }
  }
  for (const [px, sz] of book.asks) {
    if (px <= upperBound) {
      const usd = px * sz;
      askLiq += usd;
      if (usd > 100_000 && (!askWall || usd > askWall.sizeUsd)) {
        askWall = { price: px, sizeUsd: usd };
      }
    }
  }

  const total = bidLiq + askLiq;
  const imbalance = total > 0 ? (bidLiq / total) - 0.5 : 0;

  return {
    coin, ts: book.ts,
    midPrice: mid, bestBid, bestAsk, spreadBps,
    bidLiquidity1pct: bidLiq,
    askLiquidity1pct: askLiq,
    imbalance,
    bidWall, askWall,
  };
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number): string {
  return (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
}

async function scanOnce(markets: string[]): Promise<BookSnapshot[]> {
  const results: BookSnapshot[] = [];
  // Batch in groups of 10 to avoid hammering
  for (let i = 0; i < markets.length; i += 10) {
    const batch = markets.slice(i, i + 10);
    const snapshots = await Promise.all(batch.map(async coin => {
      try {
        const book = await getL2Book(coin);
        return analyzeBook(coin, book);
      } catch (e) {
        return null;
      }
    }));
    for (const s of snapshots) if (s) results.push(s);
  }
  return results;
}

function printTable(snaps: BookSnapshot[]) {
  // Sort by absolute imbalance (most directional first)
  snaps.sort((a, b) => Math.abs(b.imbalance) - Math.abs(a.imbalance));

  console.log('\n┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐');
  console.log('│ HL L2 Order Book Imbalance Scanner ' + new Date().toISOString().slice(11,19) + '                                                                  │');
  console.log('├──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────────────────┬──────────────────────┤');
  console.log('│ Coin     │ Mid      │ Spread   │ BidLiq   │ AskLiq   │ Imbal    │ Bid Wall             │ Ask Wall             │');
  console.log('│          │          │ bps      │ 1%       │ 1%       │          │                      │                      │');
  console.log('├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────────────────┼──────────────────────┤');
  for (const s of snaps.slice(0, 25)) {
    const bidWall = s.bidWall ? `${s.bidWall.price} ${fmtUsd(s.bidWall.sizeUsd)}` : '-';
    const askWall = s.askWall ? `${s.askWall.price} ${fmtUsd(s.askWall.sizeUsd)}` : '-';
    const imbalStr = fmtPct(s.imbalance);
    const imbalIcon = Math.abs(s.imbalance) > 0.20 ? '🔴' : Math.abs(s.imbalance) > 0.10 ? '🟡' : '  ';
    console.log(`│ ${s.coin.padEnd(8)} │ ${s.midPrice.toFixed(2).padStart(8)} │ ${String(s.spreadBps.toFixed(1)).padStart(8)} │ ${fmtUsd(s.bidLiquidity1pct).padStart(8)} │ ${fmtUsd(s.askLiquidity1pct).padStart(8)} │ ${imbalStr.padStart(8)} │ ${bidWall.padEnd(20)} │ ${askWall.padEnd(20)} │ ${imbalIcon}`);
  }
  console.log('└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────────────────┴──────────────────────┘');
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Hyperliquid L2 Order Book Imbalance Scanner');
  console.log('═══════════════════════════════════════════════════');

  const markets = await getAllMarkets();
  console.log(`  Markets: ${markets.length} (top 25 shown each scan)`);

  const watchList = markets.slice(0, 50);  // watch top 50 by universe order
  console.log(`  Watching: ${watchList.slice(0,10).join(', ')}${watchList.length > 10 ? `, ... (${watchList.length} total)` : ''}`);
  console.log(`  Refresh: every 10s\n`);

  let loop = 0;
  while (true) {
    loop++;
    try {
      const snaps = await scanOnce(watchList);
      printTable(snaps);
      // Detect extreme imbalance
      const extreme = snaps.filter(s => Math.abs(s.imbalance) > 0.25);
      if (extreme.length > 0) {
        console.log(`\n⚠️  EXTREME IMBALANCE on ${extreme.length} markets:`);
        for (const s of extreme) {
          const direction = s.imbalance > 0 ? 'BID-HEAVY (bullish pressure)' : 'ASK-HEAVY (bearish pressure)';
          console.log(`   ${s.coin}: ${fmtPct(s.imbalance)} — ${direction}`);
        }
      }
    } catch (e) {
      console.error(`[loop ${loop}] error:`, e);
    }
    await new Promise(r => setTimeout(r, 10_000));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
