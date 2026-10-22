"""Localhost-only HTTP server for Prometheus scrapes."""

from __future__ import annotations

import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from seo_exporter.metrics import Registry

logger = logging.getLogger("seo_exporter")
_LOOPBACK = frozenset({"127.0.0.1", "::1"})


class _Handler(BaseHTTPRequestHandler):
    """Serve ``/metrics`` and ``/healthz``."""

    registry: Registry
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        """Handle a GET request."""
        path = urlsplit(self.path).path
        if path == "/metrics":
            body = self.registry.render().encode()
            self._send(200, "text/plain; version=0.0.4; charset=utf-8", body)
            return
        if path == "/healthz":
            self._send(200, "text/plain; charset=utf-8", b"ok\n")
            return
        self._send(404, "text/plain; charset=utf-8", b"not found\n")

    def log_message(self, fmt: str, *args: object) -> None:
        """Log the path and status, never the query string."""
        path = urlsplit(self.path).path
        code = args[1] if len(args) > 1 else "-"
        logger.info("http path=%s code=%s", path, code)

    def _send(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def assert_loopback(host: str) -> None:
    """Reject bind addresses that are not loopback literals.

    Args:
        host: Address string.

    Raises:
        SystemExit: ``host`` is not ``127.0.0.1`` or ``::1``.
    """
    if host not in _LOOPBACK:
        raise SystemExit("metrics bind address must be loopback")


def make_server(host: str, port: int, registry: Registry) -> ThreadingHTTPServer:
    """Bind an HTTP server to a loopback address.

    Args:
        host: Loopback literal.
        port: TCP port. ``0`` selects an ephemeral port.
        registry: Metrics registry served at ``/metrics``.

    Returns:
        A server that has not yet been started.

    Raises:
        SystemExit: The bind address is not loopback.
    """
    assert_loopback(host)
    _Handler.registry = registry
    server = ThreadingHTTPServer((host, port), _Handler)
    server.daemon_threads = True
    return server
