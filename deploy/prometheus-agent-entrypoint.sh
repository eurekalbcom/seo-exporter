#!/bin/sh
# Render the remote_write port into the read-only template, then exec the agent.
set -eu

port=${SEO_REMOTE_WRITE_PORT-}
case "$port" in
  ""|*[!0-9]*|0*)
    printf '%s\n' "SEO_REMOTE_WRITE_PORT rejected" >&2
    exit 1
    ;;
esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  printf '%s\n' "SEO_REMOTE_WRITE_PORT rejected" >&2
  exit 1
fi

template=${PROM_TEMPLATE:-/etc/prometheus/prometheus.yml.template}
rendered=${PROM_RENDERED:-/tmp/prometheus.yml}
prometheus=${PROMETHEUS_BIN:-/bin/prometheus}
storage=${PROM_STORAGE:-/prometheus}

awk -v port="$port" '{gsub(/\$\{SEO_REMOTE_WRITE_PORT\}/, port); print}' "$template" >"$rendered"
if grep -q 'SEO_REMOTE_WRITE_PORT' "$rendered"; then
  printf '%s\n' "SEO_REMOTE_WRITE_PORT rejected" >&2
  exit 1
fi

exec "$prometheus" \
  --enable-feature=agent \
  --config.file="$rendered" \
  --storage.agent.path="$storage" \
  --web.listen-address=127.0.0.1:9090
