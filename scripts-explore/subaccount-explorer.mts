const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Sub-Account Explorer ──\n');
  
  const agentAddress = '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A';
  
  // Check sub-accounts
  const subAccounts = await hlInfo({ type: 'subAccounts', user: agentAddress });
  console.log('Sub-accounts:', JSON.stringify(subAccounts, null, 2));
  
  // Check vault details
  const vaultDetails = await hlInfo({ type: 'vaultDetails', vaultAddress: agentAddress });
  console.log('\nVault details:', JSON.stringify(vaultDetails, null, 2));
  
  // Check vault equities
  const vaultEquities = await hlInfo({ type: 'userVaultEquities', user: agentAddress });
  console.log('\nVault equities:', JSON.stringify(vaultEquities, null, 2));
  
  console.log('\n── Analysis ──\n');
  console.log('  subAccounts: Lists sub-accounts for an address');
  console.log('  vaultDetails: Shows vault configuration');
  console.log('  userVaultEquities: Shows vault deposits');
  console.log('');
  console.log('  These endpoints are CRITICAL for vault management:');
  console.log('    1. Create vault → get subAccount address');
  console.log('    2. Depositors send USDC to vault');
  console.log('    3. Track equity via userVaultEquities');
  console.log('    4. Monitor vault via vaultDetails');
  console.log('    5. Trade via subAccount address');
}
main().catch(console.error);
