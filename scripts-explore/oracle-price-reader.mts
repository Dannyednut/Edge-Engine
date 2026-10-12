/**
 * HL Perp Oracle Price Reader
 * Reads prices via HyperEVM precompile 0x...0807
 * This is the SAME method our flashloan arb contract would use
 */
const RPC = 'https://rpc.hyperliquid.xyz/evm';
const HL_API = 'https://api.hyperliquid.xyz/info';

async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }) });
  return (await r.json()).result || '0x';
}

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Perp Oracle Price Reader (Precompile) ──\n');
  
  // Get HL perp universe to map indices to names
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  console.log('Reading perp prices via precompile 0x...0807:\n');
  console.log('Index | Name       | Precompile $ | HL API $    | Match?');
  console.log('──────|────────────|──────────────|─────────────|───────');
  
  const testPerps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; // First 10 perps
  
  for (const idx of testPerps) {
    if (idx >= universe.length) break;
    const name = universe[idx].name;
    const apiPrice = parseFloat(ctxs[idx]?.markPx || '0');
    
    // Read price via precompile
    const data = '0x' + idx.toString(16).padStart(64, '0');
    const result = await ethCall('0x0000000000000000000000000000000000000807', data);
    
    let precompilePrice = 0;
    if (result && result !== '0x' && result.length >= 66) {
      precompilePrice = Number(BigInt('0x' + result.slice(2, 66)));
      // Price is in 6 decimals (USDC precision)
      precompilePrice = precompilePrice / 1e6;
    }
    
    const match = Math.abs(precompilePrice - apiPrice) / apiPrice < 0.001 ? '✅' : '❌';
    console.log(`${idx.toString().padStart(5)} | ${name.padEnd(10)}| $${precompilePrice.toFixed(4).padStart(12)}| $${apiPrice.toFixed(4).padStart(11)}| ${match}`);
  }
  
  console.log('\n── Significance ──\n');
  console.log('  Precompile prices are readable from smart contracts on HyperEVM');
  console.log('  This enables ATOMIC arbitrage:');
  console.log('    1. Read HL perp price via precompile');
  console.log('    2. Read HyperSwap V3 price via slot0()');
  console.log('    3. If spread > threshold:');
  console.log('       a. Flashloan USDC');
  console.log('       b. Buy on cheaper venue');
  console.log('       c. Sell on expensive venue');
  console.log('       d. Repay flashloan');
  console.log('    4. All in ONE transaction — zero inventory risk');
  console.log('');
  console.log('  Gas cost: ~$0.004 per arb (0.10 Gwei × 500k gas)');
  console.log('  Minimum profitable spread: 0.05% (covers gas + flashloan fee)');
}
main().catch(console.error);
