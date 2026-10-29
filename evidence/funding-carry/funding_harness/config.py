"""Pre-registered configuration: assets, venues, endpoints, decision gate.

Everything decision-relevant is fixed here BEFORE the observation window
begins. The gate block is serialized + hashed (gate_config_sha256) and every
derived-stats report embeds that hash; a mismatch aborts the report rather
than silently comparing against altered thresholds.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Assets (instructor instruction: initially BTC, ETH, SOL where supported)
# ---------------------------------------------------------------------------
ASSETS: tuple[str, ...] = ("BTC", "ETH", "SOL")

# ---------------------------------------------------------------------------
# Sources. `primary` CEX order is the pre-registered fallback order used to
# build the daily gate series (first reachable venue with a complete funding
# observation for the asset wins; deterministic; recorded per observation).
# ---------------------------------------------------------------------------
SOURCES: tuple[str, ...] = (
    "hyperliquid",
    "binance",
    "bybit",
    "okx",
    "mexc",
    "gate",
    "bitget",
    "sharpe",
    "vooi",
)

CEX_SOURCES: tuple[str, ...] = ("binance", "bybit", "okx", "mexc", "gate", "bitget")

# Pre-registered primary-CEX-leg priority (repo venues first: binance/okx/
# bybit/mexc/gate per strategies/cex-hl-funding-arb.ts params; binance was
# HTTP 418 during EI-STRAT-001 and EI-STRAT-002 probes, so in practice the
# first reachable venue is expected to be bybit).
PRIMARY_CEX_PRIORITY: tuple[str, ...] = ("binance", "bybit", "okx", "gate", "bitget", "mexc")

# ---------------------------------------------------------------------------
# Endpoints (all free, public, unauthenticated). Provenance: EI-STRAT-001
# report §2.1/§4.4 (Hyperliquid, VOOI, repo-named CEX set) + packages/
# sharpe-client/src/index.ts (Sharpe public no-auth mirror) + EI-STRAT-002
# reachability probe 2026-10-20 (bybit/okx/gate/bitget/mexc URLs).
# ---------------------------------------------------------------------------
ENDPOINTS = {
    "hyperliquid": "https://api.hyperliquid.xyz/info",
    "binance": "https://fapi.binance.com/fapi/v1/premiumIndex",
    "bybit": "https://api.bybit.com/v5/market/tickers",
    "okx_funding": "https://www.okx.com/api/v5/public/funding-rate",
    "okx_oi": "https://www.okx.com/api/v5/public/open-interest",
    "okx_ticker": "https://www.okx.com/api/v5/market/ticker",
    "mexc": "https://contract.mexc.com/api/v1/contract/funding_rate",
    "gate": "https://api.gateio.ws/api/v4/futures/usdt/contracts",
    "bitget": "https://api.bitget.com/api/v2/mix/market/current-fund-rate",
    "sharpe_funding": "https://www.sharpe.ai/api/funding/rates",
    "sharpe_cross_exchange": "https://www.sharpe.ai/api/arbitrage/cross-exchange",
    "vooi": "https://perps-api.vooi.io/arbitrage-scanner",
}

HTTP_TIMEOUT_S = 25.0
HTTP_RETRIES = 1          # one retry on network error / 5xx (manual tool, no hammering)
HTTP_BACKOFF_S = 2.0
USER_AGENT = "EI-funding-carry-harness/0.1 (read-only evidence collection; Instructor-supervised)"

# Raw-payload storage bound: bodies above this size are stored as a filtered
# projection plus the sha256 of the full body (meta.raw_bounded = true).
MAX_RAW_BYTES = 2 * 1024 * 1024

# ---------------------------------------------------------------------------
# Funding-rate clamp references (REGIME ARTIFACT DETECTORS — observed values,
# NOT official documented caps; used only to flag saturation, never to alter
# a rate).
#   - Hyperliquid: 0.0000125 per 1h  -> 10.95% APR (EI-STRAT-001 [O]:
#     94 assets with OI>$1M pinned at exactly this value on 2026-10-19;
#     re-observed on BTC 2026-10-20).
#   - 8h CEX venues: 0.0001 per 8h  -> 10.95% APR (observed OKX BTC
#     "0.0001000000000000" and Bitget BTC/ETH exactly 0.0001 on 2026-10-20).
# ---------------------------------------------------------------------------
CLAMP_REFERENCES = {
    "hyperliquid": {"rate": 0.0000125, "interval_hours": 1},
    "binance": {"rate": 0.0001, "interval_hours": 8},
    "bybit": {"rate": 0.0001, "interval_hours": 8},
    "okx": {"rate": 0.0001, "interval_hours": 8},
    "mexc": {"rate": 0.0001, "interval_hours": 8},
    "gate": {"rate": 0.0001, "interval_hours": 8},
    "bitget": {"rate": 0.0001, "interval_hours": 8},
}

# ---------------------------------------------------------------------------
# PRE-REGISTERED DECISION GATE (EI-STRAT-001 §4.2 rank-1, carried verbatim
# into the EI-STRAT-002 instruction; MUST NOT be altered after observations
# begin without explicit Instructor approval — enforced via gate_config_sha256).
#
#   Pass candidate for further review:  median net APR > +3%  AND  >= 70%
#     daily persistence across the observation window.
#   Fail/reject candidate:  median net APR < +1.5%  OR  > 2 sign-flips.
#   Insufficient coverage:  UNRESOLVED (never a pass).
#
# Window: >= 14 consecutive days, twice-daily samples, >= 85% sample
# completeness, CEX-leg coverage on >= 3 major assets.
#
# net APR definition (pre-registered by EI-STRAT-001 scenario table §2.1):
#   net_apr = (F_HL_apr - F_CEX_apr) - round_trip_fee_conservative
#   direction: SHORT HL perp + LONG CEX perp (HL short receives when HL
#   funding is positive; CEX long pays when CEX funding is positive).
#   round-trip fee band 0.10%-0.20% (4 taker legs at 2-5 bps); the
#   conservative 0.20% bound is the gate input.
# ---------------------------------------------------------------------------
GATE_CONFIG = {
    "median_net_apr_pass_gt": 0.03,          # strictly greater than +3% (decimal APR)
    "median_net_apr_fail_lt": 0.015,         # strictly less than +1.5%
    "min_daily_persistence": 0.70,           # share of eligible days with median net APR > 0
    "max_sign_flips_fail_gt": 2,             # more than 2 flips in window -> fail
    "window_days_min": 14,                   # consecutive days
    "samples_per_day": 2,                    # twice-daily collection
    "min_sample_completeness": 0.85,         # 85%
    "min_assets_with_cex_leg": 3,            # majors BTC, ETH, SOL
    "round_trip_fee_conservative": 0.002,    # 0.20% of notional (pre-registered)
    "round_trip_fee_optimistic": 0.001,      # 0.10% (context band, non-gate)
    "daily_persistence_definition": (
        "eligible day = UTC calendar day with >=1 complete paired (HL, CEX) "
        "observation for the asset; day is positive when the median of that "
        "day's primary-pair net_apr_pre_registered > 0; persistence = "
        "positive_days / eligible_days"
    ),
    "sign_flip_definition": (
        "count of sign changes between consecutive eligible days' median "
        "net_apr_pre_registered values (positive<->negative; zeros excluded)"
    ),
    "completeness_definition": (
        "per asset: distinct 12h collection slots with >=1 complete paired "
        "observation / (days_spanned * samples_per_day)"
    ),
}


def gate_config_sha256() -> str:
    payload = json.dumps(GATE_CONFIG, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Non-gate sensitivity inputs (clearly labeled context, NOT the gate metric):
# annualized drag of one full 4-leg taker round trip amortized over an
# assumed holding period, using public base-tier taker schedules.
# Provenance: venue public fee pages; HL taker 0.045% at base tier [R], CEX
# base tiers 0.05-0.06% [R]. These are assumptions for sensitivity only.
# ---------------------------------------------------------------------------
ASSUMED_TAKER_FEE_PER_LEG = {
    "hyperliquid": 0.00045,
    "binance": 0.00050,
    "bybit": 0.00055,
    "okx": 0.00050,
    "mexc": 0.00000,
    "gate": 0.00050,
    "bitget": 0.00060,
}
DEFAULT_HOLDING_DAYS_SENSITIVITY = 30

# Gap reason codes (closed vocabulary; anything else is a bug)
GAP_HTTP_ERROR = "http_error"
GAP_NON_JSON = "non_json_payload"
GAP_MALFORMED = "malformed_payload"
GAP_ASSET_MISSING = "asset_not_in_source_response"
GAP_FIELD_MISSING = "required_field_missing"
GAP_SOURCE_DISABLED = "source_disabled"
GAP_SOURCE_EXCEPTION = "source_exception"


@dataclass
class HarnessConfig:
    assets: tuple[str, ...] = ASSETS
    sources: tuple[str, ...] = SOURCES
    base_dir: str = ""            # resolved by cli to <repo>/evidence/funding-carry/data
    gate: dict = field(default_factory=lambda: dict(GATE_CONFIG))

    def snapshot(self) -> dict:
        return {
            "assets": list(self.assets),
            "sources": list(self.sources),
            "gate": self.gate,
            "gate_config_sha256": gate_config_sha256(),
            "primary_cex_priority": list(PRIMARY_CEX_PRIORITY),
            "clamp_references": CLAMP_REFERENCES,
        }
