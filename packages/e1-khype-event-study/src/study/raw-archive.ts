/**
 * EM-STRAT-014-E1 — raw archive decoding.
 *
 * The raw archive mimics the immutable JSONL shape the (future,
 * separately-authorized) deterministic collector would produce:
 * one JSONL line per (chainId, poolAddress | anchor | usdPrice, blockHeight, fields).
 * Scalar chain values are stored exactly as eth_call returns them (hex);
 * tick liquidityNet values are stored as signed decimal strings (declared
 * format — tickLens structs are decoded off-chain in reality).
 *
 * Fail-closed policy:
 *   - A line whose JSON is structurally unparseable, or that lacks a
 *     decodable blockHeight/chainId, poisons the WHOLE replay (the archive
 *     cannot be attributed to blocks -> the study cannot be trusted).
 *   - EM-STRAT-014-E1-R1: chainId is PRESERVED on every decoded record and
 *     the replay fails closed on any record whose chainId differs from the
 *     manifest's — a pool/anchor/USD data set from another chain can never
 *     be accepted into a HyperEVM study, even when every other field looks
 *     valid.
 *   - EM-STRAT-014-E1-R1: pool records carry token0/token1 ADDRESSES which
 *     the replay validates against the census (orientation integrity).
 *   - Field-level defects (bad hex, missing fields, out-of-range values)
 *     are preserved as per-block `unusable` markers so the replay reports
 *     them as counted exclusions with reasons (never silently dropped,
 *     never interpolated over).
 */

import type { TickEntry } from '../v3/tick-walk.js';

export interface AnchorRecord {
  chainId: number;
  blockHeight: number;
  blockTimestampSec: number;
  /** Decoded kHYPEToHYPE raw (uint256, 1e18 scale); null when undecodable. */
  anchorRaw: bigint | null;
  /** Block timestamp of the anchor read (for the staleness gate). */
  anchorReadAtSec: number;
  /** Set when the record exists but a field failed decode/validation. */
  fieldError: string | null;
}

export interface PoolSampleRecord {
  chainId: number;
  blockHeight: number;
  blockTimestampSec: number;
  /** Token addresses as recorded (lowercased for comparison); null when malformed. */
  token0Address: string | null;
  token1Address: string | null;
  sqrtPriceX96: bigint | null;
  tick: number | null;
  liquidity: bigint | null;
  /** V3 fee tier in millionths (uint24) as recorded on-chain. */
  feeTier: number | null;
  tickData: TickEntry[] | null;
  fieldError: string | null;
}

/**
 * EM-STRAT-014-E1-R1: per-block WHYPE/HYPE-to-USD reference price record
 * (provenance-bearing). priceRaw is a uint256 in 1e18 scale: USD per WHYPE
 * with 18 decimal places (e.g. 20 USD -> 0x + (20*10^18).toString(16)).
 * `source` records WHERE the USD price came from — REQUIRED non-empty.
 */
export interface UsdPriceRecord {
  chainId: number;
  blockHeight: number;
  blockTimestampSec: number;
  /** USD per WHYPE, 1e18 scale; null when undecodable/non-positive. */
  priceRaw: bigint | null;
  /** Provenance of the USD price (declared source); null when missing/empty. */
  source: string | null;
  /** Set when the record exists but a field failed decode/validation. */
  fieldError: string | null;
}

export type ArchiveResult<T> =
  | { ok: true; records: T[] }
  | { ok: false; error: string };

const HEX_RE = /^0x[0-9a-fA-F]+$/;

function hexToBigint(v: unknown, field: string): bigint | string {
  if (typeof v !== 'string' || !HEX_RE.test(v)) return `invalid_hex:${field}:${JSON.stringify(v)}`;
  try {
    return BigInt(v);
  } catch {
    return `invalid_hex:${field}:${JSON.stringify(v)}`;
  }
}

function reqInt(v: unknown, field: string): number | string {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    return `invalid_integer:${field}:${JSON.stringify(v)}`;
  }
  return v;
}

