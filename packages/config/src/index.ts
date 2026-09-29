/**
 * @edge/config — Centralised configuration loader.
 *
 * Secrets come from env vars (.env file at repo root for local dev).
 * Non-secret config (chains, venues, strategy thresholds) lives in TOML.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig, ChainConfig, ChainId, RiskEnvelope, Venue, LandscapeId } from '@edge/types';

export type { AppConfig } from '@edge/types';

// ─── Tiny TOML parser (we only need flat sections + key=val) ────────────
// Real TOML dep would be ~2MB; we don't need it.

function parseToml(text: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let section = '_root';
  out[section] = {};
  for (const rawLine of text.split('\n')) {
    // Strip inline comments (everything after # not inside a string)
    // Simple heuristic: find # not preceded by a quote
    let line = rawLine;
    const hashIdx = line.indexOf('#');
    if (hashIdx >= 0) {
      // Check if # is inside a quoted string
      const beforeHash = line.slice(0, hashIdx);
      const singleQuotes = (beforeHash.match(/'/g) || []).length;
      const doubleQuotes = (beforeHash.match(/"/g) || []).length;
      if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) {
        line = line.slice(0, hashIdx);
      }
    }
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim();
      if (!out[section]) out[section] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val: unknown = line.slice(eq + 1).trim();
    // strip quotes
    if (typeof val === 'string') {
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
      else if (val.startsWith('[') && val.endsWith(']')) {
        val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      }
    }
    out[section][key] = val;
  }
  return out;
}

function loadEnvFile(repoRoot: string): void {
  try {
    const env = readFileSync(resolve(repoRoot, '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) {
        process.env[k] = v.replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // .env not present — assume env already set by parent process
  }
}

function interpolateEnv(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  // Replace ${VAR_NAME} with process.env.VAR_NAME
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, varName) => process.env[varName] ?? '');
}

export function loadConfig(repoRoot: string = process.cwd()): AppConfig {
  loadEnvFile(repoRoot);

  // Parse chains.toml + strategies.toml
  const chainsToml = parseToml(readFileSync(resolve(repoRoot, 'config', 'chains.toml'), 'utf8'));
  const strategiesToml = parseToml(readFileSync(resolve(repoRoot, 'config', 'strategies.toml'), 'utf8'));

  const chains: Record<string, ChainConfig> = {};
  for (const [section, body] of Object.entries(chainsToml)) {
    if (section === '_root') continue;
    const chainId = section as ChainId;
    const interpolated: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      interpolated[k] = interpolateEnv(v);
    }
    chains[chainId] = {
      chainId,
      rpcHttp: String(interpolated.rpc_http || ''),
      rpcWs: interpolated.rpc_ws ? String(interpolated.rpc_ws) : undefined,
      explorer: String(interpolated.explorer || ''),
      flashloanProvider: interpolated.flashloan_provider as 'aave-v3' | 'spark' | 'morpho' | undefined,
      nativeTokenSymbol: String(interpolated.native_token || 'ETH'),
      gasEstimateUsd: interpolated.gas_estimate_usd ? Number(interpolated.gas_estimate_usd) : undefined,
    };
  }

  // Hardcode venue registry for now — only changes when we add a new venue
  const venues: Record<string, Venue> = VENUE_REGISTRY;

  const risk: RiskEnvelope = {
    maxDailyLossUsd: Number(process.env.MAX_DAILY_LOSS_USD || 200),
    maxPerTradeLossUsd: Number(process.env.MAX_PER_TRADE_LOSS_USD || 50),
    maxConcurrentArbs: Number(process.env.MAX_CONCURRENT_ARBS || 3),
    gasPriceCapMultiplier: Number(process.env.GAS_PRICE_CAP_MULT || 3),
    cooldownAfterLossMs: Number(process.env.COOLDOWN_MS || 5 * 60_000),
    leverageCap: Number(process.env.LEVERAGE_CAP || 3),
  };

  return {
    chains: chains as Record<ChainId, ChainConfig>,
    venues,
    strategies: strategiesToml as unknown as AppConfig['strategies'],
    risk,
    alerts: {
      telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: process.env.TELEGRAM_CHAT_ID || '',
      },
    },
    apis: {
      helius: { apiKey: process.env.HELIUS_API_KEY || '' },
      alchemy: { apiKey: process.env.ALCHEMY_API_KEY || '' },
      sharpe: { apiKey: process.env.SHARPE_API_KEY || undefined },
      vooi:   { apiToken: process.env.VOOI_API_TOKEN || undefined },
      coinglass: { apiKey: process.env.COINGLASS_API_KEY || undefined },
      oddsshopper: { apiKey: process.env.ODDSSHOPPER_API_KEY || undefined },
      polymarket: { walletPrivateKey: process.env.POLYMARKET_WALLET_PK || undefined },
    },
    capital: {
      workingCapitalUsd: Number(process.env.WORKING_CAPITAL_USD || 10_000),
      allocationByLandscape: {
        A_dex_cex:       0.25,
        B_cex_cex:       0.10,
        C_dex_dex:       0.10,
        D_prediction:    0.20,
        E_sports:        0.10,
        F_perps_funding: 0.20,
        G_mev:           0.05,
      } as Record<LandscapeId, number>,
    },
  };
}

export const VENUE_REGISTRY: Record<string, Venue> = {
  // CEX
  binance:    { id: 'binance',    name: 'Binance',    type: 'cex', chains: [], url: 'binance.com',    apiDocs: 'binance-docs.github.io/apidocs', feeBps: 5,  settlement: 'usdt' },
  okx:        { id: 'okx',        name: 'OKX',        type: 'cex', chains: [], url: 'okx.com',        apiDocs: 'okx.com/docs',                  feeBps: 5,  settlement: 'usdt' },
  bybit:      { id: 'bybit',      name: 'Bybit',      type: 'cex', chains: [], url: 'bybit.com',      apiDocs: 'bybit-exchange.github.io/docs',  feeBps: 5.5,settlement: 'usdt' },
  kraken:     { id: 'kraken',     name: 'Kraken',     type: 'cex', chains: [], url: 'kraken.com',     apiDocs: 'docs.kraken.com',                feeBps: 16, settlement: 'usdt' },
  coinbase:   { id: 'coinbase',   name: 'Coinbase',   type: 'cex', chains: [], url: 'coinbase.com',   apiDocs: 'docs.cloud.coinbase.com',        feeBps: 6,  settlement: 'usdc' },
  mexc:       { id: 'mexc',       name: 'MEXC',       type: 'cex', chains: [], url: 'mexc.com',        apiDocs: 'mexcdevelop.github.io/APIDoc',   feeBps: 6,  settlement: 'usdt' },
  gate:       { id: 'gate',       name: 'Gate.io',    type: 'cex', chains: [], url: 'gate.io',         apiDocs: 'gate.com/docs/developers',       feeBps: 5,  settlement: 'usdt' },
  lbank:      { id: 'lbank',      name: 'LBank',      type: 'cex', chains: [], url: 'lbank.com',       apiDocs: 'lbank.com/en-US/docs/index.html',feeBps: 10, settlement: 'usdt' },
  kcex:       { id: 'kcex',       name: 'KCEX',       type: 'cex', chains: [], url: 'kcex.com',                                                   feeBps: 6,  settlement: 'usdt' },

  // DEX — spot
  'uniswap-v3':  { id: 'uniswap-v3',  name: 'Uniswap V3',  type: 'dex', chains: ['ethereum','arbitrum','base','optimism','polygon'], url: 'uniswap.org',  apiDocs: 'docs.uniswap.org', feeBps: 3, settlement: 'on-chain' },
  'uniswap-v4':  { id: 'uniswap-v4',  name: 'Uniswap V4',  type: 'dex', chains: ['ethereum','arbitrum','base','optimism'],            url: 'uniswap.org',  feeBps: 3, settlement: 'on-chain' },
  'sushiswap':   { id: 'sushiswap',   name: 'SushiSwap',   type: 'dex', chains: ['ethereum','arbitrum','base','polygon','bsc'],        url: 'sushi.com',    feeBps: 3, settlement: 'on-chain' },
  camelot:       { id: 'camelot',     name: 'Camelot',     type: 'dex', chains: ['arbitrum'],                                          url: 'camelot.exchange', feeBps: 3, settlement: 'on-chain' },
  aerodrome:     { id: 'aerodrome',   name: 'Aerodrome',   type: 'dex', chains: ['base'],                                              url: 'aerodrome.finance',feeBps: 3, settlement: 'on-chain' },
  baseswap:      { id: 'baseswap',    name: 'BaseSwap',    type: 'dex', chains: ['base'],                                              url: 'baseswap.fi',   feeBps: 3, settlement: 'on-chain' },
  curve:         { id: 'curve',       name: 'Curve',       type: 'dex', chains: ['ethereum','arbitrum','base','polygon'],              url: 'curve.fi',     feeBps: 1, settlement: 'on-chain' },
  balancer:      { id: 'balancer',    name: 'Balancer V2', type: 'dex', chains: ['ethereum','arbitrum','base'],                         url: 'balancer.fi',  feeBps: 2, settlement: 'on-chain' },
  pancakeswap:   { id: 'pancakeswap', name: 'PancakeSwap V3', type: 'dex', chains: ['bsc'],                                            url: 'pancakeswap.finance', feeBps: 1, settlement: 'on-chain' },

  // Solana DEXs
  jupiter:       { id: 'jupiter',     name: 'Jupiter Aggregator', type: 'dex', chains: ['solana'],                                     url: 'jup.ag',         apiDocs: 'station.jup.ag',     settlement: 'on-chain' },
  raydium:       { id: 'raydium',     name: 'Raydium CLMM',  type: 'dex', chains: ['solana'],                                          url: 'raydium.io',     feeBps: 2.5, settlement: 'on-chain' },
  orca:          { id: 'orca',        name: 'Orca Whirlpools', type: 'dex', chains: ['solana'],                                        url: 'orca.so',        feeBps: 2,   settlement: 'on-chain' },
  meteora:       { id: 'meteora',     name: 'Meteora DLMM',  type: 'dex', chains: ['solana'],                                          url: 'meteora.ag',     feeBps: 2,   settlement: 'on-chain' },

  // Perp DEXs
  hyperliquid:   { id: 'hyperliquid', name: 'Hyperliquid',  type: 'perp-dex', chains: [], url: 'hyperliquid.xyz', apiDocs: 'hyperliquid.gitbook.io',  feeBps: 3.5, settlement: 'usdc' },
  pacifica:      { id: 'pacifica',    name: 'Pacifica',     type: 'perp-dex', chains: [], url: 'pacifica.fi',                                       feeBps: 3,   settlement: 'usdc' },
  paradex:       { id: 'paradex',     name: 'Paradex',      type: 'perp-dex', chains: [], url: 'paradex.trade',                                     feeBps: 2.5, settlement: 'usdc' },
  dydx:          { id: 'dydx',        name: 'dYdX v4',      type: 'perp-dex', chains: [], url: 'dydx.exchange',                                     feeBps: 5,   settlement: 'usdc' },
  lighter:       { id: 'lighter',     name: 'Lighter',      type: 'perp-dex', chains: ['zksync'], url: 'lighter.xyz',                                feeBps: 0,   settlement: 'on-chain' },
  aster:         { id: 'aster',       name: 'Aster',        type: 'perp-dex', chains: [], url: 'aster.xyz',                                         feeBps: 3,   settlement: 'usdt' },
  gmx:           { id: 'gmx',         name: 'GMX V2',       type: 'perp-dex', chains: ['arbitrum'], url: 'gmx.io',                                 feeBps: 5,   settlement: 'on-chain' },

  // Prediction markets (non-US)
  polymarket:    { id: 'polymarket',  name: 'Polymarket',   type: 'prediction', chains: ['polygon'], url: 'polymarket.com', apiDocs: 'docs.polymarket.com', settlement: 'usdc' },
  azuro:         { id: 'azuro',       name: 'Azuro',        type: 'prediction', chains: ['ethereum','arbitrum','polygon'], url: 'azuro.org', apiDocs: 'docs.azuro.org', settlement: 'on-chain' },
  overtime:      { id: 'overtime',    name: 'Overtime Markets', type: 'prediction', chains: ['base','arbitrum','optimism'], url: 'overtime.markets', settlement: 'on-chain' },
  zeitgeist:     { id: 'zeitgeist',   name: 'Zeitgeist',    type: 'prediction', chains: [], url: 'zeitgeist.pm', settlement: 'on-chain' },
  manifold:      { id: 'manifold',    name: 'Manifold Markets', type: 'prediction', chains: [], url: 'manifold.markets', settlement: 'usdc' },

  // Sportsbooks (sharp + soft)
  pinnacle:      { id: 'pinnacle',    name: 'Pinnacle (sharp)',   type: 'sportsbook', chains: [], url: 'pinnacle.com',  feeBps: 0, settlement: 'custodial' },
  circa:         { id: 'circa',       name: 'Circa (sharp)',      type: 'sportsbook', chains: [], url: 'circasports.com', settlement: 'custodial' },
  draftkings:    { id: 'draftkings',  name: 'DraftKings (soft)',  type: 'sportsbook', chains: [], url: 'draftkings.com', settlement: 'custodial' },
  fanduel:       { id: 'fanduel',     name: 'FanDuel (soft)',     type: 'sportsbook', chains: [], url: 'fanduel.com',    settlement: 'custodial' },
  betmgm:        { id: 'betmgm',      name: 'BetMGM (soft)',      type: 'sportsbook', chains: [], url: 'betmgm.com',     settlement: 'custodial' },
  betus:         { id: 'betus',       name: 'BetUS (soft)',       type: 'sportsbook', chains: [], url: 'betus.com',      settlement: 'custodial' },

  // Data / execution aggregators
  sharpe:        { id: 'sharpe',      name: 'Sharpe.ai (signal)',  type: 'cex', chains: [], url: 'sharpe.ai',     apiDocs: 'sharpe.ai/docs', settlement: 'custodial' },
  vooi:          { id: 'vooi',        name: 'VOOI (perp exec)',    type: 'perp-dex', chains: [], url: 'vooi.io',       apiDocs: 'perps-api.vooi.io/docs', settlement: 'usdc' },
};
