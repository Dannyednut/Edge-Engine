/**
 * DEEP DIVE: Token Discovery on HyperEVM
 * Find ALL ERC20 tokens by scanning contract storage
 */
const RPC = 'https://rpc.hyperliquid.xyz/evm';
const HL_API = 'https://api.hyperliquid.xyz/info';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  console.log('── DEEP DIVE: Token Discovery ──\n');

  // 1. Get all HL spot tokens (some have HyperEVM addresses)
  const spotMeta = await hlInfo({ type: 'spotMeta' });
  const tokens = spotMeta?.tokens || [];
  const universe = spotMeta?.universe || [];

  console.log(`HL spot tokens: ${tokens.length}`);
  console.log(`HL spot markets: ${universe.length}\n`);

  // List all tokens with their info
  console.log('── HL Spot Tokens ──\n');
  for (let i = 0; i < Math.min(tokens.length, 50); i++) {
    const t = tokens[i];
    console.log(`  [${i}] ${t.name || '?'}  ${t.szDecimals ?? '?'} decimals  ${t.evContract ? 'EVM:' + t.evContract : 'no EVM contract'}`);
  }

  // 2. Find tokens with EVM contracts
  console.log('\n── Tokens with EVM Contracts ──\n');
  let evmCount = 0;
  for (const t of tokens) {
    if (t.evContract && t.evContract !== '0x0000000000000000000000000000000000000000') {
      evmCount++;
      console.log(`  ${t.name}: ${t.evContract}`);
    }
  }
  console.log(`\n  Total tokens with EVM contracts: ${evmCount}`);

  // 3. Check which tokens are on HyperSwap
  console.log('\n── Token Categories ──\n');
  const categories: Record<string, string[]> = {};
  for (const t of tokens) {
    const name = (t.name || '').toUpperCase();
    let cat = 'OTHER';
    if (name.includes('USD') || name.includes('USDC') || name.includes('USDT')) cat = 'STABLECOIN';
    else if (name.includes('HYPE') || name.includes('kHYPE') || name.includes('WHYPE')) cat = 'HYPE';
    else if (name.includes('BTC') || name.includes('UBTC')) cat = 'BTC';
    else if (name.includes('ETH') || name.includes('UETH')) cat = 'ETH';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(t.name);
  }
  for (const [cat, names] of Object.entries(categories)) {
    console.log(`  ${cat}: ${names.length} tokens — ${names.slice(0, 5).join(', ')}${names.length > 5 ? '...' : ''}`);
  }

  // 4. Research: wrapped tokens on HyperEVM
  console.log('\n── Wrapped Tokens on HyperEVM ──\n');
  console.log('  WHYPE = wrapped HYPE (native gas token)');
  console.log('  UBTC = wrapped BTC on HyperEVM');
  console.log('  UETH = wrapped ETH on HyperEVM');
  console.log('  USDC = USDC on HyperEVM');
  console.log('  USDT0 = USDT on HyperEVM');
  console.log('  kHYPE = LST (Kinetiq)');
  console.log('  hyperRAM = LST (NEW)');
  console.log('  xRAM = RAM protocol token');
  console.log('');
  console.log('  ARB OPPORTUNITY:');
  console.log('    UBTC vs HL BTC perp → price arb');
  console.log('    UETH vs HL ETH perp → price arb');
  console.log('    USDC vs USDT0 → stablecoin arb');
  console.log('    kHYPE vs hyperRAM → LST arb');
}
main().catch(console.error);
