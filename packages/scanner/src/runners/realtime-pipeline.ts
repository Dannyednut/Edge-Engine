/**
 * Real-Time Data Pipeline — HL WebSocket integration.
 *
 * Subscribes to:
 *   - allMids: all mid prices (updates every ~1s)
 *   - l2Book: L2 order book for top 10 coins (updates on every change)
 *   - trades: real-time trades for top 5 coins
 *
 * Emits DataPoint events that strategies can consume.
 * This replaces the polling approach with real-time push data.
 *
 * Usage: pnpm --filter @edge/scanner start:realtime
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

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

const HL_WS = 'wss://api.hyperliquid.xyz/ws';

const WATCH_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'UNI', 'AAVE', 'CRV'];

interface MidUpdate {
  coin: string;
  price: number;
  ts: number;
}

interface BookUpdate {
  coin: string;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  bidLiquidity: number;
  askLiquidity: number;
  imbalance: number;
  ts: number;
}

interface TradeEvent {
  coin: string;
  side: 'B' | 'S';  // Buy or Sell
  size: number;
  price: number;
  sizeUsd: number;
  ts: number;
}

class RealtimePipeline {
  private ws: WebSocket | null = null;
  private midPrices: Record<string, number> = {};
  private bookData: Record<string, BookUpdate> = {};
  private tradeHistory: TradeEvent[] = [];
  private msgCount = 0;
  private startTime = 0;

  // Callbacks for consumers
  onMidUpdate?: (update: MidUpdate) => void;
  onBookUpdate?: (update: BookUpdate) => void;
  onTrade?: (trade: TradeEvent) => void;

  async start() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  Real-Time Data Pipeline (HL WebSocket)');
    console.log(`  Watching: ${WATCH_COINS.join(', ')}`);
    console.log('═══════════════════════════════════════════════════\n');

    this.startTime = Date.now();
    this.connect();
  }

  private connect() {
    console.log('[ws] connecting...');
    this.ws = new WebSocket(HL_WS);

    this.ws.onopen = () => {
      console.log('[ws] connected');

      // Subscribe to allMids
      this.ws!.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'allMids' }
      }));

      // Subscribe to L2 books for all watch coins
      for (const coin of WATCH_COINS) {
        this.ws!.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'l2Book', coin }
        }));
      }

      // Subscribe to trades for top 5
      for (const coin of WATCH_COINS.slice(0, 5)) {
        this.ws!.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'trades', coin }
        }));
      }

      console.log(`[ws] subscribed to allMids + ${WATCH_COINS.length} l2Books + 5 trade feeds`);
    };

    this.ws.onmessage = (event) => {
      this.msgCount++;
      try {
        const data = JSON.parse(event.data as string);
        this.handleMessage(data);
      } catch {}
    };

    this.ws.onerror = (err) => {
      console.error('[ws] error:', err);
    };

    this.ws.onclose = () => {
      console.log('[ws] disconnected — reconnecting in 3s');
      setTimeout(() => this.connect(), 3000);
    };
  }

  private handleMessage(data: any) {
    const channel = data.channel;
    if (!channel) return;

    if (channel === 'allMids') {
      const mids = data.data?.mids || {};
      for (const [coin, priceStr] of Object.entries(mids)) {
        const price = parseFloat(priceStr as string);
        if (!price || price <= 0) continue;
        this.midPrices[coin] = price;
        this.onMidUpdate?.({ coin, price, ts: Date.now() });
      }
    } else if (channel === 'l2Book') {
      const coin = data.data?.coin;
      const levels = data.data?.levels || [];
      if (!coin || levels.length < 2) return;

      const bids = levels[0] || [];
      const asks = levels[1] || [];
      if (bids.length === 0 || asks.length === 0) return;

      const bestBid = parseFloat(bids[0].px);
      const bestAsk = parseFloat(asks[0].px);
      const mid = (bestBid + bestAsk) / 2;
      const spreadBps = mid > 0 ? (bestAsk - bestBid) / mid * 10000 : 0;

      // Calculate 1% liquidity
      const lowerBound = mid * 0.99;
      const upperBound = mid * 1.01;
      let bidLiq = 0, askLiq = 0;
      for (const b of bids) {
        const px = parseFloat(b.px);
        if (px >= lowerBound) bidLiq += px * parseFloat(b.sz);
      }
      for (const a of asks) {
        const px = parseFloat(a.px);
        if (px <= upperBound) askLiq += px * parseFloat(a.sz);
      }
      const total = bidLiq + askLiq;
      const imbalance = total > 0 ? (bidLiq / total) - 0.5 : 0;

      const update: BookUpdate = {
        coin, bestBid, bestAsk, spreadBps,
        bidLiquidity: bidLiq, askLiquidity: askLiq,
        imbalance, ts: Date.now(),
      };
      this.bookData[coin] = update;
      this.onBookUpdate?.(update);
    } else if (channel === 'trades') {
      const trades = data.data?.trades || [];
      for (const t of trades) {
        const trade: TradeEvent = {
          coin: t.coin,
          side: t.side,
          size: parseFloat(t.sz),
          price: parseFloat(t.px),
          sizeUsd: parseFloat(t.sz) * parseFloat(t.px),
          ts: parseInt(t.time),
        };
        this.tradeHistory.push(trade);
        // Keep only last 1000 trades
        if (this.tradeHistory.length > 1000) this.tradeHistory.shift();
        this.onTrade?.(trade);
      }
    }
  }

  getMidPrices(): Record<string, number> {
    return { ...this.midPrices };
  }

  getBookData(coin: string): BookUpdate | null {
    return this.bookData[coin] || null;
  }

  getRecentTrades(coin?: string, limit = 50): TradeEvent[] {
    let trades = this.tradeHistory;
    if (coin) trades = trades.filter(t => t.coin === coin);
    return trades.slice(-limit);
  }

  getStats() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    return {
      uptime: elapsed,
      totalMessages: this.msgCount,
      messagesPerSec: this.msgCount / elapsed,
      trackedCoins: Object.keys(this.midPrices).length,
      bookUpdates: Object.keys(this.bookData).length,
      tradeCount: this.tradeHistory.length,
    };
  }
}

// Main loop
async function main() {
  const pipeline = new RealtimePipeline();

  // Track large trades (whale activity)
  pipeline.onTrade = (trade) => {
    if (trade.sizeUsd > 100_000) {
      console.log(`[WHALE] ${trade.side === 'B' ? 'BUY' : 'SELL'} ${trade.coin} $${(trade.sizeUsd / 1000).toFixed(0)}k @ $${trade.price.toFixed(2)}`);
    }
  };

  // Track extreme orderbook imbalance
  pipeline.onBookUpdate = (update) => {
    if (Math.abs(update.imbalance) > 0.30) {
      const direction = update.imbalance > 0 ? 'BULLISH' : 'BEARISH';
      console.log(`[IMBALANCE] ${update.coin} ${direction} ${(update.imbalance * 100).toFixed(1)}% spread=${update.spreadBps.toFixed(1)}bps`);
    }
  };

  // Log stats every 60s
  setInterval(() => {
    const stats = pipeline.getStats();
    console.log(`[stats] uptime=${stats.uptime.toFixed(0)}s msgs=${stats.totalMessages} (${stats.messagesPerSec.toFixed(1)}/s) coins=${stats.trackedCoins} books=${stats.bookUpdates} trades=${stats.tradeCount}`);
  }, 60_000);

  await pipeline.start();

  // Keep running
  process.on('SIGINT', () => { console.log('\nStopping...'); process.exit(0); });
  process.on('SIGTERM', () => { console.log('\nStopping...'); process.exit(0); });
}

main().catch(err => { console.error(err); process.exit(1); });
