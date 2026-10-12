const RPC = 'https://rpc.hyperliquid.xyz/evm';
async function rpc(method: string, params: any[]) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }) });
  return (await res.json()).result;
}
async function main() {
  console.log('── HyperEVM Event Log Scanner ──\n');
  const blockNum = parseInt(await rpc('eth_blockNumber'), 16);
  const fromBlock = '0x' + (blockNum - 1000).toString(16);
  try {
    const logs = await rpc('eth_getLogs', [{ fromBlock, toBlock: 'latest' }]);
    if (Array.isArray(logs)) {
      console.log(`Found ${logs.length} logs in last 1000 blocks`);
      // Group by address
      const byAddr: Record<string, number> = {};
      for (const log of logs) { byAddr[log.address] = (byAddr[log.address] || 0) + 1; }
      const sorted = Object.entries(byAddr).sort((a, b) => b[1] - a[1]);
      console.log('\nTop 10 event-emitting contracts:');
      for (const [addr, count] of sorted.slice(0, 10)) {
        console.log(`  ${addr}: ${count} events`);
      }
      // Group by topic0 (event signature)
      const byTopic: Record<string, number> = {};
      for (const log of logs) {
        if (log.topics?.[0]) byTopic[log.topics[0]] = (byTopic[log.topics[0]] || 0) + 1;
      }
      const sortedTopics = Object.entries(byTopic).sort((a, b) => b[1] - a[1]);
      console.log('\nTop 10 event signatures:');
      for (const [topic, count] of sortedTopics.slice(0, 10)) {
        console.log(`  ${topic}: ${count} events`);
      }
    } else {
      console.log('No logs returned');
    }
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 200));
  }
}
main().catch(console.error);
