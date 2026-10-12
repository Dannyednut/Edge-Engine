/**
 * Research: HyperEVM Stablecoins + Bridge Arb
 * 
 * Explore all stablecoins on HyperEVM:
 * - USDC (bridged)
 * - USDT0 (bridged)
 * - USDH (native?)
 * - USDHL (native?)
 * - sUSDe (Ethena)
 * - Other stablecoins
 * 
 * Goal: Find stablecoin arb opportunities
 */

const RPC = 'https://rpc.hyperliquid.xyz/evm';
const HL_API = 'https://api.hyperliquid.xyz/info';

async function rpc(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const data = await res.json() as any;
  return data.result;
}

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  RESEARCH: HyperEVM Stablecoins + Bridge Arb');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get HL spot stablecoin prices
  console.log('── HL Spot Stablecoin Prices ──\n');
  const spotMeta = await hlInfo({ type: 'spotMetaAndAssetCtxs' });
  const universe = spotMeta?.[0]?.universe || [];
  const ctxs = spotMeta?.[1] || [];
  const tokens = spotMeta?.[0]?.tokens || [];

  const stableNames = ['USDC', 'USDT', 'USDT0', 'USDH', 'USDHL', 'USDE', 'sUSDe', 'DAI', 'FRAX', 'USDY', 'DUSD', 'SWELL', 'SOLV', 'HOLD', 'RICH'];
  
  for (let i = 0; i < universe.length; i++) {
    let name = universe[i].name || '';
    if (name.startsWith('@')) {
      const idx = parseInt(name.slice(1));
      if (idx < tokens.length) name = tokens[idx].name || name;
    }
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (markPx > 0 && stableNames.some(s => name.toUpperCase().includes(s))) {
      const dev = ((markPx - 1) * 100).toFixed(4);
      console.log(`  ${name.padEnd(10)} $${markPx.toFixed(6)}  dev=${dev}%  vol=$${(vol/1000).toFixed(0)}k`);
    }
  }

  // 2. Check HyperSwap V3 for stablecoin pools
  console.log('\n── HyperSwap V3 Stablecoin Pools ──\n');
  
  // Check if USDC/USDT0 pool exists
  // We'd need the factory address to query getPool()
  // For now, list known stablecoin addresses on HyperEVM
  const knownStables = [
    { name: 'USDC', addr: '0x2288178a0fca5d3a5dc2c4c4c4c4c4c4c4c4c4c4', note: 'bridged USDC' },
    { name: 'USDT0', addr: 'unknown', note: 'bridged USDT' },
    { name: 'USDH', addr: 'unknown', note: 'HL native stablecoin' },
    { name: 'kHYPE', addr: 'known', note: 'LST (not stable but used as collateral)' },
  ];
  
  for (const s of knownStables) {
    console.log(`  ${s.name.padEnd(10)} ${s.addr} — ${s.note}`);
  }

  // 3. Stablecoin arb strategy
  console.log('\n── Stablecoin Arb Strategy ──\n');
  console.log('  Strategy 1: HL Spot ↔ HyperSwap V3');
  console.log('    - If USDC trades at $1.001 on HL spot');
  console.log('    - And USDC trades at $0.999 on HyperSwap V3');
  console.log('    - Buy on HyperSwap, sell on HL spot');
  console.log('    - Profit: 0.2% per cycle');
  console.log('');
  console.log('  Strategy 2: Stablecoin ↔ HLP Vault');
  console.log('    - Deposit USDC into HLP vault (100% APR)');
  console.log('    - If USDC depegs below $1, buy cheap USDC');
  console.log('    - Deposit into HLP for higher yield');
  console.log('');
  console.log('  Strategy 3: Cross-bridge Arb');
  console.log('    - Bridge USDC from Ethereum to HyperEVM');
  console.log('    - If bridge creates price discrepancy, arb it');
  console.log('    - Risk: bridge time + fees');
  console.log('');

  // 4. Research: what stablecoins exist on HyperEVM?
  console.log('── Research: HyperEVM Stablecoin Inventory ──\n');
  console.log('  Need to check:');
  console.log('    1. USDC contract address on HyperEVM');
  console.log('    2. USDT0 contract address');
  console.log('    3. USDH contract address (if exists)');
  console.log('    4. Any native HyperEVM stablecoins');
  console.log('    5. sUSDe (Ethena) on HyperEVM');
  console.log('');
  console.log('  Method:');
  console.log('    - Check HL spot meta for token addresses');
  console.log('    - Query HyperSwap V3 factory for stablecoin pools');
  console.log('    - Scan HyperEVM for ERC20 tokens with "USD" in name');

  // 5. Check HL perp funding for stablecoin perps
  console.log('\n── HL Perp Stablecoin Funding ──\n');
  const perpMeta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const perpUniverse = perpMeta?.[0]?.universe || [];
  const perpCtxs = perpMeta?.[1] || [];
  
  for (let i = 0; i < perpUniverse.length; i++) {
    const name = perpUniverse[i].name || '';
    const funding = parseFloat(perpCtxs[i]?.funding || '0');
    const vol = parseFloat(perpCtxs[i]?.dayNtlVlm || '0');
    if (funding !== 0 && vol > 100_000 && stableNames.some(s => name.toUpperCase().includes(s))) {
      console.log(`  ${name.padEnd(10)} funding=${(funding * 100).toFixed(4)}%/h  vol=$${(vol/1e6).toFixed(1)}M`);
    }
  }

  console.log('\n=== Next Research Steps ===');
  console.log('  1. Find USDC/USDT0 contract addresses on HyperEVM');
  console.log('  2. Check HyperSwap V3 for USDC/USDT0 pool');
  console.log('  3. Monitor stablecoin prices for depeg events');
  console.log('  4. Build stablecoin arb scanner (HL spot ↔ HyperSwap)');
}

main().catch(console.error);
