const RPC = 'https://rpc.hyperliquid.xyz/evm';
async function main() {
  console.log('── HyperEVM Gas Price Tracker ──\n');
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 }),
  });
  const data = await res.json();
  const gasPrice = Number(BigInt(data.result)) / 1e9; // Gwei
  console.log(`  Gas price: ${gasPrice.toFixed(2)} Gwei`);
  console.log(`  In WEI: ${data.result}`);
  console.log(`  Estimated tx cost (21k gas): $${(gasPrice * 21000 * 85 / 1e9).toFixed(6)}`);
  console.log(`  Estimated swap cost (~100k gas): $${(gasPrice * 100000 * 85 / 1e9).toFixed(6)}`);
  console.log(`  Estimated flashloan arb (~500k gas): $${(gasPrice * 500000 * 85 / 1e9).toFixed(6)}`);
  console.log('');
  console.log('  HyperEVM gas is very cheap → atomic arb profitable even with small spreads');
}
main().catch(console.error);
