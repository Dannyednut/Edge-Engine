/**
 * Venue + asset identity canonicalization for funding join paths.
 *
 * EM-STRAT-014-E11 item 4: cross-venue funding data is joined by asset and
 * venue name. Different venues spell the same asset differently (e.g.,
 * Binance uses `1000PEPE` where Hyperliquid uses `PEPE`; some sources use
 * `Hyperliquid` vs `HL` vs `HyperLiquid`). Without canonicalization, the
 * join silently misses matches — or worse, a substring match guesses a
 * false match.
 *
 * This module provides a TABLE-DRIVEN alias map for APPROVED aliases only.
 * Unmapped identities are NOT guessed into a match — they pass through
 * unchanged, and the join fails honestly rather than fabricating a pairing.
 */

/**
 * Approved `1000X`-class asset aliases. Each entry maps a venue-specific
 * spelling to the canonical form. The canonical form is the short symbol
 * (e.g., `PEPE`, not `1000PEPE`).
 *
 * To add a new alias, add an entry here AND add a fixture in the test file.
 * Unlisted aliases are NOT canonicalized — the identity passes through
 * unchanged.
 */
export const ASSET_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  // Binance 1000x-scaled perps → canonical short symbol
  ['1000PEPE', 'PEPE'],
  ['1000SHIB', 'SHIB'],
  ['1000BONK', 'BONK'],
  ['1000FLOKI', 'FLOKI'],
  ['1000LUNC', 'LUNC'],
  ['1000XEC', 'XEC'],
  ['1000RATS', 'RATS'],
  ['1000SATS', 'SATS'],
]);

/**
 * Approved venue aliases. Each entry maps a venue-specific spelling to the
 * canonical lower-case form used in join keys.
 */
export const VENUE_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  ['hyperliquid', 'hyperliquid'],
  ['hl', 'hyperliquid'],
  ['hyperliquid-testnet', 'hyperliquid'],
  ['binance', 'binance'],
  ['binance-futures', 'binance'],
  ['binance_us', 'binance-us'],
  ['okx', 'okx'],
  ['bybit', 'bybit'],
  ['kraken', 'kraken'],
  ['coinbase', 'coinbase'],
  ['mexc', 'mexc'],
  ['gate', 'gate'],
  ['gate-io', 'gate'],
]);

/**
 * Canonicalize an asset symbol. Applies the approved `1000X`-class alias
 * map. Unmapped identities pass through UNCHANGED — they are NOT guessed.
 *
 * Examples:
 *   canonAsset('1000PEPE') → 'PEPE'
 *   canonAsset('PEPE')     → 'PEPE'
 *   canonAsset('BTC')      → 'BTC'
 *   canonAsset('UnknownNewCoin') → 'UnknownNewCoin' (no guess)
 */
export function canonAsset(raw: string): string {
  if (!raw) return raw;
  const upper = raw.toUpperCase();
  const mapped = ASSET_ALIASES.get(upper);
  return mapped ?? upper;
}

/**
 * Canonicalize a venue name. Applies the approved venue alias map.
 * Unmapped identities pass through UNCHANGED (lowercased) — NOT guessed.
 *
 * Examples:
 *   canonVenue('Hyperliquid') → 'hyperliquid'
 *   canonVenue('HL')          → 'hyperliquid'
 *   canonVenue('Binance')     → 'binance'
 *   canonVenue('NewVenue')    → 'newvenue' (no guess)
 */
export function canonVenue(raw: string): string {
  if (!raw) return raw;
  const lower = raw.toLowerCase();
  const mapped = VENUE_ALIASES.get(lower);
  return mapped ?? lower;
}

/**
 * Build a canonical join key for (asset, venue). Two entries that refer to
 * the same economic (asset, venue) pair produce the same key.
 */
export function fundingJoinKey(asset: string, venue: string): string {
  return `${canonAsset(asset)}@${canonVenue(venue)}`;
}
