const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) return { error: res.status };
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.substring(0, 100) }; }
}

async function main() {
  console.log('── HL API Endpoint Explorer v2 ──\n');
  
  const endpoints = [
    // New endpoints to try
    { name: 'meta', body: { type: 'meta' } },
    { name: 'spotMeta', body: { type: 'spotMeta' } },
    { name: 'allMids', body: { type: 'allMids' } },
    { name: 'refererral', body: { type: 'referral' } },
    { name: 'userFees', body: { type: 'userFees', user: '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A' } },
    { name: 'portfolio', body: { type: 'portfolio', user: '0x7cE80c805d0d1Ed80fEBf779385385389b00a81381A' } },
    { name: 'userFunding', body: { type: 'userFunding', user: '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A' } },
    { name: 'userFills', body: { type: 'userFills', user: '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A' } },
    { name: 'orderStatus', body: { type: 'orderStatus', user: '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A', oid: 1 } },
    { name: 'userOpenOrders', body: { type: 'userOpenOrders', user: '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A' } },
    { name: 'userVaultEquities', body: { type: 'userVaultEquities', user: '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A' } },
    { name: 'vaultDetails', body: { type: 'vaultDetails', vaultAddress: '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A' } },
    { name: 'subAccounts', body: { type: 'subAccounts', user: '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A' } },
    { name: 'userRoleApproval', body: { type: 'userRoleApproval', user: '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A' } },
    { name: 'leaderboard', body: { type: 'leaderboard' } },
    { name: 'recentTrades', body: { type: 'recentTrades', coin: 'BTC' } },
    { name: 'l2Book', body: { type: 'l2Book', coin: 'BTC' } },
    { name: 'candleSnapshot', body: { type: 'candleSnapshot', coin: 'BTC', interval: '1h', startTime: Date.now() - 3600000 } },
    { name: 'fundingHistory', body: { type: 'fundingHistory', coin: 'BTC', startTime: Date.now() - 86400000, endTime: Date.now() } },
  ];
  
  for (const ep of endpoints) {
    try {
      const result = await hlInfo(ep.body);
      if (result?.error) {
        console.log(`  ❌ ${ep.name}: ${result.error}`);
      } else if (Array.isArray(result)) {
        console.log(`  ✅ ${ep.name}: Array (${result.length} items)`);
      } else if (typeof result === 'object' && result !== null) {
        const keys = Object.keys(result);
        console.log(`  ✅ ${ep.name}: Object (${keys.length} keys: ${keys.slice(0, 3).join(', ')})`);
      } else {
        console.log(`  ✅ ${ep.name}: ${typeof result}`);
      }
    } catch (e: any) {
      console.log(`  ❌ ${ep.name}: ${e.message?.substring(0, 50)}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}
main().catch(console.error);
