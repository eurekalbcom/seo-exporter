"""Logging filter that removes credential material from log records."""

from __future__ import annotations

import logging
import threading

_MIN_SECRET_LENGTH = 6


class Redactor(logging.Filter):
    """Replace known secret strings with a fixed placeholder.

    Args:
        name: Logger name filter passed to ``logging.Filter``.
    """

    def __init__(self, name: str = "") -> None:
        super().__init__(name)
        self._lock = threading.Lock()
        self._needles: list[str] = []

    def add(self, secret: str) -> None:
        """Remember a secret so later log records cannot contain it.

        Args:
            secret: Sensitive string. Empty and very short values are ignored.
        """
        if len(secret) < _MIN_SECRET_LENGTH:
            return
        with self._lock:
            if secret not in self._needles:
                self._needles.append(secret)

    def filter(self, record: logging.LogRecord) -> bool:
        """Redact the record in place.

        Args:
            record: Log record about to be emitted.

        Returns:
            Always ``True`` so the record is still emitted.
        """
        with self._lock:
            needles = tuple(self._needles)
        rendered = str(record.msg)
        if record.args:
            try:
                rendered = rendered % record.args
            except (TypeError, ValueError):
                rendered = "log record suppressed"
        for needle in needles:
            rendered = rendered.replace(needle, "[redacted]")
        record.msg = rendered
        record.args = ()
        return True


def install_redactor() -> Redactor:
    """Attach one redactor to the root logger and return it.

    Returns:
        The process-wide redactor.
    """
    redactor = Redactor()
    logging.getLogger("seo_exporter").addFilter(redactor)
    return redactor
