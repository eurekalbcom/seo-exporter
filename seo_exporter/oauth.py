"""Refresh OAuth access tokens without retaining raw token responses."""

from __future__ import annotations

import json
import time
import urllib.parse
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from seo_exporter.credentials import OAuthClient
from seo_exporter.logging_redact import Redactor
from seo_exporter.providers import ProviderError

HttpCaller = Callable[[str, str, Mapping[str, str], bytes | None, float | None], bytes]

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
BING_TOKEN_URL = "https://www.bing.com/webmasters/oauth/token"
_SKEW_SECONDS = 60.0


@dataclass
class AccessSession:
    """In-memory token state for one provider.

    Attributes:
        refresh_token: Current refresh token, possibly rotated by the provider.
        access_token: Cached access token, when one is still valid.
        deadline: Monotonic time when the access token should be refreshed.
    """

    refresh_token: str
    access_token: str | None = None
    deadline: float = 0.0


def refresh_access_token(
    client: OAuthClient,
    session: AccessSession,
    token_url: str,
    http: HttpCaller,
    redactor: Redactor,
    *,
    now: Callable[[], float] | None = None,
) -> str:
    """Return a usable access token, refreshing it when needed.

    Args:
        client: Client id and secret.
        session: Mutable cache. A rotated refresh token is written back here.
        token_url: Provider token endpoint.
        http: HTTP caller.
        redactor: Receives new token material.
        now: Clock returning monotonic seconds.

    Returns:
        Bearer access token.

    Raises:
        ProviderError: The token endpoint did not return an access token.
    """
    clock = time.monotonic if now is None else now
    current = session.access_token
    if current and clock() < session.deadline:
        return current
    form = urllib.parse.urlencode(
        {
            "grant_type": "refresh_token",
            "client_id": client.client_id,
            "client_secret": client.client_secret,
            "refresh_token": session.refresh_token,
        }
    ).encode()
    raw = http(
        "POST",
        token_url,
        {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        form,
        None,
    )
    payload = _object(raw)
    access_token = payload.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise ProviderError("missing-access-token")
    expires_in = payload.get("expires_in", 3600)
    if (
        isinstance(expires_in, bool)
        or not isinstance(expires_in, (int, float))
        or expires_in <= 0
    ):
        expires_in = 3600
    rotated = payload.get("refresh_token")
    redactor.add(access_token)
    session.access_token = access_token
    session.deadline = clock() + float(expires_in) - _SKEW_SECONDS
    if isinstance(rotated, str) and rotated and rotated != session.refresh_token:
        redactor.add(rotated)
        session.refresh_token = rotated
    return access_token


def _object(raw: bytes) -> dict[str, object]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        raise ProviderError("invalid-json") from None
    if not isinstance(value, dict):
        raise ProviderError("invalid-json")
    return value
