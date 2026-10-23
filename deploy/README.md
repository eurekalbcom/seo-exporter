# Docker deploy (witold216)

Read-only GSC and Bing exporter, packaged as a container, plus a Prometheus agent on the same compose network. The metrics bind allowlist accepts `0.0.0.0` in addition to the loopback literals. The container entrypoint forces `0.0.0.0`.

The target host is **witold216** (develop). The workflow does not hardcode the address. It reads `EUK_VAR_SEO_TARGET_HOST`.

This repository still contains no secret values.

## Rejected: systemd and root install

The systemd unit, `sudoers` installer, root credential store, and `seo-deploy` forced command that runs `sudo` are rejected. Do not restore `deploy/seo-exporter.service`, `deploy/sudoers.example`, or `deploy/install.sh`. The process runs as uid `10001` inside the container. The host deploy account is not root and has no sudo.

After this deploy is merged, revoke `EUK_SSH_SEO_DEPLOY_V8QX`:

1. Remove its line from `~seo-deploy/.ssh/authorized_keys` on the previous target.
2. Delete the `EUK_SSH_SEO_DEPLOY_V8QX` secret from the `seo-readonly` environment.

The replacement secret is `EUK_SSH_SEO_DEPLOY_W216`. This change does not create the key.

## GitHub environment `seo-readonly`

- Deployment branch: `main` only.
- Required reviewer: Jan (`janjaszczak`). Admin bypass stays off.
- The deploy workflow declares `environment: seo-readonly` and does not run on push.
- Dispatch input `sha` must be a full commit that is on `main`. The sha-guard refuses anything else before SSH.
- `SEO_DEPLOY_ENABLED` is a repository variable. The publish job has no `environment:`, so an environment-scoped variable is invisible to it.
- The publish job builds and pushes. Its permissions are `contents: read` and `packages: write`. It has no EUK secrets. Its first step fails closed when `SEO_DEPLOY_ENABLED` is not `true`.
- The deploy job holds the `seo-readonly` secrets. Its permissions are `contents: read` only. Its first step is the fail-closed HOLD guard (`vars.SEO_DEPLOY_ENABLED` must be `true`, and `EUK_OAUTH_TAILSCALE_SEO_DEPLOY` must be present). The guard does not print those values.
- `SEO_REMOTE_WRITE_PORT` is defined only in this environment. Do not set it in the image, the compose file, or a committed env file.
- An image can be pushed before the environment reviewer approves the deploy. That split keeps `packages: write` away from the job that holds the provider secrets.

### Secrets (names only)

| Name | Purpose |
|---|---|
| `EUK_OAUTH_GSC_READONLY` | Google credential JSON `{client_id, client_secret, refresh_token}` |
| `EUK_OAUTH_BING_READONLY` | Bing credential JSON, same shape |
| `EUK_OAUTH_TAILSCALE_SEO_DEPLOY` | Tailscale OAuth client `{client_id, client_secret}` |
| `EUK_SSH_SEO_DEPLOY_W216` | SSH private key for witold216, forced command only |

`EUK_SSH_SEO_DEPLOY_V8QX` is retired by the revoke steps above. Do not wire it into this workflow.

GHCR push uses the publish job's built-in `github.token` (`packages: write`). That token is not an environment secret and is passed to `docker login` on stdin. The deploy job does not receive it.

### Variables (names only)

| Name | Purpose |
|---|---|
| `SEO_DEPLOY_ENABLED` | Repository variable. Anything other than `true` fails publish and deploy. |
| `EUK_VAR_SEO_TARGET_HOST` | witold216 address. Not committed. |
| `EUK_VAR_SEO_TARGET_HOSTKEY` | One OpenSSH `known_hosts` line for that host. A second line, `@cert-authority`, or `@revoked` is refused before SSH. |
| `EUK_VAR_SEO_GSC_SITE` | Search Console property. |
| `EUK_VAR_SEO_BING_SITE` | Bing site URL. |

## Image pin and rollback

Compose sets `image` from `SEO_EXPORTER_IMAGE`. The only accepted value is `ghcr.io/eurekalbcom/seo-exporter@sha256:` plus 64 hex characters. Other registries and tags are refused.

A normal dispatch builds the selected SHA, pushes `ghcr.io/eurekalbcom/seo-exporter:sha-<sha>`, and deploys the registry digest printed as `image digest: sha256:...`. The digest is the push log line `<tag>: digest: sha256:... size: N` checked against `docker image inspect` RepoDigests. Record that line. It is not a secret.

