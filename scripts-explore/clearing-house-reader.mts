const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Clearing House State Reader ──\n');
  
  const agentAddress = '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A';
  
  // Try different endpoint formats
  const attempts = [
    { name: 'clearingHouseState', body: { type: 'clearingHouseState', user: agentAddress } },
    { name: 'spotClearingHouseState', body: { type: 'spotClearingHouseState', user: agentAddress } },
    { name: 'portfolio', body: { type: 'portfolio', user: agentAddress } },
    { name: 'userFees', body: { type: 'userFees', user: agentAddress } },
    { name: 'userFunding', body: { type: 'userFunding', user: agentAddress, startTime: Date.now() - 86400000 } },
    { name: 'userFillsByTime', body: { type: 'userFillsByTime', user: agentAddress, startTime: Date.now() - 86400000 } },
    { name: 'userVaultEquities', body: { type: 'userVaultEquities', user: agentAddress } },
    { name: 'subAccounts', body: { type: 'subAccounts', user: agentAddress } },
  ];
  
  for (const a of attempts) {
    try {
      const result = await hlInfo(a.body);
      if (result?.error) {
        console.log(`  ❌ ${a.name}: ${result.error}`);
      } else if (Array.isArray(result)) {
        console.log(`  ✅ ${a.name}: Array (${result.length} items)`);
        if (result.length > 0 && result.length < 5) {
          console.log(`     Sample: ${JSON.stringify(result[0]).substring(0, 200)}`);
        }
      } else if (typeof result === 'object' && result !== null) {
        const keys = Object.keys(result);
        if (keys.length > 0) {
          console.log(`  ✅ ${a.name}: Object (${keys.length} keys)`);
          // Show key fields
          for (const k of keys.slice(0, 5)) {
            const val = result[k];
            if (typeof val === 'object' && val !== null) {
              console.log(`     ${k}: ${JSON.stringify(val).substring(0, 100)}`);
            } else {
              console.log(`     ${k}: ${val}`);
            }
          }
        } else {
          console.log(`  ✅ ${a.name}: empty object`);
        }
      } else {
        console.log(`  ✅ ${a.name}: ${typeof result}`);
      }
    } catch (e: any) {
      console.log(`  ❌ ${a.name}: ${e.message?.substring(0, 50)}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  
  console.log('\n── When Wallet Funded ──\n');
  console.log('  clearingHouseState: shows positions + margin');
  console.log('  spotClearingHouseState: shows spot balances');
  console.log('  userFees: shows volume + fee schedule');
  console.log('  userFunding: shows funding payments');
  console.log('  userFills: shows trade history');
  console.log('  userVaultEquities: shows vault deposits');
  console.log('  subAccounts: shows vault sub-accounts');
}
main().catch(console.error);
