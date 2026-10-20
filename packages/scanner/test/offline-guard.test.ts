import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockFetch } from './_setup/offline-mocks.js';

// ─── EM-STRAT-006 §2: Offline guard verification ───────────────────────
//
// These tests verify that the offline guard installed by the vitest setup
// file actually blocks unexpected external network requests. The guard
// must throw a clear error explaining how to register a mock or move the
// test to an explicit opt-in integration path.

describe('EM-STRAT-006 §2 — offline guard verification', () => {
  beforeEach(() => {
    mockFetch.clear();
  });
  afterEach(() => {
    mockFetch.clear();
  });

  it('blocks fetch to unregistered external URLs with a clear error', async () => {
    await expect(fetch('https://example.com/api')).rejects.toThrow(
      /EM-STRAT-006 offline guard/,
    );
  });

  it('error message explains how to register a mock', async () => {
    try {
      await fetch('https://api.example.com/data');
      expect.fail('fetch should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('mockFetch.register');
      expect(e.message).toContain('offline-guard.ts');
    }
  });

  it('serves registered mock responses deterministically', async () => {
    mockFetch.register('api.example.com', {
      status: 200,
      json: async () => ({ hello: 'world' }),
    });
    const res = await fetch('https://api.example.com/data');
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body).toEqual({ hello: 'world' });
  });

  it('supports function-based mock responses', async () => {
    mockFetch.register('api.example.com', (url) => ({
      status: 200,
      json: async () => ({ echoed: url }),
    }));
    const res = await fetch('https://api.example.com/data');
    const body = await res.json() as any;
    expect(body.echoed).toBe('https://api.example.com/data');
  });

  it('records all fetch calls for debugging', async () => {
    mockFetch.register('api.example.com', { status: 200, json: async () => ({}) });
    await fetch('https://api.example.com/first');
    await fetch('https://api.example.com/second');
    const urls = mockFetch.calls.map(c => c.url);
    expect(urls).toContain('https://api.example.com/first');
    expect(urls).toContain('https://api.example.com/second');
  });

  it('clear() resets the mock registry and call log', async () => {
    mockFetch.register('api.example.com', { status: 200, json: async () => ({}) });
    await fetch('https://api.example.com/data');
    expect(mockFetch.calls.length).toBeGreaterThan(0);
    mockFetch.clear();
    expect(mockFetch.calls.length).toBe(0);
    // After clear, fetch should be blocked again.
    await expect(fetch('https://api.example.com/data')).rejects.toThrow(/offline guard/);
  });

  it('first-match-wins: earlier registrations take precedence', async () => {
    mockFetch.register('api.example.com', { status: 200, json: async () => ({ first: true }) });
    mockFetch.register('api.example.com', { status: 200, json: async () => ({ second: true }) });
    const res = await fetch('https://api.example.com/data');
    const body = await res.json() as any;
    expect(body).toEqual({ first: true });
  });

  it('blocks the actual external APIs used by scanners when no mock registered', async () => {
    // These are the real external endpoints scanners call. Without mocks,
    // the guard must block all of them.
    const blockedUrls = [
      'https://yields.llama.fi/pools',
      'https://api-boros.pendle.finance/apis/v1/markets',
      'https://api-v2.pendle.finance/core/v2/markets/all?limit=100&skip=0',
      'https://api.hyperliquid.xyz/info',
      'https://perps-api.vooi.io/api/v1/arbitrage',
      'https://api.coingecko.com/api/v3/simple/price',
      'https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT',
    ];
    for (const url of blockedUrls) {
      await expect(fetch(url)).rejects.toThrow(/EM-STRAT-006 offline guard/);
    }
  });
});
