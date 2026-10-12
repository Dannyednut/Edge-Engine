const RPC = 'https://rpc.hyperliquid.xyz/evm';
async function rpc(method: string, params: any[]) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }) });
  return (await res.json()).result;
}
async function main() {
  console.log('── HyperEVM Token Transfer Monitor ──\n');
  const blockNum = parseInt(await rpc('eth_blockNumber'), 16);
  console.log(`Current block: ${blockNum}`);
  
  // Check recent blocks for ERC20 Transfer events
  // Transfer() event signature: 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const fromBlock = '0x' + (blockNum - 500).toString(16);
  
  try {
    const logs = await rpc('eth_getLogs', [{ fromBlock, toBlock: 'latest', topics: [transferTopic] }]);
    if (Array.isArray(logs) && logs.length > 0) {
      console.log(`Found ${logs.length} Transfer events in last 500 blocks\n`);
      // Group by token contract
      const byToken: Record<string, number> = {};
      for (const log of logs) { byToken[log.address] = (byToken[log.address] || 0) + 1; }
      const sorted = Object.entries(byToken).sort((a, b) => b[1] - a[1]);
      console.log('Top 10 tokens by transfer count:');
      for (const [addr, count] of sorted.slice(0, 10)) {
        // Try to get token name
        try {
          const nameRes = await rpc('eth_call', [{ to: addr, data: '0x06fdde03' }, 'latest']);
          let name = addr;
          if (nameRes && nameRes !== '0x' && nameRes.length > 10) {
            const str = Buffer.from(nameRes.slice(2), 'hex').toString('utf8').replace(/\0/g, '').trim();
            if (str.length > 0 && str.length < 30) name = str;
          }
          console.log(`  ${name.padEnd(20)} ${addr}: ${count} transfers`);
        } catch {
          console.log(`  ${addr}: ${count} transfers`);
        }
      }
    } else {
      console.log('No Transfer events found');
    }
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 100));
  }
}
main().catch(console.error);
