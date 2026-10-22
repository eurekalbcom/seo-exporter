# python:3.12.15-alpine linux/amd64
# registry digest of library/python manifest 3.12-alpine (amd64)
FROM python:3.12-alpine@sha256:9b98a8d37794ca093ba8d5afe1ffac52f5a15168b9b4e67594d86c20e14fa681

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    CREDENTIALS_DIRECTORY=/run/credentials/seo-exporter \
    SEO_EXPORTER_STATE_DIR=/var/lib/seo-exporter \
    SEO_EXPORTER_BIND=127.0.0.1 \
    SEO_EXPORTER_PORT=9108 \
    HOME=/tmp \
    PYTHONPATH=/opt/seo-exporter

RUN addgroup -g 10001 -S seo \
    && adduser -u 10001 -S -G seo -H -h /tmp -D seo \
    && mkdir -p /run/credentials /var/lib/seo-exporter /tmp /opt/seo-exporter/deploy \
    && chown 10001:10001 /run/credentials /var/lib/seo-exporter /tmp

WORKDIR /opt/seo-exporter

COPY pyproject.toml README.md ./
COPY seo_exporter ./seo_exporter
COPY deploy/__init__.py deploy/credentials_json.py deploy/docker_entrypoint.py ./deploy/

RUN pip install --no-cache-dir --root-user-action=ignore "tzdata==2026.5" \
    && pip install --no-cache-dir --root-user-action=ignore --no-deps . \
    && chmod 0555 /opt/seo-exporter/deploy/docker_entrypoint.py \
    && chmod 0444 /opt/seo-exporter/deploy/__init__.py /opt/seo-exporter/deploy/credentials_json.py

USER 10001:10001

# No published port. The server binds 127.0.0.1. Scraping from outside the
# container is a separate GO.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9108/healthz', timeout=3).read()"]

ENTRYPOINT ["python", "-m", "deploy.docker_entrypoint"]
