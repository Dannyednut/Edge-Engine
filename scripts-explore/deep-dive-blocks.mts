/**
 * DEEP DIVE: HyperEVM Block Analysis
 * Analyze recent blocks for:
 * - Transaction types (swaps, transfers, contract calls)
 * - Gas usage patterns
 * - Active contracts
 * - MEV opportunities
 */
const RPC = 'https://rpc.hyperliquid.xyz/evm';

async function rpc(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const data = await res.json() as any;
  return data.result;
}

async function main() {
  console.log('── DEEP DIVE: HyperEVM Block Analysis ──\n');

  const latestBlock = parseInt(await rpc('eth_blockNumber'), 16);
  console.log(`Latest block: ${latestBlock}\n`);

  let totalTx = 0;
  let totalGas = 0;
  const contractCalls: Record<string, number> = {};
  const txTypes: Record<string, number> = { transfer: 0, swap: 0, contract: 0, other: 0 };

  // Analyze last 20 blocks
  for (let i = 0; i < 20; i++) {
    const blockHex = '0x' + (latestBlock - i).toString(16);
    const block = await rpc('eth_getBlockByNumber', [blockHex, true]);
    if (!block || !block.transactions) continue;

    for (const tx of block.transactions) {
      totalTx++;
      const gas = parseInt(tx.gas || '0', 16);
      totalGas += gas;

      if (tx.to) {
        contractCalls[tx.to] = (contractCalls[tx.to] || 0) + 1;
        
        // Classify by input data
        if (!tx.input || tx.input === '0x') {
          txTypes.transfer++;
        } else if (tx.input.startsWith('0xa9059cbb')) {
          txTypes.transfer++; // ERC20 transfer
        } else if (tx.input.length > 100) {
          txTypes.contract++;
        } else {
          txTypes.other++;
        }
      } else {
        txTypes.contract++; // contract creation
      }
    }
  }

  console.log('── Block Statistics (last 20 blocks) ──\n');
  console.log(`  Total transactions: ${totalTx}`);
  console.log(`  Avg tx/block: ${(totalTx / 20).toFixed(1)}`);
  console.log(`  Total gas used: ${totalGas}`);
  console.log(`  Avg gas/tx: ${(totalGas / Math.max(1, totalTx)).toFixed(0)}`);
  console.log('');
  console.log('  Transaction types:');
  console.log(`    Transfers: ${txTypes.transfer}`);
  console.log(`    Contract calls: ${txTypes.contract}`);
  console.log(`    Other: ${txTypes.other}`);
  console.log('');
  
  // Top called contracts
  console.log('── Top Called Contracts ──\n');
  const sorted = Object.entries(contractCalls).sort((a, b) => b[1] - a[1]);
  for (const [addr, count] of sorted.slice(0, 10)) {
    console.log(`  ${addr}: ${count} calls`);
  }

  console.log('\n── Analysis ──\n');
  console.log(`  HyperEVM activity: ${totalTx > 100 ? 'HIGH' : totalTx > 20 ? 'MEDIUM' : 'LOW'}`);
  console.log(`  Most active contract: ${sorted[0]?.[0] || 'none'} (${sorted[0]?.[1] || 0} calls)`);
  console.log('');
  console.log('  MEV potential:');
  console.log('    - If high tx volume → more MEV opportunities');
  console.log('    - If contract calls > transfers → DeFi activity');
  console.log('    - Monitor for large swaps → back-running opportunities');
}
main().catch(console.error);
