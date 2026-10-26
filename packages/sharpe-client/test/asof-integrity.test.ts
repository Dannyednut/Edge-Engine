/**
 * EM-STRAT-014-E11 item 1 — SharpeClient meta.asOf integrity tests.
 *
 * Proves:
 *   - crossExchangeFunding preserves a server-provided meta.asOf.
 *   - crossExchangeFunding returns meta.asOf = null when the server omits it
 *     (NEVER Date.now()).
 *   - cexSpotTransfer preserves meta.asOf from {meta:{asOf}} and
 *     {data:{scannerMeta:{asOf}}} shapes.
 *   - cexSpotTransfer returns null when no server timestamp is present.
 *
 * Offline: injects a fake fetchImpl; no network. $0.
 */
import { describe, it, expect } from 'vitest';
import { SharpeClient } from '../src/index.js';

function fakeFetch(json: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => json,
  })) as unknown as typeof fetch;
}

describe('SharpeClient — EM-STRAT-014-E11 item 1: meta.asOf integrity', () => {
  describe('crossExchangeFunding', () => {
    it('T1a: preserves server-provided meta.asOf', async () => {
      const client = new SharpeClient({ fetchImpl: fakeFetch({ data: [{ coin: 'BTC' }], meta: { asOf: 1700000000000 } }) });
      const resp = await client.crossExchangeFunding({});
      expect(resp.meta?.asOf).toBe(1700000000000);
    });

    it('T1b: returns meta.asOf = null when server omits it (NEVER Date.now())', async () => {
      const before = Date.now();
      const client = new SharpeClient({ fetchImpl: fakeFetch({ data: [{ coin: 'BTC' }] }) });
      const resp = await client.crossExchangeFunding({});
      const after = Date.now();
      expect(resp.meta?.asOf).toBeNull();
      // Guard: the value must not be a fabricated Date.now() timestamp.
      if (resp.meta?.asOf !== null) {
        expect(resp.meta!.asOf).toBeLessThan(before);
      }
    });

    it('T1c: public-mirror bare-array response → meta.asOf = null', async () => {
      const client = new SharpeClient({ fetchImpl: fakeFetch([{ coin: 'BTC' }]) });
      const resp = await client.crossExchangeFunding({});
      expect(resp.data).toHaveLength(1);
      expect(resp.meta?.asOf).toBeNull();
    });

    it('T1d: non-finite server asOf (NaN) → null', async () => {
      const client = new SharpeClient({ fetchImpl: fakeFetch({ data: [], meta: { asOf: NaN } }) });
      const resp = await client.crossExchangeFunding({});
      expect(resp.meta?.asOf).toBeNull();
    });
  });

  describe('cexSpotTransfer', () => {
    it('T1e: preserves meta.asOf from {meta:{asOf}} shape', async () => {
      const client = new SharpeClient({ fetchImpl: fakeFetch({ data: [], meta: { asOf: 1700000099999 } }) });
      const resp = await client.cexSpotTransfer({});
      expect(resp.meta?.asOf).toBe(1700000099999);
    });

    it('T1f: preserves meta.asOf from {data:{scannerMeta:{asOf}}} shape', async () => {
      const client = new SharpeClient({ fetchImpl: fakeFetch({ data: { rows: [], scannerMeta: { asOf: 1700000088888 } } }) });
      const resp = await client.cexSpotTransfer({});
      expect(resp.meta?.asOf).toBe(1700000088888);
    });

    it('T1g: bare-array response → meta.asOf = null', async () => {
      const client = new SharpeClient({ fetchImpl: fakeFetch([{ coin: 'ETH' }]) });
      const resp = await client.cexSpotTransfer({});
      expect(resp.meta?.asOf).toBeNull();
    });
  });
});
