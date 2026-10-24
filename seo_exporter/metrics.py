"""Small Prometheus text exposition registry."""

from __future__ import annotations

import threading
from collections.abc import Mapping

from seo_exporter import __version__

LabelSet = tuple[tuple[str, str], ...]


class Registry:
    """Thread-safe gauges and counters rendered as Prometheus text."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._gauges: dict[tuple[str, LabelSet], float] = {}
        self._counters: dict[tuple[str, LabelSet], float] = {}
        self._meta: dict[str, tuple[str, str]] = {
            "seo_exporter_info": ("gauge", "Exporter build information."),
            "seo_exporter_up": (
                "gauge",
                "1 when the latest scrape for the provider succeeded.",
            ),
            "seo_exporter_clicks": (
                "gauge",
                "Clicks over the latest successful scrape.",
            ),
            "seo_exporter_impressions": (
                "gauge",
                "Impressions over the latest successful scrape.",
            ),
            "seo_exporter_ctr": (
                "gauge",
                "Clicks divided by impressions for the latest scrape.",
            ),
            "seo_exporter_position": ("gauge", "Impression-weighted average position."),
            "seo_exporter_rows": ("gauge", "Rows aggregated for the latest scrape."),
            "seo_exporter_last_success_unixtime": (
                "gauge",
                "Unix time of the latest successful scrape.",
            ),
            "seo_exporter_scrape_duration_seconds": (
                "gauge",
                "Duration of the latest scrape attempt.",
            ),
            "seo_exporter_errors_total": ("counter", "Failed scrape attempts."),
        }
        self.set_gauge("seo_exporter_info", 1.0, {"version": __version__})

    def set_gauge(
        self, name: str, value: float, labels: Mapping[str, str] | None = None
    ) -> None:
        """Set a gauge sample.

        Args:
            name: Metric name.
            value: Sample value.
            labels: Label set.
        """
        with self._lock:
            self._gauges[(name, _labels(labels))] = value

    def inc_counter(
        self,
        name: str,
        amount: float = 1.0,
        labels: Mapping[str, str] | None = None,
    ) -> None:
        """Add to a counter sample.

        Args:
            name: Metric name.
            amount: Increment.
            labels: Label set.
        """
        key = (name, _labels(labels))
        with self._lock:
            self._counters[key] = self._counters.get(key, 0.0) + amount

    def render(self) -> str:
        """Render the registry in Prometheus text format.

        Returns:
            Exposition text ending in a newline.
        """
        with self._lock:
            gauges = dict(self._gauges)
            counters = dict(self._counters)
            meta = dict(self._meta)
        lines: list[str] = []
        seen: set[str] = set()
        for name, _labelset in list(gauges) + list(counters):
            if name in seen:
                continue
            seen.add(name)
            kind, help_text = meta.get(name, ("untyped", name))
            lines.append(f"# HELP {name} {help_text}")
            lines.append(f"# TYPE {name} {kind}")
            for (sample_name, labels), value in {**gauges, **counters}.items():
                if sample_name != name:
                    continue
                lines.append(f"{name}{_format_labels(labels)} {_format_value(value)}")
        return "\n".join(lines) + "\n"


def _labels(labels: Mapping[str, str] | None) -> LabelSet:
    if not labels:
        return ()
    return tuple(sorted(labels.items()))


def _format_labels(labels: LabelSet) -> str:
    if not labels:
        return ""
    body = ",".join(f'{key}="{_escape(value)}"' for key, value in labels)
    return "{" + body + "}"


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _format_value(value: float) -> str:
    if value.is_integer():
        return str(int(value))
    return format(value, ".10g")
