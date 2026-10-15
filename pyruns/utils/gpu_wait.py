"""Parse the compact GPU wait rule without importing GPU/runtime providers."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
import math
import re


GPU_WAIT_FORMAT = "GPUS-FREE_GIB-IDLE_PERCENT-STABLE_SECONDS-TIMEOUT_HOURS"
_NUMBER_UNIT = re.compile(r"([0-9]+(?:\.[0-9]*)?|\.[0-9]+)([a-z%]*)", re.IGNORECASE)
_MEMORY_UNITS = {
    "": 1.0, "g": 1.0, "gib": 1.0, "gb": 10**9 / 1024**3,
    "m": 1 / 1024, "mib": 1 / 1024, "mb": 10**6 / 1024**3,
}
_TIME_UNITS = {"s": 1, "sec": 1, "m": 60, "min": 60, "h": 3600, "hr": 3600}


@dataclass(frozen=True)
class GpuWaitRule:
    enabled: bool
    gpu_count: int = 1
    device_ids: tuple[int, ...] = ()
    min_free_memory_gb: float = 0.0
    min_idle_pct: float = 70.0
    stable_seconds: float = 15.0
    max_wait_seconds: float = 172800.0

    @property
    def canonical(self) -> str:
        if not self.enabled:
            return "off"
        selector = (
            "device=" + ",".join(str(index) for index in self.device_ids)
            if self.device_ids else str(self.gpu_count)
        )
        numbers = (
            self.min_free_memory_gb, self.min_idle_pct,
            self.stable_seconds, self.max_wait_seconds / 3600,
        )
        return selector + "-" + "-".join(_plain_number(number) for number in numbers)


def _plain_number(number: float) -> str:
    # Scientific notation can introduce '-' inside a field. Keep saved rules parseable.
    text = format(Decimal(str(number)), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _quantity(text: str, units: dict[str, float | int], field: str) -> float:
    match = _NUMBER_UNIT.fullmatch(text)
    if match is None or match.group(2).lower() not in units:
        raise ValueError(f"invalid {field}: {text!r}")
    number = float(match.group(1)) * units[match.group(2).lower()]
    if not math.isfinite(number):
        raise ValueError(f"{field} must be finite")
    return number


def parse_gpu_wait_rule(value: str) -> GpuWaitRule:
    """Bare numbers use the UI units: GiB, idle %, seconds, and hours."""
    try:
        if not isinstance(value, str):
            raise ValueError("rule must be text")
        text = value.strip().lower()
        if text == "off":
            return GpuWaitRule(enabled=False)
        parts = text.split("-")
        if len(parts) != 5 or any(not part for part in parts):
            raise ValueError("provide all 5 non-empty fields")
        selector = parts[0]
        device_ids: tuple[int, ...] = ()
        if selector.startswith("device="):
            tokens = selector[len("device="):].split(",")
            if any(re.fullmatch(r"[0-9]+", token) is None for token in tokens):
                raise ValueError("device= requires comma-separated non-negative GPU indices")
            device_ids = tuple(int(token) for token in tokens)
            if len(set(device_ids)) != len(device_ids):
                raise ValueError("GPU indices must be unique")
            count = len(device_ids)
        else:
            if re.fullmatch(r"[0-9]+", selector) is None or int(selector) < 1:
                raise ValueError("GPU count must be a positive integer")
            count = int(selector)
        free_memory = _quantity(parts[1], _MEMORY_UNITS, "free memory (GiB)")
        idle = _quantity(parts[2], {"": 1, "%": 1}, "idle percent")
        if not 0 <= idle <= 100:
            raise ValueError("idle percent must be between 0 and 100")
        stable = _quantity(parts[3], {"": 1, **_TIME_UNITS}, "stable time")
        timeout = _quantity(parts[4], {"": 3600, **_TIME_UNITS}, "wait timeout")
        return GpuWaitRule(True, count, device_ids, free_memory, idle, stable, timeout)
    except ValueError as exc:
        raise ValueError(
            f"invalid --gpu-wait: {exc}; use {GPU_WAIT_FORMAT}, e.g. 2-20-70-15-2"
        ) from exc
