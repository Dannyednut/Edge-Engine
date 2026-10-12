const RPC = 'https://rpc.hyperliquid.xyz/evm';
async function rpc(method: string, params: any[]) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }) });
  return (await res.json()).result;
}
async function main() {
  console.log('── HyperEVM Contract Deployment Tracker ──\n');
  
  const blockNum = parseInt(await rpc('eth_blockNumber'), 16);
  console.log(`Current block: ${blockNum}`);
  
  // Scan last 100 blocks for contract deployments
  let deployments = 0;
  const newContracts: string[] = [];
  
  for (let i = 0; i < 100; i++) {
    const blockHex = '0x' + (blockNum - i).toString(16);
    try {
      const block = await rpc('eth_getBlockByNumber', [blockHex, true]);
      if (!block?.transactions) continue;
      
      for (const tx of block.transactions) {
        // Contract creation: tx.to is null
        if (!tx.to && tx.input && tx.input.length > 10) {
          try {
            const receipt = await rpc('eth_getTransactionReceipt', [tx.hash]);
            if (receipt?.contractAddress) {
              deployments++;
              newContracts.push(receipt.contractAddress);
              if (deployments <= 5) {
                console.log(`  New contract: ${receipt.contractAddress} (block ${blockNum - i})`);
              }
            }
          } catch {}
        }
      }
    } catch {}
  }
  
  console.log(`\n  Total deployments in last 100 blocks: ${deployments}`);
  if (deployments > 5) console.log(`  (showing first 5 only)`);
  
  // Check block time
  const block1 = await rpc('eth_getBlockByNumber', ['0x' + blockNum.toString(16), false]);
  const block2 = await rpc('eth_getBlockByNumber', ['0x' + (blockNum - 1).toString(16), false]);
  if (block1?.timestamp && block2?.timestamp) {
    const blockTime = parseInt(block1.timestamp, 16) - parseInt(block2.timestamp, 16);
    console.log(`  Block time: ${blockTime}s`);
    console.log(`  Blocks per day: ${(86400 / blockTime).toFixed(0)}`);
    console.log(`  Est. deployments per day: ${(deployments * 86400 / blockTime / 100).toFixed(1)}`);
  }
  
  console.log('\n  More deployments = growing ecosystem = more arb opportunities');
}
main().catch(console.error);
