"""Source registry: importing this package populates REGISTRY."""
from __future__ import annotations

from . import (base, binance, bitget, bybit, gate, hyperliquid, mexc, okx,
               sharpe, vooi)  # noqa: F401
from .base import REGISTRY


def get_fetcher(name: str):
    if name not in REGISTRY:
        raise KeyError(f"unknown source: {name}; known={sorted(REGISTRY)}")
    return REGISTRY[name]


__all__ = ["REGISTRY", "get_fetcher", "base", "binance", "bitget", "bybit",
           "gate", "hyperliquid", "mexc", "okx", "sharpe", "vooi"]
