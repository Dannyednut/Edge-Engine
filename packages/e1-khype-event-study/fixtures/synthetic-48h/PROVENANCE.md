# Synthetic fixture provenance (EM-STRAT-014-E1)

**Everything in this directory is SYNTHETIC.** Nothing here was observed on
any chain, venue, or market. No RPC, archive, explorer, or live query was
performed to produce these files. The fixture set exists solely to validate
the offline replay/depth tooling before any future, separately-authorized
collection.

## Generator

| File | Producer |
|---|---|
| `SYNTHETIC-manifest.json` | `src/fixtures/synthetic-generator.ts` → `buildSyntheticManifest()`, canonicalized |
| `raw/anchor.jsonl` | `buildAnchorJsonl()` |
| `raw/0x...a1.jsonl` (primary) | `buildPoolJsonl('primary', ...)` |
| `raw/0x...a2.jsonl` (independence) | `buildPoolJsonl('independence', ...)` |
| `raw/0x...a3.jsonl` (highfee) | `buildPoolJsonl('highfee', ...)` |
| `raw/0x...a4.jsonl` (zeroliq) | `buildPoolJsonl('zeroliq', ...)` |

Regenerate: `pnpm --filter @edge/e1-khype-event-study write-fixtures`
(from the repository root). The generator is deterministic (declared
constants only; no clock, no randomness, no floating point) and re-running
it reproduces these files byte-for-byte. `test/e1-fixtures-provenance.test.ts`
enforces exactly that against the committed copies — hand-edits fail CI.

## Declared synthetic parameters

- Window: 289 samples on a 10-minute grid (48h), blocks `5000000..5014400`
  (blockStep 50), timestamps `1700000000 + i*600` (synthetic clock).
- Anchor: `kHYPEToHYPE = 1e18` (rate exactly 1.0) at every block — a
  declared simplification; real kHYPE rates drift upward over time.
- Tokens: WHYPE/kHYPE, both 18 decimals, price = kHYPE per WHYPE.
- Fees: pool fee tiers 0.01% (a1/a2/a4) and 1.00% (a3); flashloan fee
  0.04% (scanner constant lineage); redemption fee declared `0` — the REAL
  value is UNMEASURED and is E-10's prerequisite.
- Pass-rule parameters: N = 2 events/week, D = $10,000 — SYNTHETIC test
  values, NOT Instructor pre-registrations for a real study.
- Event rules: gross dislocation threshold 0.02%; independence band 0.01%
  (reversion to |d| < band separates events; otherwise excursions merge).
- Liquidity: pools a1/a2/a3 share an exactly-tuned L so that a $10k swap
  from the dip price 1.006 realizes impact(D) = 0.05% (E1-T1's stated
  arithmetic `net = 0.6 - 0.01 - 0.04 - 0.05 = 0.50%` holds exactly).
  Pool a4 has zero liquidity (fail-closed depth path).

## Scenario map

| Grid indices | Pool | Scenario |
|---|---|---|
| 48–66 | a1 | +0.6% discount dip (E1-T1: 1 event, 3h) |
| 20–30, 31–39, 40–50 | a2 | dip / reversion inside band / dip (E1-T2: 2 events) |
| 100–110, 111–119, 120–130 | a2 | dip / reversion outside band / dip (E1-T3: 1 merged event) |
| 60–72 | a3 | +0.6% dip at 1% fee tier (E1-T5: fails rule) |
| 150–160 | a4 | +0.6% dip with zero liquidity (E1-T8: fails closed) |
| 260–263 (anchor) | all | anchor missing / `0x` / stale 1200s / future 900s (E1-T4) |

Raw line formats (declared):

- Pool line: `{chainId, poolAddress, blockHeight, blockTimestampSec,
  sqrtPriceX96Hex, tick, liquidityHex, feeTierMillionths, tickData:[{tick,
  liquidityNetDec}]}` — scalars that eth_call returns as hex are hex;
  tick liquidityNet values are signed decimal strings (tickLens structs are
  decoded off-chain in reality).
- Anchor line: `{chainId, blockHeight, blockTimestampSec, anchorRawHex,
  anchorReadAtSec}`.
