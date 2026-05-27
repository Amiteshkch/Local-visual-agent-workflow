"""Indicator series aligned 1:1 with the input closes array.

None is used in slots where the indicator is not yet defined (warm-up window).
"""
import numpy as np


def ema_series(closes, period=20):
    n = len(closes)
    out = [None] * n
    if n < period:
        return out
    alpha = 2 / (period + 1)
    seed = float(np.mean(closes[:period]))
    out[period - 1] = float(round(seed, 4))
    for i in range(period, n):
        out[i] = float(round(closes[i] * alpha + out[i - 1] * (1 - alpha), 4))
    return out


def rsi_series(closes, period=14):
    n = len(closes)
    out = [None] * n
    if n <= period:
        return out
    arr = np.asarray(closes, dtype=float)
    deltas = np.diff(arr)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)

    avg_gain = float(gains[:period].mean())
    avg_loss = float(losses[:period].mean())
    rs = avg_gain / avg_loss if avg_loss != 0 else 100.0
    out[period] = round(100 - 100 / (1 + rs), 2)

    for i in range(period + 1, n):
        avg_gain = (avg_gain * (period - 1) + gains[i - 1]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i - 1]) / period
        rs = avg_gain / avg_loss if avg_loss != 0 else 100.0
        out[i] = float(round(100 - 100 / (1 + rs), 2))
    return out
