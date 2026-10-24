"""OAuth refresh and the HTTP client."""

from __future__ import annotations

import email.message
import io
import json
import urllib.error
import urllib.request

import pytest

from seo_exporter.credentials import OAuthClient
from seo_exporter.http_client import UrlLibClient, _NoRedirect
from seo_exporter.logging_redact import Redactor
from seo_exporter.oauth import AccessSession, refresh_access_token
from seo_exporter.providers import ProviderError

SECRET = "client-secret-test"


class FakeHttp:
    """Queue of canned responses."""

    def __init__(self, responses: list[bytes]) -> None:
        self._responses = list(responses)
        self.calls: list[tuple[str, str, dict[str, str], bytes | None]] = []

    def __call__(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout: float | None,
    ) -> bytes:
        self.calls.append((method, url, dict(headers), body))
        if not self._responses:
            raise ProviderError("transport")
        return self._responses.pop(0)


def test_refresh_parses_token_and_rotates_refresh() -> None:
    http = FakeHttp(
        [
            json.dumps(
                {
                    "access_token": "access-token-test",
                    "expires_in": 3600,
                    "refresh_token": "rotated-refresh-test",
                    "extra": "ignore-me",
                }
            ).encode()
        ]
    )
    client = OAuthClient("client-id-test", SECRET, "refresh-token-test")
    session = AccessSession(refresh_token=client.refresh_token)
    redactor = Redactor()
    clock = {"now": 100.0}

    token = refresh_access_token(
        client,
        session,
        "https://oauth2.googleapis.com/token",
        http,
        redactor,
        now=lambda: clock["now"],
    )
    assert token == "access-token-test"
    assert session.refresh_token == "rotated-refresh-test"
    again = refresh_access_token(
        client,
        session,
        "https://oauth2.googleapis.com/token",
        http,
        redactor,
        now=lambda: clock["now"],
    )
    assert again == token
    assert len(http.calls) == 1
    body = http.calls[0][3] or b""
    assert b"grant_type=refresh_token" in body
    assert SECRET.encode() in body


def test_token_error_hides_body() -> None:
    http = FakeHttp([b'{"error":"client-secret-test"}'])
    client = OAuthClient("client-id-test", SECRET, "refresh-token-test")
    with pytest.raises(ProviderError) as caught:
        refresh_access_token(
            client,
            AccessSession(refresh_token=client.refresh_token),
            "https://www.bing.com/webmasters/oauth/token",
            http,
            Redactor(),
        )
    assert str(caught.value) == "missing-access-token"
    assert SECRET not in str(caught.value)


def test_http_error_does_not_expose_body(monkeypatch: pytest.MonkeyPatch) -> None:
    secret_body = b'{"error_description":"client-secret-test"}'

    class Opener:
        def open(self, request: urllib.request.Request, timeout: float) -> object:
            raise urllib.error.HTTPError(
                request.full_url,
                400,
                "Bad Request",
                email.message.Message(),
                io.BytesIO(secret_body),
            )

    monkeypatch.setattr(
        "seo_exporter.http_client.urllib.request.build_opener",
        lambda *_args, **_kwargs: Opener(),
    )
    client = UrlLibClient(timeout=1, max_bytes=64)
    with pytest.raises(ProviderError) as caught:
        client("POST", "https://oauth2.googleapis.com/token", {}, b"payload", None)
    assert "client-secret-test" not in str(caught.value)
    assert "http_status=400" in str(caught.value)


def test_http_limits_body(monkeypatch: pytest.MonkeyPatch) -> None:
    class Response:
        status = 200

        def read(self, _size: int = -1) -> bytes:
            return b"0123456789"

        def __enter__(self) -> Response:
            return self

        def __exit__(self, *_args: object) -> bool:
            return False

    class Opener:
        def open(self, _request: object, timeout: float) -> Response:
            return Response()

    monkeypatch.setattr(
        "seo_exporter.http_client.urllib.request.build_opener",
        lambda *_args, **_kwargs: Opener(),
    )
    client = UrlLibClient(timeout=1, max_bytes=8)
    with pytest.raises(ProviderError) as caught:
        client(
            "GET",
            "https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats",
            {},
            None,
            None,
        )
    assert str(caught.value) == "response-too-large"


def test_redirect_is_not_followed_and_body_not_read() -> None:
    body = io.BytesIO(b"client-secret-test")
    request = urllib.request.Request(
        "https://oauth2.googleapis.com/token", method="POST"
    )
    with pytest.raises(urllib.error.HTTPError) as caught:
        _NoRedirect().http_error_302(request, body, 302, "Found", {})
    assert body.tell() == 0
    assert caught.value.code == 302
    assert SECRET not in str(caught.value)
