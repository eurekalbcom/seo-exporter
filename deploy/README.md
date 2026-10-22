# Docker deploy (witold216)

Read-only GSC and Bing exporter, packaged as a container. The Python package is the tree from `efe4041d220559ae64487d7c42b4493275d65264` on `cursor/seo-readonly-exporter-8756`. That branch is not modified by this deploy.

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

Rollback is a redeploy of the previous digest, not a rebuild and not a systemd rollback:

1. Open **Run workflow** on `main`.
2. Set `sha` to a commit on `main` that contains this compose file (the sha-guard still applies).
3. Set `image_digest` to the previous `sha256:...` or the full `ghcr.io/...@sha256:...` reference.
4. The build step is skipped. The host runs `docker compose pull` and `docker compose up -d` for that digest.

## What the deploy job writes

The runner builds an env file at mode `0600` and passes it on stdin to `docker compose pull`. The body is at most 64 KiB (65536 bytes). Provider JSON and the SSH key are environment variables on the runner, then the file body. They are not command-line arguments and they are not echoed.

The file has exactly these six keys, each once: `SEO_EXPORTER_IMAGE`, `SEO_EXPORTER_GSC_SITE`, `SEO_EXPORTER_BING_SITE`, `SEO_EXPORTER_GSC_JSON`, `SEO_EXPORTER_BING_JSON`, `SEO_COMPOSE_SHA256`. Comments, blank lines, and any other key are refused. `WRITE_MODE` and `AUTH_TRUST_HOST` are not keys of this file.

The forced command writes `/srv/seo-exporter/.env` at mode `0600` only after `docker compose pull` succeeds. A failed pull restores the previous file. `docker compose up -d` and `docker compose ps` refuse stdin. The wrapper unsets every exported `COMPOSE_*` variable and always runs `docker compose -f /srv/seo-exporter/docker-compose.yml -p seo-exporter`. `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`, and `COMPOSE_PROFILES` cannot point the pull at another file.

The container entrypoint copies the JSON into `/run/credentials/seo-exporter/{gsc,bing}.json` (mode `0400`) and removes those variables from the process environment before `python -m seo_exporter`. If `WRITE_MODE` or `AUTH_TRUST_HOST` is set, the process exits before writing credentials. This service has no write API and does not trust `X-Forwarded-Host`. `docker compose config` on a host that has the real env file will print it. Do not capture that output. Use `deploy/env.example` for local renders.

`SEO_EXPORTER_BIND` is forced to `127.0.0.1` and the state directory is forced to `/var/lib/seo-exporter`. The env file cannot move either one. The process still refuses a non-loopback bind. The port is not exposed on the compose network. Scraping from outside the container is a separate GO.

## Host layout on witold216

One-time admin bootstrap. This is not the rejected root installer: there is no sudoers file and no unit.

- Account `seo-deploy` exists, is not uid 0, has a locked password, and is not in the sudo group.
- Rootless Docker for that account. The socket is `/run/user/<uid>/docker.sock`. The forced command refuses `/var/run/docker.sock` and `/run/docker.sock`.
- Directory `/srv/seo-exporter` is owned by `seo-deploy`, mode `0750`.
- `docker-compose.yml` in that directory is a byte copy of the file in the deployed SHA. The env file carries its SHA-256. A mismatch refuses the deploy.
- `/usr/local/sbin/seo-exporter-compose` is a root-owned copy of `deploy/seo-exporter-compose`, mode `0755`. The deploy user cannot rewrite it.
- One-time `docker login ghcr.io --password-stdin` as `seo-deploy`, so `docker compose pull` can read the private package. This PR does not create that credential.

The compose project name is `seo-exporter`. Its only network is `seo-exporter_net`. It does not join another project's networks or volumes, does not mount the Docker socket, does not publish or expose a port, drops all capabilities, sets `no-new-privileges`, and uses a read-only root filesystem with tmpfs for `/run/credentials`, `/var/lib/seo-exporter`, and `/tmp`.

## authorized_keys

Install this single line as `~seo-deploy/.ssh/authorized_keys` (mode `0600`). Replace the key placeholder with the public key for `EUK_SSH_SEO_DEPLOY_W216`.

```
restrict,command="/usr/local/sbin/seo-exporter-compose" ssh-ed25519 REPLACE_WITH_W216_DEPLOY_PUBLIC_KEY seo-deploy-w216
```

`restrict` disables TTY, port forwarding, agent forwarding, and X11. The command wrapper accepts only these `SSH_ORIGINAL_COMMAND` values. It runs them in `/srv/seo-exporter` and adds `-f /srv/seo-exporter/docker-compose.yml -p seo-exporter` itself:

- `docker compose pull`
- `docker compose up -d`
- `docker compose ps`

Any other command, including a shell, is refused. The account has no sudo.

## Local verification

```bash
python3 -m pip install -r requirements-dev.txt
python3 -m pytest
shellcheck deploy/sha_guard.sh deploy/ssh_deploy.sh deploy/build_push.sh deploy/seo-exporter-compose deploy/check_workflows.sh deploy/compose_config.sh
bash deploy/check_workflows.sh
hadolint Dockerfile
actionlint
bash deploy/compose_config.sh
```
