import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CrossDexArbScanner } from '../src/strategies/cross-dex-arb-scanner.js';
import { mockFetch } from './_setup/offline-mocks.js';

const GECKO_PATH = '/networks/hyperevm/dexes/';
function pool(id: string, name: string, baseTokenId: string, quoteTokenId: string, reserveUsd: number, basePriceQuote: number, quotePriceBase: number) {
  return {
    id: 'hyperevm_' + id,
    attributes: {
      name, reserve_in_usd: String(reserveUsd),
      base_token_price_quote_token: String(basePriceQuote),
      quote_token_price_base_token: String(quotePriceBase),
      base_token_price_usd: String(basePriceQuote), quote_token_price_usd: '1',
    },
    relationships: {
      base_token: { data: { id: baseTokenId } },
      quote_token: { data: { id: quoteTokenId } },
    },
  };
}
function registerDexPools(dexId: string, pools: unknown[], status = 200) {
  mockFetch.register(GECKO_PATH + dexId + '/pools', { status, json: async () => ({ data: pools }) });
}
function makeScanner() {
  return new CrossDexArbScanner({ minSpreadPct: 0.15, minReserveUsd: 50_000, maxSizeUsd: 8_000 });
}
function registerDivergenceFixture() {
  const tokenA = 'hyperevm_0x00000000000000000000000000000000000000a1';
  const tokenB = 'hyperevm_0x00000000000000000000000000000000000000b2';
  registerDexPools('ramses-v3-hyperevm', [pool('ramses-a', 'TOKENA/USDC', tokenA, tokenB, 120_000, 2.0, 0.5)]);
  // Reverse token order: canonical price must still be tokenB per tokenA.
  registerDexPools('hyperswap-v2', [pool('hyperswap-v2-a', 'USDC/TOKENA', tokenB, tokenA, 100_000, 0.49, 2.0408163265)]);
  registerDexPools('hyperswap-v3', [pool('hyperswap-v3-a', 'TOKENA/USDC', tokenA, tokenB, 160_000, 2.0, 0.5)]);
}

describe('CrossDexArbScanner — monitoring-only cross-DEX reference divergence', () => {
  it('canonicalizes token order and emits no fabricated net-profit or executable claim', async () => {
    mockFetch.clear();
    registerDivergenceFixture();
    const alerts = await makeScanner().scan();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.some(a => Math.abs(a.spreadPct - 2) < 0.1)).toBe(true);
    for (const alert of alerts) {
      expect(alert.pairKey).toContain('hyperevm_0x00000000000000000000000000000000000000a1');
      expect(alert.pairKey).toContain('hyperevm_0x00000000000000000000000000000000000000b2');
      expect(alert.priceBasis).toBe('token1 per one token0');
      expect(alert.monitoringOnly).toBe(true);
      expect(alert.executable).toBe(false);
      expect(alert.estimatedProfitUsd).toBeNull();
      expect(alert.netProfitUsd).toBeNull();
      expect(alert.blocker).toMatch(/trade-size execution quotes/);
    }
    expect(mockFetch.calls.filter(call => call.url.includes('geckoterminal')).length).toBe(3);
  });

  it('does not join pools by a shared display name when token IDs differ', async () => {
    mockFetch.clear();
    const a = 'hyperevm_0x00000000000000000000000000000000000000a1';
    const b = 'hyperevm_0x00000000000000000000000000000000000000b2';
    const counterfeit = 'hyperevm_0x00000000000000000000000000000000000000c3';
    registerDexPools('ramses-v3-hyperevm', [pool('ramses-a', 'TOKENA/USDC', a, b, 120_000, 2.0, 0.5)]);
    registerDexPools('hyperswap-v2', [pool('hyperswap-fake', 'TOKENA/USDC', a, counterfeit, 100_000, 1.0, 1.0)]);
    registerDexPools('hyperswap-v3', []);
    expect(await makeScanner().scan()).toEqual([]);
  });

  it('rejects thin pools below the configured reserve floor', async () => {
    mockFetch.clear();
    const a = 'hyperevm_0x00000000000000000000000000000000000000a1';
    const b = 'hyperevm_0x00000000000000000000000000000000000000b2';
    registerDexPools('ramses-v3-hyperevm', [pool('ramses-thin', 'TOKENA/USDC', a, b, 10_000, 2.0, 0.5)]);
    registerDexPools('hyperswap-v2', [pool('hyperswap-thin', 'TOKENA/USDC', a, b, 11_000, 1.8, 0.5555)]);
    registerDexPools('hyperswap-v3', []);
    expect(await makeScanner().scan()).toEqual([]);
  });

  it('fails closed when a GeckoTerminal endpoint returns a non-OK status', async () => {
    mockFetch.clear();
    registerDexPools('ramses-v3-hyperevm', [], 503);
    registerDexPools('hyperswap-v2', []);
    registerDexPools('hyperswap-v3', []);
    await expect(makeScanner().scan()).rejects.toThrow(/HTTP 503/);
  });

  it('caches all three public endpoints for at least 60 seconds', async () => {
    mockFetch.clear();
    registerDivergenceFixture();
    const scanner = makeScanner();
    const first = await scanner.scan();
    const second = await scanner.scan();
    expect(second).toEqual(first);
    expect(mockFetch.calls.filter(call => call.url.includes('geckoterminal')).length).toBe(3);
  });

  it('all-runner dispatches cross-DEX readings as info-only monitoring signals', () => {
    const runner = readFileSync(resolve(__dirname, '../src/runners/all-runner.ts'), 'utf8');
    const match = runner.match(/Process cross-DEX price-divergence alerts[\s\S]*?(?=\n\s*\/\/ Clean dedup map)/);
    expect(match, 'cross-DEX monitoring dispatch block is missing').not.toBeNull();
    const block = match![0];
    expect(block).toContain("severity: 'info'");
    expect(block).toContain('MONITORING ONLY');
    expect(block).toContain('Net profit: UNAVAILABLE');
    expect(block).not.toContain("severity: 'opportunity'");
  });
});
