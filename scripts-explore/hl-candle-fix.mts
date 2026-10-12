const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text.substring(0, 100) }; }
}

async function main() {
  console.log('── HL Candle Snapshot Fix ──\n');
  
  // Try different parameter formats
  const attempts = [
    { name: 'coin + interval', body: { type: 'candleSnapshot', coin: 'BTC', interval: '1h' } },
    { name: 'coin + interval + startTime', body: { type: 'candleSnapshot', coin: 'BTC', interval: '1h', startTime: Date.now() - 3600000 } },
    { name: 'coin + req: { interval, startTime }', body: { type: 'candleSnapshot', coin: 'BTC', req: { interval: '1h', startTime: Date.now() - 3600000 } } },
    { name: 'req: { coin, interval, startTime }', body: { type: 'candleSnapshot', req: { coin: 'BTC', interval: '1h', startTime: Date.now() - 3600000 } } },
    { name: 'coin + req: { interval, startTime, endTime }', body: { type: 'candleSnapshot', coin: 'BTC', req: { interval: '1h', startTime: Date.now() - 3600000, endTime: Date.now() } } },
  ];
  
  for (const a of attempts) {
    try {
      const result = await hlInfo(a.body);
      if (Array.isArray(result)) {
        console.log(`  ✅ ${a.name}: Array (${result.length} candles)`);
        if (result.length > 0) {
          console.log(`     Sample: ${JSON.stringify(result[0]).substring(0, 200)}`);
        }
        break; // Found working format
      } else if (result?.error) {
        console.log(`  ❌ ${a.name}: ${result.error.substring(0, 50)}`);
      } else {
        console.log(`  ❌ ${a.name}: ${JSON.stringify(result).substring(0, 50)}`);
      }
    } catch (e: any) {
      console.log(`  ❌ ${a.name}: ${e.message?.substring(0, 50)}`);
    }
  }
}
main().catch(console.error);
