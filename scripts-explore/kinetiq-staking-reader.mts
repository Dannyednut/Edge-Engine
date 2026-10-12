/**
 * Kinetiq Staking Contract Reader
 * 
 * Reads kHYPE staking contract on HyperEVM
 * Checks: exchange rate, total staked, withdrawal delay
 * 
 * kHYPE contract: 0xfd739d4e423301ce9385c1fb8850539d657c296d
 */
const RPC = 'https://rpc.hyperliquid.xyz/evm';
async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }) });
  return (await r.json()).result || '0x';
}

async function main() {
  console.log('── Kinetiq Staking Contract Reader ──\n');
  
  const kHYPE = '0xfd739d4e423301ce9385c1fb8850539d657c296d';
  
  // Try various staking-related function signatures
  const fns = [
    { sig: '0x18160ddd', name: 'totalSupply()' },
    { sig: '0x313ce567', name: 'decimals()' },
    { sig: '0x95d89b41', name: 'symbol()' },
    { sig: '0x06fdde03', name: 'name()' },
    { sig: '0x8da5cb5b', name: 'owner()' },
    { sig: '0x620ee13c', name: 'exchangeRate()' },
    { sig: '0xe9c8a263', name: 'getTotalStaked()' },
    { sig: '0xc4d7dba6', name: 'getMarketInfo()' },
    { sig: '0xfe8ddea4', name: 'getExchangeRate()' },
    { sig: '0x01e1d114', name: 'totalAssets()' },
    { sig: '0x07a2d13a', name: 'convertToShares()' },
    { sig: '0x3a98ef39', name: 'convertToAssets()' },
    { sig: '0xb69ef8a8', name: 'getStakedAmount()' },
    { sig: '0xf7c6ea8b', name: 'getWithdrawalDelay()' },
    { sig: '0xa5915ae0', name: 'unstakeDelay()' },
    { sig: '0x9e99f3a5', name: 'withdrawalDelay()' },
  ];
  
  console.log('Probing kHYPE contract:\n');
  for (const fn of fns) {
    try {
      const result = await ethCall(kHYPE, fn.sig);
      if (result && result !== '0x' && result.length > 10) {
        let decoded = result;
        if (result.length >= 66) {
          const num = BigInt('0x' + result.slice(2, 66));
          decoded = num.toString();
        }
        if (fn.name.includes('name') || fn.name.includes('symbol')) {
          const str = Buffer.from(result.slice(2), 'hex').toString('utf8').replace(/\0/g, '').trim();
          if (str.length > 0 && str.length < 30) decoded = str;
        }
        console.log(`  ✅ ${fn.name}: ${decoded}`);
      }
    } catch {}
  }
  
  // Check Kinetiq staking manager (different address)
  // Kinetiq staking manager may be at precompile 0x...0801
  console.log('\nProbing Kinetiq staking precompile (0x...0801):');
  for (const fn of fns) {
    try {
      const result = await ethCall('0x0000000000000000000000000000000000000801', fn.sig);
      if (result && result !== '0x' && result.length > 10) {
        let decoded = result;
        if (result.length >= 66) {
          const num = BigInt('0x' + result.slice(2, 66));
          decoded = num.toString();
        }
        console.log(`  ✅ ${fn.name}: ${decoded}`);
      }
    } catch {}
  }
  
  console.log('\n── Significance ──\n');
  console.log('  If we find exchangeRate → can calculate kHYPE yield');
  console.log('  If we find withdrawalDelay → know how long to wait');
  console.log('  If we find staking function → can stake programmatically');
}
main().catch(console.error);
