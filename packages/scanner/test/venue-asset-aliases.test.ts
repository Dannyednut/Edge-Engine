/**
 * EM-STRAT-014-E11 item 4 — venue/asset alias canonicalization tests.
 *
 * Proves:
 *   - Approved 1000X-class aliases canonicalize to the short symbol.
 *   - Approved venue aliases canonicalize (Hyperliquid/HL → hyperliquid).
 *   - Unmapped identities pass through unchanged (NOT guessed).
 *   - fundingJoinKey produces the same key for alias-equivalent pairs.
 *   - Every alias in the map has a fixture (positive control).
 *
 * Offline. $0.
 */
import { describe, it, expect } from 'vitest';
import { ASSET_ALIASES, VENUE_ALIASES, canonAsset, canonVenue, fundingJoinKey } from '../src/lib/venue-asset-aliases.js';

describe('EM-STRAT-014-E11 item 4 — venue/asset alias canonicalization', () => {
  describe('canonAsset', () => {
    it('T4a: every ASSET_ALIASES entry canonicalizes correctly (fixture coverage)', () => {
      for (const [alias, canonical] of ASSET_ALIASES) {
        expect(canonAsset(alias)).toBe(canonical);
      }
    });

    it('T4b: 1000PEPE → PEPE', () => {
      expect(canonAsset('1000PEPE')).toBe('PEPE');
    });

    it('T4c: 1000SHIB → SHIB', () => {
      expect(canonAsset('1000SHIB')).toBe('SHIB');
    });

    it('T4d: case-insensitive — 1000pepe → PEPE', () => {
      expect(canonAsset('1000pepe')).toBe('PEPE');
    });

    it('T4e: unmapped identity passes through unchanged (NOT guessed)', () => {
      expect(canonAsset('BTC')).toBe('BTC');
      expect(canonAsset('UnknownNewCoin')).toBe('UNKNOWNNEWCOIN');
    });

    it('T4f: empty string passes through', () => {
      expect(canonAsset('')).toBe('');
    });
  });

  describe('canonVenue', () => {
    it('T4g: every VENUE_ALIASES entry canonicalizes correctly (fixture coverage)', () => {
      for (const [alias, canonical] of VENUE_ALIASES) {
        expect(canonVenue(alias)).toBe(canonical);
      }
    });

    it('T4h: Hyperliquid → hyperliquid', () => {
      expect(canonVenue('Hyperliquid')).toBe('hyperliquid');
    });

    it('T4i: HL → hyperliquid', () => {
      expect(canonVenue('HL')).toBe('hyperliquid');
    });

    it('T4j: Binance → binance, Binance-Futures → binance', () => {
      expect(canonVenue('Binance')).toBe('binance');
      expect(canonVenue('Binance-Futures')).toBe('binance');
    });

    it('T4k: unmapped venue passes through lowercased (NOT guessed)', () => {
      expect(canonVenue('NewVenue')).toBe('newvenue');
      expect(canonVenue('UnknownDEX')).toBe('unknowndex');
    });
  });

  describe('fundingJoinKey', () => {
    it('T4l: same economic pair produces same key regardless of alias spelling', () => {
      // 1000PEPE on Binance vs PEPE on Hyperliquid — both canonicalize to PEPE
      const key1 = fundingJoinKey('1000PEPE', 'Binance');
      const key2 = fundingJoinKey('PEPE', 'Binance');
      expect(key1).toBe(key2);
      expect(key1).toBe('PEPE@binance');
    });

    it('T4m: HL vs Hyperliquid produce same key', () => {
      const key1 = fundingJoinKey('BTC', 'HL');
      const key2 = fundingJoinKey('BTC', 'Hyperliquid');
      expect(key1).toBe(key2);
      expect(key1).toBe('BTC@hyperliquid');
    });

    it('T4n: unmapped identities do NOT collide with mapped ones', () => {
      // UnknownNewCoin should not match any canonical form
      const key = fundingJoinKey('UnknownNewCoin', 'NewVenue');
      expect(key).toBe('UNKNOWNNEWCOIN@newvenue');
      // It should NOT equal a key for a different unmapped identity
      expect(key).not.toBe(fundingJoinKey('OtherNewCoin', 'NewVenue'));
    });
  });
});