Rollback is a redeploy of a previous digest, not a rebuild and not a systemd rollback. The deploy job checks it before SSH, while HEAD is still `main`:

1. Open **Run workflow** on `main`.
2. Set `sha` to a commit on `main` that contains this compose file. The sha-guard refuses anything that is not an ancestor of `main`.
3. Set `image_digest` to `sha256:...` or `ghcr.io/eurekalbcom/seo-exporter@sha256:...`. It must be the digest of `ghcr.io/eurekalbcom/seo-exporter:sha-<sha>`. `docker buildx imagetools inspect` reads that tag (or `docker manifest inspect --verbose` when buildx is absent). A different digest, or a digest for any other repository, fails closed.
4. The publish job is skipped. The host runs `docker compose pull` and `docker compose up -d` for that digest.

The deploy job has `packages: read` so that inspect can log in with `github.token`. It does not have `packages: write`, and that token is not passed to SSH.

## What the deploy job writes

The runner builds an env file at mode `0600` and passes it on stdin to `docker compose pull`. The body is at most 64 KiB (65536 bytes). Provider JSON and the SSH key are environment variables on the runner, then the file body. They are not command-line arguments and they are not echoed.

The file has exactly these seven keys, each once: `SEO_EXPORTER_IMAGE`, `SEO_EXPORTER_GSC_SITE`, `SEO_EXPORTER_BING_SITE`, `SEO_EXPORTER_GSC_JSON`, `SEO_EXPORTER_BING_JSON`, `SEO_REMOTE_WRITE_PORT`, `SEO_COMPOSE_SHA256`. Comments, blank lines, and any other key are refused. `WRITE_MODE` and `AUTH_TRUST_HOST` are not keys of this file. The two site values and both JSON values are single-quoted and must not contain a single quote. Compose then treats `${...}` inside them as literal text. `SEO_REMOTE_WRITE_PORT` is an unquoted integer from 1 to 65535 with no leading zero and no default. The deploy job reads it from the repository variable `SEO_REMOTE_WRITE_PORT`. Until that variable exists, deploy fails closed.

The forced command writes `/srv/seo-exporter/data/.env` at mode `0600` only after `docker compose pull` succeeds. A failed pull restores the previous file. `docker compose up -d` and `docker compose ps` refuse stdin. The wrapper unsets every exported `COMPOSE_*` variable and always runs `docker compose --env-file /srv/seo-exporter/data/.env -f /srv/seo-exporter/docker-compose.yml -p seo-exporter`. `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`, and `COMPOSE_PROFILES` cannot point the pull at another file.

`SEO_COMPOSE_SHA256` is the SHA-256 of the raw bytes of `/srv/seo-exporter/docker-compose.yml`. Compute the same value from the deployed file:

```bash
sha256sum docker-compose.yml
```

Use the first field, 64 lowercase hex characters, with no `sha256:` prefix. The wrapper runs `sha256sum` on the host file and refuses the deploy when the fields differ.

The container entrypoint copies the JSON into `/run/credentials/seo-exporter/{gsc,bing}.json` (mode `0400`) and removes those variables from the process environment before `python -m seo_exporter`. If `WRITE_MODE` or `AUTH_TRUST_HOST` is set, the process exits before writing credentials. This service has no write API and does not trust `X-Forwarded-Host`. `docker compose config` on a host that has the real env file will print it. Do not capture that output. `bash deploy/compose_config.sh` checks the file with interpolation disabled and refuses a render when `SEO_REMOTE_WRITE_PORT` is unset. The example file does not contain a port.

`SEO_EXPORTER_BIND` is forced to `0.0.0.0` and the state directory is forced to `/var/lib/seo-exporter`. The env file cannot move either one. The process allowlist is `127.0.0.1`, `::1`, and `0.0.0.0`. Any other bind string still exits. The host does not publish port `9108`. The Prometheus agent scrapes `seo-exporter:9108` on `seo-exporter_net` and remote-writes only series whose names match `seo_.*` to `http://100.122.36.23:<SEO_REMOTE_WRITE_PORT>/api/v1/write`. There is no token in the repo. Define `SEO_REMOTE_WRITE_PORT` only in the `seo-readonly` environment. The compose file and the image do not give it a value. The agent config is the `PROMETHEUS_CONFIG` value in `docker-compose.yml`, so `SEO_COMPOSE_SHA256` covers it. The read-only agent writes that value to `/tmp` on tmpfs and then execs `prometheus --agent`. `follow_redirects` is false on the scrape and on remote write. The scrape config sets `sample_limit`.

