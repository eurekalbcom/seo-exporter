#!/bin/bash
# Start the real compose file and require the agent to stay up.
set -euo pipefail
unset CDPATH

root=$(cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
work=$(mktemp -d)
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
password=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
export SEO_EXPORTER_IMAGE=seo-exporter-smoke:ci
export SEO_REMOTE_WRITE_PORT="$port"
export SEO_REMOTE_WRITE_PASSWORD="$password"

refuse_secret() {
  local body=$1
  case "$body" in
    *"$password"*)
      printf '%s\n' "password leaked" >&2
      exit 1
      ;;
  esac
}

cleanup() {
  if [[ -f "${work}/docker-compose.yml" ]]; then
    docker compose --project-directory "$work" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT

cp -- "${root}/docker-compose.yml" "${work}/docker-compose.yml"
mkdir -p -- "${work}/data"
cp -- "${root}/deploy/env.example" "${work}/data/.env"
printf '%s\n' "SEO_REMOTE_WRITE_PASSWORD=${password}" >>"${work}/data/.env"
chmod 600 "${work}/data/.env"

cat >"${work}/Dockerfile.stub" <<'EOF'
FROM prom/prometheus:v3.15.1@sha256:d445d1806b38f85b5c394a1b87f94113fde0473b45245922c2e8b1bd41fa68ae
USER 10001:10001
ENTRYPOINT ["sleep", "1d"]
HEALTHCHECK NONE
EOF

docker build -t seo-exporter-smoke:ci -f "${work}/Dockerfile.stub" "$work"
docker compose --project-directory "$work" up -d

cid=$(docker compose --project-directory "$work" ps -q prometheus-agent)
if [[ -z "$cid" ]]; then
  printf '%s\n' "prometheus-agent missing" >&2
  exit 1
fi

ready=""
status="missing"
restarts=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  status=$(docker inspect -f '{{.State.Status}}' "$cid")
  restarts=$(docker inspect -f '{{.RestartCount}}' "$cid")
  if [[ "$restarts" != "0" ]]; then
    printf '%s\n' "prometheus-agent restart loop" >&2
    logs=$(docker logs "$cid" 2>&1 || true)
    refuse_secret "$logs"
    printf '%s\n' "$logs" >&2
    exit 1
  fi
  if [[ "$status" == "running" ]]; then
    probe=$(docker exec "$cid" wget -qO- http://127.0.0.1:9090/-/ready || true)
    case "$probe" in
      *Ready*)
        ready=$probe
        break
        ;;
    esac
  elif [[ "$status" == "restarting" || "$status" == "exited" || "$status" == "dead" ]]; then
    printf '%s\n' "prometheus-agent status ${status}" >&2
    logs=$(docker logs "$cid" 2>&1 || true)
    refuse_secret "$logs"
    printf '%s\n' "$logs" >&2
    exit 1
  fi
  sleep 0.5
done

case "$ready" in
  *Ready*) ;;
  *)
    printf '%s\n' "prometheus-agent ready missing" >&2
    logs=$(docker logs "$cid" 2>&1 || true)
    refuse_secret "$logs"
    printf '%s\n' "$logs" >&2
    exit 1
    ;;
esac

sleep 2
status=$(docker inspect -f '{{.State.Status}}' "$cid")
restarts=$(docker inspect -f '{{.RestartCount}}' "$cid")
if [[ "$status" != "running" || "$restarts" != "0" ]]; then
  printf '%s\n' "prometheus-agent did not stay up" >&2
  logs=$(docker logs "$cid" 2>&1 || true)
  refuse_secret "$logs"
  printf '%s\n' "$logs" >&2
  exit 1
fi
ready=$(docker exec "$cid" wget -qO- http://127.0.0.1:9090/-/ready)

exporter=$(docker compose --project-directory "$work" ps -q seo-exporter)
exporter_status=$(docker inspect -f '{{.State.Status}}' "$exporter")
exporter_restarts=$(docker inspect -f '{{.RestartCount}}' "$exporter")
if [[ "$exporter_status" != "running" || "$exporter_restarts" != "0" ]]; then
  printf '%s\n' "seo-exporter did not stay up" >&2
  exit 1
fi

published=$(docker port "$cid")
if [[ -n "$published" ]]; then
  printf '%s\n' "prometheus-agent published a port" >&2
  exit 1
fi

mode=$(docker exec "$cid" stat -c %a /tmp/remote_write_password)
if [[ "$mode" != "400" ]]; then
  printf '%s\n' "password file mode refused" >&2
  exit 1
fi
proc_env=$(docker exec "$cid" cat /proc/1/environ | tr '\0' '\n')
refuse_secret "$proc_env"
case "$proc_env" in
  *"SEO_REMOTE_WRITE_PASSWORD="*)
    printf '%s\n' "password leaked" >&2
    exit 1
    ;;
esac
cmd=$(docker inspect -f '{{json .Config.Cmd}}{{json .Config.Entrypoint}}' "$cid")
refuse_secret "$cmd"
logs=$(docker logs "$cid" 2>&1 || true)
refuse_secret "$logs"
exporter_env=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$exporter")
refuse_secret "$exporter_env"
ps_text=$(docker compose --project-directory "$work" ps)
refuse_secret "$ps_text"
printf '%s\n' "$ps_text"
printf '%s\n' "prometheus-agent Up restarts=${restarts} ready=${ready}"
