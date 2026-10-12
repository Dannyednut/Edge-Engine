/**
 * HyperEVM Contract Scanner
 * 
 * Scans HyperEVM for deployed contracts by:
 *  1. Checking known DeFi protocol addresses
 *  2. Scanning recent blocks for contract deployments
 *  3. Checking addresses from transaction history
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

async function getCode(addr: string): Promise<string> {
  return await rpc('eth_getCode', [addr, 'latest']);
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperEVM Contract Scanner');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get latest block info
  const blockNum = parseInt(await rpc('eth_blockNumber'), 16);
  console.log(`Current block: ${blockNum}`);

  // 2. Scan recent blocks for transactions
  console.log('\n── Scanning Recent Blocks for Transactions ──\n');
  
  const contractAddresses = new Set<string>();
  
  for (let i = 0; i < 50; i++) {
    const blockHex = '0x' + (blockNum - i).toString(16);
    try {
      const block = await rpc('eth_getBlockByNumber', [blockHex, true]);
      if (block && block.transactions) {
        for (const tx of block.transactions) {
          if (tx.to && tx.to !== '0x0000000000000000000000000000000000000000') {
            contractAddresses.add(tx.to);
          }
          // Check if tx created a contract (to is null)
          if (!tx.to && tx.input && tx.input.length > 10) {
            // Contract creation — get receipt
            try {
              const receipt = await rpc('eth_getTransactionReceipt', [tx.hash]);
              if (receipt?.contractAddress) {
                contractAddresses.add(receipt.contractAddress);
                console.log(`  New contract deployed: ${receipt.contractAddress}`);
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  console.log(`\n  Found ${contractAddresses.size} unique contract addresses in last 50 blocks`);

  // 3. Check each address for code
  console.log('\n── Contract Code Check ──\n');
  const verifiedContracts: { addr: string; codeSize: number }[] = [];
  
  for (const addr of Array.from(contractAddresses).slice(0, 50)) {
    const code = await getCode(addr);
    if (code && code !== '0x' && code.length > 4) {
      const codeSize = (code.length - 2) / 2; // bytes
      verifiedContracts.push({ addr, codeSize });
    }
  }

  console.log(`  Verified contracts with code: ${verifiedContracts.length}`);
  for (const c of verifiedContracts.sort((a, b) => b.codeSize - a.codeSize).slice(0, 20)) {
    console.log(`    ${c.addr} (${c.codeSize} bytes)`);
  }

  // 4. Check known DeFi protocol ranges
  console.log('\n── Known Address Range Scan ──\n');
  
  // Check addresses 0x000...0800 through 0x000...0810 (precompile range)
  for (let i = 0x800; i <= 0x810; i++) {
    const addr = '0x' + i.toString(16).padStart(40, '0');
    const code = await getCode(addr);
    if (code && code !== '0x' && code.length > 4) {
      console.log(`  ${addr}: has code (${(code.length - 2) / 2} bytes)`);
    }
  }

  // Check CoreWriter
  const cwCode = await getCode('0x3333333333333333333333333333333333333333');
  console.log(`  CoreWriter (0x3333...): ${cwCode && cwCode !== '0x' ? 'has code' : 'precompile'}`);

  // 5. Check for token contracts (ERC20)
  console.log('\n── ERC20 Token Scan ──\n');
  // Try calling name() and symbol() on discovered contracts
  for (const c of verifiedContracts.slice(0, 10)) {
    try {
      // name() = 0x06fdde03
      const nameRes = await rpc('eth_call', [{ to: c.addr, data: '0x06fdde03' }, 'latest']);
      if (nameRes && nameRes !== '0x' && nameRes.length > 10) {
        const nameHex = nameRes.slice(2);
        const name = Buffer.from(nameHex, 'hex').toString('utf8').replace(/\0/g, '').trim();
        if (name && name.length > 0 && name.length < 50) {
          // symbol() = 0x95d89b41
          const symRes = await rpc('eth_call', [{ to: c.addr, data: '0x95d89b41' }, 'latest']);
          let symbol = '';
          if (symRes && symRes !== '0x' && symRes.length > 10) {
            symbol = Buffer.from(symRes.slice(2), 'hex').toString('utf8').replace(/\0/g, '').trim();
          }
          // decimals() = 0x313ce567
          const decRes = await rpc('eth_call', [{ to: c.addr, data: '0x313ce567' }, 'latest']);
          let decimals = 18;
          if (decRes && decRes !== '0x' && decRes.length >= 66) {
            decimals = parseInt(BigInt('0x' + decRes.slice(2, 66)));
          }
          console.log(`  ${c.addr}: ${name} (${symbol}) ${decimals} decimals`);
        }
      }
    } catch {}
  }

  console.log('\n=== Summary ===');
  console.log(`  Blocks scanned: 50`);
  console.log(`  Unique addresses found: ${contractAddresses.size}`);
  console.log(`  Verified contracts: ${verifiedContracts.length}`);
  console.log(`  Precompile range: 0x800-0x810 checked`);
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Research each verified contract');
  console.log('    2. Check if any are new DeFi protocols');
  console.log('    3. Look for arb opportunities with new protocols');
}

main().catch(console.error);