## Host layout on witold216

One-time admin bootstrap. This is not the rejected root installer: there is no sudoers file and no unit.

- Account `seo-deploy` exists, is not uid 0, has a locked password, and is not in the sudo group. Its group is `seo-deploy`.
- Rootless Docker for that account. The socket is `/run/user/<uid>/docker.sock`. The forced command refuses `/var/run/docker.sock` and `/run/docker.sock`.
- Directory `/srv/seo-exporter` is owned by root, group `seo-deploy`, mode `0750`. The deploy user can enter it and cannot replace files there.
- Directory `/srv/seo-exporter/deploy` is not mounted and is not required. If it exists, it is owned by root, group `seo-deploy`, mode `0750`. The deploy user cannot write it.
- `docker-compose.yml` in `/srv/seo-exporter` is owned by root, group `seo-deploy`, mode `0640`. It is a byte copy of the file in the deployed SHA. That file holds the agent config.
- Directory `/srv/seo-exporter/data` is owned by `seo-deploy`, mode `0750`. The wrapper writes `.env` there.
- `/usr/local/sbin/seo-exporter-compose` is a root-owned copy of `deploy/seo-exporter-compose`, mode `0755`. The deploy user cannot rewrite it. The command parses the compose file with `python3` and PyYAML, and refuses the file when either is missing.
- One-time `docker login ghcr.io --password-stdin` as `seo-deploy`, so `docker compose pull` can read the private package. This PR does not create that credential. The agent image is the public `prom/prometheus` pin in the compose file.

The image workdir `/srv/seo-exporter` is the Python tree inside the container. It is not a mount of the host directory.

The compose project name is `seo-exporter`. Its only network is `seo-exporter_net`, and only the exporter and the agent attach to it. It does not join another project's networks or volumes, does not mount the Docker socket, and does not publish a host port. The exporter drops all capabilities, sets `no-new-privileges`, sets `mem_limit: 256m` and `pids_limit: 128`, and uses a read-only root filesystem with tmpfs for `/run/credentials`, `/var/lib/seo-exporter`, and `/tmp`. The agent uses the same capability drop and read-only root, with `mem_limit: 128m` and `pids_limit: 64`, and tmpfs for its WAL. The network is not internal, because the exporter calls Google and Bing and the agent remote-writes to `100.122.36.23`.

## authorized_keys

Install this single line as `~seo-deploy/.ssh/authorized_keys` (mode `0600`). Replace the key placeholder with the public key for `EUK_SSH_SEO_DEPLOY_W216`. The CI node is ephemeral, so `from=` uses the tailnet CGNAT range `100.64.0.0/10` instead of one address.

```
from="100.64.0.0/10",restrict,command="/usr/local/sbin/seo-exporter-compose",no-pty,no-port-forwarding,no-agent-forwarding ssh-ed25519 REPLACE_WITH_W216_DEPLOY_PUBLIC_KEY seo-deploy-w216
```

`restrict` disables TTY, port forwarding, agent forwarding, and X11. The explicit `no-pty`, `no-port-forwarding`, and `no-agent-forwarding` flags state the same limits on the line. `from=` allows the tailnet CGNAT range because the CI node address changes. The command wrapper accepts only these `SSH_ORIGINAL_COMMAND` values. It runs them in `/srv/seo-exporter` and adds `--env-file /srv/seo-exporter/data/.env -f /srv/seo-exporter/docker-compose.yml -p seo-exporter` itself:

- `docker compose pull`
- `docker compose up -d`
- `docker compose ps`

Any other command, including a shell, is refused. The account has no sudo.

## Local verification

```bash
python3 -m pip install -r requirements-dev.txt
python3 -m pytest
shellcheck deploy/sha_guard.sh deploy/ssh_deploy.sh deploy/build_push.sh deploy/seo-exporter-compose deploy/check_workflows.sh deploy/compose_config.sh deploy/verify_rollback.sh deploy/compose_up_smoke.sh
bash deploy/check_workflows.sh
hadolint Dockerfile
actionlint
bash deploy/compose_config.sh
```
