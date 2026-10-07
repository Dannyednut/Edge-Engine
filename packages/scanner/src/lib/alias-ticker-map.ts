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
  'wen':       { alias: 'alias:wen',       realTicker: 'WEN?',   realName: "Wendys?",                    assetClass: 'unknown' },
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

// ─── Major Index Futures (added Oct 7 2026 — MASSIVE OI) ──────────────
export const ALIAS_MAP_INDICES: Record<string, AliasInfo> = {
  'us100':    { alias: 'alias:us100',    realTicker: 'NDX',    realName: 'Nasdaq 100 Index',          assetClass: 'etf', yahooSymbol: '^NDX' },
  'sp500':    { alias: 'alias:sp500',    realTicker: 'SPX',    realName: 'S&P 500 Index',             assetClass: 'etf', yahooSymbol: '^GSPC' },
  'jp225':    { alias: 'alias:jp225',    realTicker: 'N225',   realName: 'Nikkei 225 Index',          assetClass: 'etf', yahooSymbol: '^N225' },
  'spy':      { alias: 'alias:spy',      realTicker: 'SPY',    realName: 'SPDR S&P 500 ETF',          assetClass: 'etf', yahooSymbol: 'SPY' },
  'qqq':      { alias: 'alias:qqq',      realTicker: 'QQQ',    realName: 'Invesco QQQ Trust (Nasdaq 100)', assetClass: 'etf', yahooSymbol: 'QQQ' },
  'soxl':     { alias: 'alias:soxl',     realTicker: 'SOXL',   realName: 'Direxion Semiconductor Bull 3x ETF', assetClass: 'etf', yahooSymbol: 'SOXL' },
  'soxx':     { alias: 'alias:soxx',     realTicker: 'SOXX',   realName: 'iShares Semiconductor ETF', assetClass: 'etf', yahooSymbol: 'SOXX' },
  'smh':      { alias: 'alias:smh',      realTicker: 'SMH',    realName: 'VanEck Semiconductor ETF',  assetClass: 'etf', yahooSymbol: 'SMH' },
};

// ─── Mega-Cap Tech Stocks (added Oct 7 2026) ──────────────────────────
export const ALIAS_MAP_MEGATECH: Record<string, AliasInfo> = {
  'aapl':     { alias: 'alias:aapl',     realTicker: 'AAPL',   realName: 'Apple',                     assetClass: 'stock-us', yahooSymbol: 'AAPL' },
  'msft':     { alias: 'alias:msft',     realTicker: 'MSFT',   realName: 'Microsoft',                 assetClass: 'stock-us', yahooSymbol: 'MSFT' },
  'googl':    { alias: 'alias:googl',    realTicker: 'GOOGL',  realName: 'Alphabet (Google)',         assetClass: 'stock-us', yahooSymbol: 'GOOGL' },
  'meta':     { alias: 'alias:meta',     realTicker: 'META',   realName: 'Meta Platforms (Facebook)', assetClass: 'stock-us', yahooSymbol: 'META' },
  'nvda':     { alias: 'alias:nvda',     realTicker: 'NVDA',   realName: 'NVIDIA',                    assetClass: 'stock-us', yahooSymbol: 'NVDA' },
  'tsla':     { alias: 'alias:tsla',     realTicker: 'TSLA',   realName: 'Tesla',                     assetClass: 'stock-us', yahooSymbol: 'TSLA' },
  'amzn':     { alias: 'alias:amzn',     realTicker: 'AMZN',   realName: 'Amazon',                    assetClass: 'stock-us', yahooSymbol: 'AMZN' },
  'amd':      { alias: 'alias:amd',      realTicker: 'AMD',    realName: 'Advanced Micro Devices',    assetClass: 'stock-us', yahooSymbol: 'AMD' },
  'avgo':     { alias: 'alias:avgo',     realTicker: 'AVGO',   realName: 'Broadcom',                  assetClass: 'stock-us', yahooSymbol: 'AVGO' },
  'arm':      { alias: 'alias:arm',      realTicker: 'ARM',    realName: 'ARM Holdings',              assetClass: 'stock-us', yahooSymbol: 'ARM' },
  'intc':     { alias: 'alias:intc',     realTicker: 'INTC',   realName: 'Intel',                     assetClass: 'stock-us', yahooSymbol: 'INTC' },
  'mu':       { alias: 'alias:mu',       realTicker: 'MU',     realName: 'Micron Technology',         assetClass: 'stock-us', yahooSymbol: 'MU' },
  'mrvl':     { alias: 'alias:mrvl',     realTicker: 'MRVL',   realName: 'Marvell Technology',        assetClass: 'stock-us', yahooSymbol: 'MRVL' },
  'qcom':     { alias: 'alias:qcom',     realTicker: 'QCOM',   realName: 'Qualcomm',                  assetClass: 'stock-us', yahooSymbol: 'QCOM' },
  'wdc':      { alias: 'alias:wdc',      realTicker: 'WDC',    realName: 'Western Digital',           assetClass: 'stock-us', yahooSymbol: 'WDC' },
  'lite':     { alias: 'alias:lite',     realTicker: 'LITE',   realName: 'Lumentum Holdings',         assetClass: 'stock-us', yahooSymbol: 'LITE' },
  'asml':     { alias: 'alias:asml',     realTicker: 'ASML',   realName: 'ASML Holding',              assetClass: 'stock-us', yahooSymbol: 'ASML' },
  'tsem':     { alias: 'alias:tsem',     realTicker: 'TSEM',   realName: 'Tower Semiconductor',       assetClass: 'stock-us', yahooSymbol: 'TSEM' },
  'seagate':  { alias: 'alias:seagate',  realTicker: 'STX',    realName: 'Seagate Technology',        assetClass: 'stock-us', yahooSymbol: 'STX' },
  'sndk':     { alias: 'alias:sndk',     realTicker: 'SNDK',   realName: 'SanDisk',                   assetClass: 'stock-us', yahooSymbol: 'SNDK' },
  'nbis':     { alias: 'alias:nbis',     realTicker: 'NBIS',   realName: 'Nebius Group (AI)',         assetClass: 'stock-us', yahooSymbol: 'NBIS' },
};

