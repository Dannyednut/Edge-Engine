const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Perp Index → Name Mapping ──\n');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  // Generate Solidity mapping for smart contract
  console.log('// Solidity mapping for atomic arb contract:');
  console.log('// mapping(uint256 => string) public perpNames;');
  console.log('// mapping(uint256 => uint8) public perpSzDecimals;');
  console.log('');
  
  for (let i = 0; i < Math.min(50, universe.length); i++) {
    const name = universe[i].name;
    const szDec = universe[i].szDecimals;
    const px = parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (vol > 1_000_000) {
      console.log(`// [${i}] = ${name} (szDec=${szDec}, $${px.toFixed(2)}, vol=$${(vol/1e6).toFixed(1)}M)`);
    }
  }
  
  console.log('\n── Top 20 by volume (for arb contract) ──\n');
  const top: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (vol > 5_000_000) top.push({ idx: i, name: universe[i].name, szDec: universe[i].szDecimals, vol });
  }
  top.sort((a, b) => b.vol - a.vol);
  console.log('Index | Name       | szDec | Vol $M');
  console.log('──────|────────────|───────|───────');
  for (const t of top.slice(0, 20)) {
    console.log(`${t.idx.toString().padStart(5)} | ${t.name.padEnd(10)}| ${t.szDec.toString().padStart(5)}| ${(t.vol/1e6).toFixed(1)}`);
  }
}
main().catch(console.error);
