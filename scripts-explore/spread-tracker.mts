const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Order Book Spread Tracker (3 scans, 30s) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR'];
  const history: Record<string, number[]> = {};
  
  for (let scan = 1; scan <= 3; scan++) {
    for (const coin of coins) {
      const book = await hlInfo({ type: 'l2Book', coin });
      const levels = book?.levels || [];
      const bids = levels[0] || [];
      const asks = levels[1] || [];
      if (bids[0] && asks[0]) {
        const spread = ((parseFloat(asks[0].px) - parseFloat(bids[0].px)) / parseFloat(bids[0].px) * 100);
        if (!history[coin]) history[coin] = [];
        history[coin].push(spread);
      }
    }
    if (scan < 3) await new Promise(r => setTimeout(r, 30_000));
  }
  
  console.log('Coin     | Spread 1   | Spread 2   | Spread 3   | Avg Spread');
  console.log('─────────|────────────|────────────|────────────|───────────');
  for (const [coin, spreads] of Object.entries(history)) {
    const avg = spreads.reduce((s, x) => s + x, 0) / spreads.length;
    console.log(`${coin.padEnd(9)}| ${spreads.map(s => s.toFixed(4) + '%').join(' | ').padEnd(40)}| ${avg.toFixed(4)}%`);
  }
  
  console.log('\n  Tight spread = high liquidity = better arb execution');
  console.log('  Wide spread = low liquidity = more slippage');
}
main().catch(console.error);