// ─── More US Stocks (added Oct 7 2026) ────────────────────────────────
export const ALIAS_MAP_STOCKS2: Record<string, AliasInfo> = {
  'cost':     { alias: 'alias:cost',     realTicker: 'COST',   realName: 'Costco Wholesale',          assetClass: 'stock-us', yahooSymbol: 'COST' },
  'lly':      { alias: 'alias:lly',      realTicker: 'LLY',    realName: 'Eli Lilly',                 assetClass: 'stock-us', yahooSymbol: 'LLY' },
  'brkb':     { alias: 'alias:brkb',     realTicker: 'BRK.B',  realName: 'Berkshire Hathaway B',      assetClass: 'stock-us', yahooSymbol: 'BRK-B' },
  'ma':       { alias: 'alias:ma',       realTicker: 'MA',     realName: 'Mastercard',                assetClass: 'stock-us', yahooSymbol: 'MA' },
  'orcl':     { alias: 'alias:orcl',     realTicker: 'ORCL',   realName: 'Oracle',                    assetClass: 'stock-us', yahooSymbol: 'ORCL' },
  'vrtx':     { alias: 'alias:vrtx',     realTicker: 'VRTX',   realName: 'Vertex Pharmaceuticals',    assetClass: 'stock-us', yahooSymbol: 'VRTX' },
  'isrg':     { alias: 'alias:isrg',     realTicker: 'ISRG',   realName: 'Intuitive Surgical',        assetClass: 'stock-us', yahooSymbol: 'ISRG' },
  'coin':     { alias: 'alias:coin',     realTicker: 'COIN',   realName: 'Coinbase',                  assetClass: 'stock-us', yahooSymbol: 'COIN' },
  'mrna':     { alias: 'alias:mrna',     realTicker: 'MRNA',   realName: 'Moderna',                   assetClass: 'stock-us', yahooSymbol: 'MRNA' },
  'mstr':     { alias: 'alias:mstr',     realTicker: 'MSTR',   realName: 'MicroStrategy',             assetClass: 'stock-us', yahooSymbol: 'MSTR' },
  'meli':     { alias: 'alias:meli',     realTicker: 'MELI',   realName: 'MercadoLibre',              assetClass: 'stock-us', yahooSymbol: 'MELI' },
  'rklb':     { alias: 'alias:rklb',     realTicker: 'RKLB',   realName: 'Rocket Lab',                assetClass: 'stock-us', yahooSymbol: 'RKLB' },
  'hd':       { alias: 'alias:hd',       realTicker: 'HD',     realName: 'Home Depot',                assetClass: 'stock-us', yahooSymbol: 'HD' },
  'ttwo':     { alias: 'alias:ttwo',     realTicker: 'TTWO',   realName: 'Take-Two Interactive',      assetClass: 'stock-us', yahooSymbol: 'TTWO' },
  'crcl':     { alias: 'alias:crcl',     realTicker: 'CRCL',   realName: 'Circle Internet Group',     assetClass: 'stock-us', yahooSymbol: 'CRCL' },
};

// ─── Private AI Companies (PRE-IPO — massive opportunity!) ────────────
export const ALIAS_MAP_PRIVATE_AI: Record<string, AliasInfo> = {
  'anthropic': { alias: 'alias:anthropic', realTicker: 'PRIVATE', realName: 'Anthropic (Claude AI — PRIVATE)', assetClass: 'stock-us' },
  'openai':    { alias: 'alias:openai',    realTicker: 'PRIVATE', realName: 'OpenAI (ChatGPT — PRIVATE)',      assetClass: 'stock-us' },
  'zhipu':     { alias: 'alias:zhipu',     realTicker: 'PRIVATE', realName: 'Zhipu AI (Chinese AI — PRIVATE)', assetClass: 'stock-intl' },
};

// ─── More Commodities ─────────────────────────────────────────────────
export const ALIAS_MAP_COMMODITIES2: Record<string, AliasInfo> = {
  'silver':   { alias: 'alias:silver',   realTicker: 'XAGUSD', realName: 'Silver (Spot)',             assetClass: 'commodity' },
  'skhynix':  { alias: 'alias:skhynix',  realTicker: '000660.KS', realName: 'SK Hynix (Korean semi)',  assetClass: 'stock-intl', yahooSymbol: '000660.KS' },
  'skhy':     { alias: 'alias:skhy',     realTicker: 'SKHY',   realName: 'SK Hynix ADR?',             assetClass: 'stock-intl' },
};

// Merge all maps
Object.assign(ALIAS_MAP, ALIAS_MAP_INDICES, ALIAS_MAP_MEGATECH, ALIAS_MAP_STOCKS2, ALIAS_MAP_PRIVATE_AI, ALIAS_MAP_COMMODITIES2);
