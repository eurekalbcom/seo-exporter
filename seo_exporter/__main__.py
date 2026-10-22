"""CLI entrypoint for the read-only SEO exporter."""

from __future__ import annotations

from seo_exporter.service import main

if __name__ == "__main__":
    raise SystemExit(main())
