const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL User Fees Tracker ──\n');
  
  const agentAddress = process.env.AGENT_EVM_ADDRESS || '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A';
  
  const fees = await hlInfo({ type: 'userFees', user: agentAddress });
  console.log('Agent fee data:');
  console.log(JSON.stringify(fees, null, 2));
  
  if (fees?.dailyUserVlm) {
    console.log('\n── Daily Volume ──');
    for (const day of fees.dailyUserVlm.slice(-7)) {
      console.log(`  ${new Date(day.date).toISOString().substring(0, 10)}: $${parseFloat(day.userVlm).toLocaleString()}`);
    }
  }
  
  if (fees?.feeSchedule) {
    console.log('\n── Fee Schedule ──');
    console.log(`  Maker fee: ${fees.feeSchedule.maker || 'N/A'}`);
    console.log(`  Taker fee: ${fees.feeSchedule.taker || 'N/A'}`);
  }
  
  if (fees?.userCrossRate) {
    console.log(`\n  User cross rate: ${fees.userCrossRate}`);
  }
  
  console.log('\n── Significance ──');
  console.log('  This endpoint tracks our trading volume + fees paid');
  console.log('  When we start live trading:');
  console.log('    1. Track daily volume');
  console.log('    2. Calculate maker/taker fee split');
  console.log('    3. Verify builder code rebate');
  console.log('    4. Compute net P&L after fees');
}
main().catch(console.error);
