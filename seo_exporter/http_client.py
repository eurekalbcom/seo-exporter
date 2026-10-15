"""HTTP helper that does not log bodies, follow redirects, or use proxies."""

from __future__ import annotations

import urllib.error
import urllib.request
from collections.abc import Mapping
from typing import Protocol

from seo_exporter.providers import ProviderError


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse redirects so tokens and form bodies are not replayed."""

    def http_error_302(
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
    ) -> None:
        raise urllib.error.HTTPError(req.full_url, code, "redirect", headers, fp)

    http_error_301 = http_error_302
    http_error_303 = http_error_302
    http_error_307 = http_error_302
    http_error_308 = http_error_302


class UrlLibClient:
    """Perform one HTTP request and return the raw body.

    Args:
        timeout: Socket timeout in seconds.
        max_bytes: Maximum response body size.
    """

    def __init__(self, timeout: float, max_bytes: int = 8 * 1024 * 1024) -> None:
        self._timeout = timeout
        self._max_bytes = max_bytes
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            _NoRedirect(),
        )

    def __call__(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float | None = None,
    ) -> bytes:
        """Send a request.

        Args:
            method: HTTP method.
            url: Absolute URL. Must not contain credentials.
            headers: Request headers.
            body: Optional raw body.
            timeout: Override the client timeout.

        Returns:
            Response body bytes.

        Raises:
            ProviderError: Transport failure, non-2xx status, or an oversized body.
        """
        request = urllib.request.Request(
            url, data=body, headers=dict(headers), method=method
        )
        try:
            with self._opener.open(
                request, timeout=timeout or self._timeout
            ) as response:
                status = getattr(response, "status", 200)
                payload = _read_limited(response, self._max_bytes)
        except urllib.error.HTTPError as exc:
            raise ProviderError("http-status", exc.code) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ProviderError("transport") from None
        if status < 200 or status >= 300:
            raise ProviderError("http-status", status)
        return payload


class _Readable(Protocol):
    """Response body with a bounded read."""

    def read(self, size: int = -1) -> bytes:
        """Read up to ``size`` bytes."""
        ...


def _read_limited(response: _Readable, max_bytes: int) -> bytes:
    """Read a response body up to ``max_bytes``.

    Args:
        response: Object with a ``read`` method.
        max_bytes: Inclusive size cap.

    Returns:
        The full body.

    Raises:
        ProviderError: The body exceeds ``max_bytes``.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(65536)
        if not chunk:
            break
        if not isinstance(chunk, bytes):
            raise ProviderError("invalid-body")
        total += len(chunk)
        if total > max_bytes:
            raise ProviderError("response-too-large")
        chunks.append(chunk)
    return b"".join(chunks)