function parseLine(line: string): Record<string, unknown> | string {
  try {
    const v = JSON.parse(line) as unknown;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'line_not_object';
    return v as Record<string, unknown>;
  } catch {
    return 'line_not_json';
  }
}

/** Structural failure if blockHeight/chainId are not decodable integers. */
function structuralFields(obj: Record<string, unknown>): { chainId: number; blockHeight: number } | string {
  const chainId = reqInt(obj.chainId, 'chainId');
  if (typeof chainId === 'string') return chainId;
  const blockHeight = reqInt(obj.blockHeight, 'blockHeight');
  if (typeof blockHeight === 'string') return blockHeight;
  return { chainId, blockHeight };
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function parseAnchorJsonl(text: string): ArchiveResult<AnchorRecord> {
  const records: AnchorRecord[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const obj = parseLine(raw);
    if (typeof obj === 'string') return { ok: false, error: `anchor_line_${i + 1}:${obj}` };
    const structural = structuralFields(obj);
    if (typeof structural === 'string') return { ok: false, error: `anchor_line_${i + 1}:${structural}` };
    const { chainId, blockHeight } = structural;

    let anchorRaw: bigint | null = null;
    let anchorReadAtSec = -1;
    let fieldError: string | null = null;

    const decoded = hexToBigint(obj.anchorRawHex, 'anchorRawHex');
    if (typeof decoded === 'string') {
      fieldError = decoded;
    } else {
      anchorRaw = decoded;
      if (anchorRaw === 0n) fieldError = 'anchor_raw_zero';
    }
    const readAt = reqInt(obj.anchorReadAtSec, 'anchorReadAtSec');
    if (typeof readAt === 'string') {
      fieldError = fieldError ?? readAt;
    } else {
      anchorReadAtSec = readAt;
    }
    const ts = reqInt(obj.blockTimestampSec, 'blockTimestampSec');
    if (typeof ts === 'string') {
      // blockTimestamp is structural for ordering; a bad one poisons the replay.
      return { ok: false, error: `anchor_line_${i + 1}:${ts}` };
    }
    records.push({ chainId, blockHeight, blockTimestampSec: ts, anchorRaw, anchorReadAtSec, fieldError });
  }
  return { ok: true, records };
}

function parseTickData(v: unknown): TickEntry[] | string {
  if (!Array.isArray(v)) return 'tick_data_not_array';
  const out: TickEntry[] = [];
  const SIGNED_DEC_RE = /^-?\d+$/;
  for (let i = 0; i < v.length; i++) {
    const e = v[i] as Record<string, unknown> | null;
    if (e === null || typeof e !== 'object') return `tick_data_entry_${i}:not_object`;
    if (typeof e.tick !== 'number' || !Number.isInteger(e.tick)) return `tick_data_entry_${i}:tick_not_integer`;
    if (typeof e.liquidityNetDec !== 'string' || !SIGNED_DEC_RE.test(e.liquidityNetDec)) {
      return `tick_data_entry_${i}:liquidityNet_not_signed_decimal`;
    }
    out.push({ tick: e.tick, liquidityNet: BigInt(e.liquidityNetDec) });
  }
  return out;
}

export function parsePoolJsonl(text: string, expectedAddress: string): ArchiveResult<PoolSampleRecord> {
  const records: PoolSampleRecord[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const obj = parseLine(raw);
    if (typeof obj === 'string') return { ok: false, error: `pool_${expectedAddress}_line_${i + 1}:${obj}` };
    const structural = structuralFields(obj);
    if (typeof structural === 'string') return { ok: false, error: `pool_${expectedAddress}_line_${i + 1}:${structural}` };
    const { chainId, blockHeight } = structural;

    if (typeof obj.poolAddress !== 'string' || obj.poolAddress.toLowerCase() !== expectedAddress) {
      return { ok: false, error: `pool_${expectedAddress}_line_${i + 1}:pool_address_mismatch` };
    }

    let fieldError: string | null = null;
    let token0Address: string | null = null;
    let token1Address: string | null = null;
    let sqrtPriceX96: bigint | null = null;
    let tick: number | null = null;
    let liquidity: bigint | null = null;
    let feeTier: number | null = null;
    let tickData: TickEntry[] | null = null;

    const S = hexToBigint(obj.sqrtPriceX96Hex, 'sqrtPriceX96Hex');
    if (typeof S === 'string') fieldError = fieldError ?? S;
    else sqrtPriceX96 = S;

    const t = reqInt(obj.tick, 'tick');
    if (typeof t === 'string') fieldError = fieldError ?? t;
    else tick = t;

    const L = hexToBigint(obj.liquidityHex, 'liquidityHex');
    if (typeof L === 'string') fieldError = fieldError ?? L;
    else liquidity = L;

    const f = reqInt(obj.feeTierMillionths, 'feeTierMillionths');
    if (typeof f === 'string') fieldError = fieldError ?? f;
    else if (f > 0xffffff) fieldError = fieldError ?? `fee_tier_out_of_range:${f}`;
    else feeTier = f;

    const td = parseTickData(obj.tickData);
    if (typeof td === 'string') fieldError = fieldError ?? td;
    else tickData = td;

    // EM-STRAT-014-E1-R1: token addresses are REQUIRED on pool records
    // (orientation integrity). Malformed -> fieldError (sample excluded,
    // counted); address-vs-census mismatches fail the replay structurally.
    for (const [key, slot] of [['token0Address', 'token0'], ['token1Address', 'token1']] as const) {
      const v = obj[key];
      if (typeof v !== 'string' || !ADDR_RE.test(v)) {
        fieldError = fieldError ?? `invalid_address:${key}:${JSON.stringify(v)}`;
      } else if (slot === 'token0') {
        token0Address = v.toLowerCase();
      } else {
        token1Address = v.toLowerCase();
      }
    }

    const ts = reqInt(obj.blockTimestampSec, 'blockTimestampSec');
    if (typeof ts === 'string') return { ok: false, error: `pool_${expectedAddress}_line_${i + 1}:${ts}` };

    records.push({ chainId, blockHeight, blockTimestampSec: ts, token0Address, token1Address, sqrtPriceX96, tick, liquidity, feeTier, tickData, fieldError });
  }
  return { ok: true, records };
}

export function parseUsdPriceJsonl(text: string): ArchiveResult<UsdPriceRecord> {
  const records: UsdPriceRecord[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const obj = parseLine(raw);
    if (typeof obj === 'string') return { ok: false, error: `usd_price_line_${i + 1}:${obj}` };
    const structural = structuralFields(obj);
    if (typeof structural === 'string') return { ok: false, error: `usd_price_line_${i + 1}:${structural}` };
    const { chainId, blockHeight } = structural;

    let priceRaw: bigint | null = null;
    let source: string | null = null;
    let fieldError: string | null = null;

    const p = hexToBigint(obj.priceRawHex, 'priceRawHex');
    if (typeof p === 'string') {
      fieldError = p;
    } else if (p <= 0n) {
      fieldError = 'usd_price_non_positive';
    } else {
      priceRaw = p;
    }
    if (typeof obj.source !== 'string' || obj.source.trim() === '') {
      // Provenance is REQUIRED — a USD number without a declared source is
      // unusable for the depth conversion (fail closed, counted).
      fieldError = fieldError ?? 'usd_price_source_missing';
    } else {
      source = obj.source;
    }
    const ts = reqInt(obj.blockTimestampSec, 'blockTimestampSec');
    if (typeof ts === 'string') return { ok: false, error: `usd_price_line_${i + 1}:${ts}` };

    records.push({ chainId, blockHeight, blockTimestampSec: ts, priceRaw, source, fieldError });
  }
  return { ok: true, records };
}
