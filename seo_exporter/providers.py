"""Provider error type and aggregated traffic totals."""

from __future__ import annotations

from dataclasses import dataclass


class ProviderError(Exception):
    """A provider call failed without exposing response content.

    Args:
        reason: Stable machine-readable reason.
        status_code: HTTP status when the failure was an HTTP response.
    """

    def __init__(self, reason: str, status_code: int | None = None) -> None:
        self.reason = reason
        self.status_code = status_code
        super().__init__(reason)

    def __str__(self) -> str:
        if self.status_code is None:
            return self.reason
        return f"{self.reason} http_status={self.status_code}"


@dataclass(frozen=True)
class TrafficSnapshot:
    """Aggregated traffic totals. Query text is not retained.

    Attributes:
        clicks: Sum of clicks.
        impressions: Sum of impressions.
        ctr: Clicks divided by impressions, or 0.
        position: Impression-weighted average position, or 0.
        rows: Number of rows that were aggregated.
    """

    clicks: float
    impressions: float
    ctr: float
    position: float
    rows: int


def snapshot_from_rows(rows: list[tuple[float, float, float]]) -> TrafficSnapshot:
    """Build a snapshot from ``(clicks, impressions, position)`` tuples.

    Args:
        rows: Numeric rows. Position is weighted by impressions.

    Returns:
        Aggregated totals.
    """
    clicks = 0.0
    impressions = 0.0
    weighted_position = 0.0
    for row_clicks, row_impressions, row_position in rows:
        clicks += row_clicks
        impressions += row_impressions
        weighted_position += row_position * row_impressions
    ctr = clicks / impressions if impressions else 0.0
    position = weighted_position / impressions if impressions else 0.0
    return TrafficSnapshot(clicks, impressions, ctr, position, len(rows))
