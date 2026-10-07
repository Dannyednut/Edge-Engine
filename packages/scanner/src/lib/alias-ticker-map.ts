/**
 * Alias → Real Ticker Mapping for Hyperliquid HIP-3 tokenized assets.
 *
 * Discovered Oct 7 2026 via VOOI scanner: 298 "alias:" assets on Hyperliquid
 * representing tokenized stocks, commodities, forex, and ETFs.
 *
 * This mapping helps identify what each alias represents for:
 *   - Better alert messages (show real ticker, not just "alias:unh")
 *   - Filtering by asset class (stocks vs commodities vs forex)
 *   - Cross-referencing with real-world price feeds
 */

export type AliasAssetClass = 'stock-us' | 'stock-intl' | 'commodity' | 'forex' | 'etf' | 'crypto' | 'unknown';

export interface AliasInfo {
  alias: string;
  realTicker: string;
  realName: string;
  assetClass: AliasAssetClass;
  yahooSymbol?: string;  // for Yahoo Finance price lookup
}

export const ALIAS_MAP: Record<string, AliasInfo> = {
  // US Stocks
  'adi':    { alias: 'alias:adi',    realTicker: 'ADI',    realName: 'Analog Devices',           assetClass: 'stock-us', yahooSymbol: 'ADI' },
  'acn':    { alias: 'alias:acn',    realTicker: 'ACN',    realName: 'Accenture',                assetClass: 'stock-us', yahooSymbol: 'ACN' },
  'ge':     { alias: 'alias:ge',     realTicker: 'GE',     realName: 'General Electric',         assetClass: 'stock-us', yahooSymbol: 'GE' },
  'bac':    { alias: 'alias:bac',    realTicker: 'BAC',    realName: 'Bank of America',          assetClass: 'stock-us', yahooSymbol: 'BAC' },
  'futu':   { alias: 'alias:futu',   realTicker: 'FUTU',   realName: 'Futu Holdings',            assetClass: 'stock-us', yahooSymbol: 'FUTU' },
  'unh':    { alias: 'alias:unh',    realTicker: 'UNH',    realName: 'UnitedHealth Group',       assetClass: 'stock-us', yahooSymbol: 'UNH' },
  'rddt':   { alias: 'alias:rddt',   realTicker: 'RDDT',   realName: 'Reddit',                   assetClass: 'stock-us', yahooSymbol: 'RDDT' },
  'bkng':   { alias: 'alias:bkng',   realTicker: 'BKNG',   realName: 'Booking Holdings',         assetClass: 'stock-us', yahooSymbol: 'BKNG' },
  'anet':   { alias: 'alias:anet',   realTicker: 'ANET',   realName: 'Arista Networks',          assetClass: 'stock-us', yahooSymbol: 'ANET' },
  'amc':    { alias: 'alias:amc',    realTicker: 'AMC',    realName: 'AMC Entertainment',        assetClass: 'stock-us', yahooSymbol: 'AMC' },
  'gs':     { alias: 'alias:gs',     realTicker: 'GS',     realName: 'Goldman Sachs',            assetClass: 'stock-us', yahooSymbol: 'GS' },
  'mcd':    { alias: 'alias:mcd',    realTicker: 'MCD',    realName: "McDonald's",               assetClass: 'stock-us', yahooSymbol: 'MCD' },
  'xom':    { alias: 'alias:xom',    realTicker: 'XOM',    realName: 'Exxon Mobil',              assetClass: 'stock-us', yahooSymbol: 'XOM' },
  'dell':   { alias: 'alias:dell',   realTicker: 'DELL',   realName: 'Dell Technologies',        assetClass: 'stock-us', yahooSymbol: 'DELL' },
  'okta':   { alias: 'alias:okta',   realTicker: 'OKTA',   realName: 'Okta',                     assetClass: 'stock-us', yahooSymbol: 'OKTA' },
  'twlo':   { alias: 'alias:twlo',   realTicker: 'TWLO',   realName: 'Twilio',                   assetClass: 'stock-us', yahooSymbol: 'TWLO' },
  'zm':     { alias: 'alias:zm',     realTicker: 'ZM',     realName: 'Zoom Video',               assetClass: 'stock-us', yahooSymbol: 'ZM' },
  'cop':    { alias: 'alias:cop',    realTicker: 'COP',    realName: 'ConocoPhillips',           assetClass: 'stock-us', yahooSymbol: 'COP' },
  'ray':    { alias: 'alias:ray',    realTicker: 'RAY',    realName: 'Raydium (Solana DEX)',     assetClass: 'crypto' },
  'aal':    { alias: 'alias:aal',    realTicker: 'AAL',    realName: 'American Airlines',        assetClass: 'stock-us', yahooSymbol: 'AAL' },
  'gpro':   { alias: 'alias:gpro',   realTicker: 'GPRO',   realName: 'GoPro',                    assetClass: 'stock-us', yahooSymbol: 'GPRO' },
  'ccl':    { alias: 'alias:ccl',    realTicker: 'CCL',    realName: 'Carnival Corp',            assetClass: 'stock-us', yahooSymbol: 'CCL' },
  'gfs':    { alias: 'alias:gfs',    realTicker: 'GFS',    realName: 'GlobalFoundries',          assetClass: 'stock-us', yahooSymbol: 'GFS' },
  'twst':   { alias: 'alias:twst',   realTicker: 'TWST',   realName: 'Twist Bioscience',         assetClass: 'stock-us', yahooSymbol: 'TWST' },
  'asx':    { alias: 'alias:asx',    realTicker: 'ASX',    realName: 'ASE Technology Holding',   assetClass: 'stock-us', yahooSymbol: 'ASX' },
  'cien':   { alias: 'alias:cien',   realTicker: 'CIEN',   realName: 'Ciena Corp',               assetClass: 'stock-us', yahooSymbol: 'CIEN' },
  'gev':    { alias: 'alias:gev',    realTicker: 'GEV',    realName: 'GE Vernova',               assetClass: 'stock-us', yahooSymbol: 'GEV' },
  'crdo':   { alias: 'alias:crdo',   realTicker: 'CRDO',   realName: 'Credo Technology',         assetClass: 'stock-us', yahooSymbol: 'CRDO' },
  'aehr':   { alias: 'alias:aehr',   realTicker: 'AEHR',   realName: 'Aehr Test Systems',        assetClass: 'stock-us', yahooSymbol: 'AEHR' },
  'path':   { alias: 'alias:path',   realTicker: 'PATH',   realName: 'UiPath',                   assetClass: 'stock-us', yahooSymbol: 'PATH' },
  'trump':  { alias: 'alias:trump',  realTicker: 'MAGA',   realName: 'Trump meme token (MAGA)',  assetClass: 'crypto' },

  // International Stocks
  'softbank': { alias: 'alias:softbank', realTicker: '9984.T', realName: 'SoftBank Group',      assetClass: 'stock-intl', yahooSymbol: '9984.T' },
  'samsung':  { alias: 'alias:samsung',  realTicker: '005930.KS', realName: 'Samsung Electronics', assetClass: 'stock-intl', yahooSymbol: '005930.KS' },
  'hyundai':  { alias: 'alias:hyundai',  realTicker: '005380.KS', realName: 'Hyundai Motor',     assetClass: 'stock-intl', yahooSymbol: '005380.KS' },
  'kioxia':   { alias: 'alias:kioxia',   realTicker: 'KIOX', realName: 'Kioxia Holdings',       assetClass: 'stock-intl' },
  'niulai':   { alias: 'alias:niulai',   realTicker: 'NIULAI', realName: 'Niulai (Chinese token)',  assetClass: 'crypto' },

  // Commodities
  'gold':      { alias: 'alias:gold',      realTicker: 'XAUUSD', realName: 'Gold (Spot)',      assetClass: 'commodity' },
  'brent':     { alias: 'alias:brent',     realTicker: 'BZ',     realName: 'Brent Crude Oil',  assetClass: 'commodity' },
  'wti':       { alias: 'alias:wti',       realTicker: 'CL',     realName: 'WTI Crude Oil',    assetClass: 'commodity' },
  'natgas':    { alias: 'alias:natgas',    realTicker: 'NG',     realName: 'Natural Gas (Henry Hub)', assetClass: 'commodity' },
  'platinum':  { alias: 'alias:platinum',  realTicker: 'PL',     realName: 'Platinum',         assetClass: 'commodity' },
  'palladium': { alias: 'alias:palladium', realTicker: 'PA',     realName: 'Palladium',        assetClass: 'commodity' },
  'copper':    { alias: 'alias:copper',    realTicker: 'HG',     realName: 'Copper',           assetClass: 'commodity' },

  // Forex
  'jpy':       { alias: 'alias:jpy',       realTicker: 'JPYUSD', realName: 'Japanese Yen / USD', assetClass: 'forex' },

  // ETFs
  'tlt':       { alias: 'alias:tlt',       realTicker: 'TLT',    realName: 'iShares 20+ Year Treasury ETF', assetClass: 'etf', yahooSymbol: 'TLT' },
  'bot':       { alias: 'alias:bot',       realTicker: 'BOTZ',   realName: 'Global X Bot & AI ETF', assetClass: 'etf', yahooSymbol: 'BOTZ' },
  'urnm':      { alias: 'alias:urnm',      realTicker: 'URNM',   realName: 'Sprott Uranium Miners ETF', assetClass: 'etf', yahooSymbol: 'URNM' },

  // Unknown (need further research)
  'aph':       { alias: 'alias:aph',       realTicker: 'APH',    realName: 'Amphenol Corp',              assetClass: 'stock-us', yahooSymbol: 'APH' },
  'shaz':      { alias: 'alias:shaz',      realTicker: '?',      realName: 'Unknown',                     assetClass: 'unknown' },
  'wen':       { alias: 'alias:wen',       realTicker: 'WEN?',   realName: "Wendy's?",                    assetClass: 'unknown' },
  'bnc':       { alias: 'alias:bnc',       realTicker: '?',      realName: 'Unknown',                     assetClass: 'unknown' },
  'bsp':       { alias: 'alias:bsp',       realTicker: '?',      realName: 'Unknown',                     assetClass: 'unknown' },
  'luna2':     { alias: 'alias:luna2',     realTicker: 'LUNA2',  realName: 'Terra Luna Classic (new?)',   assetClass: 'crypto' },
  'ronin':     { alias: 'alias:ronin',     realTicker: 'RON',    realName: 'Ronin (gaming chain token)',  assetClass: 'crypto' },
};

/** Get alias info from alias string (e.g., "alias:unh" → AliasInfo) */
export function getAliasInfo(alias: string): AliasInfo | null {
  const key = alias.replace('alias:', '').toLowerCase();
  return ALIAS_MAP[key] || null;
}

/** Get all aliases by asset class */
export function getAliasesByClass(assetClass: AliasAssetClass): AliasInfo[] {
  return Object.values(ALIAS_MAP).filter(a => a.assetClass === assetClass);
}

/** Format an alias for display (returns "UNH (UnitedHealth Group)" or "alias:unknown") */
export function formatAlias(alias: string): string {
  const info = getAliasInfo(alias);
  if (!info) return alias;
  return `${info.realTicker} (${info.realName})`;
}
