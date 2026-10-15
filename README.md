# seo-exporter

Read-only exporter of Google Search Console and Bing Webmaster data for Eureka Labs (EUR-243).
Runs as a service on the target host. GitHub Actions deploys it through the protected `seo-readonly` environment.

> **This repository never contains secret values.** Credentials live only in the GitHub Environment `seo-readonly`. Push protection and secret scanning are on. Do not commit hostnames, addresses, tokens, or API payloads.

The process binds its Prometheus endpoint to `127.0.0.1` only. A local Grafana agent on the same host scrapes it. Search queries are not kept: Search Console is requested as a property total, and Bing query rows are reduced to numeric totals before they are discarded.

## GitHub Environment `seo-readonly`

- Deployments are allowed only from the `main` branch.
- Required reviewer: @janjaszczak. Admin bypass is off.
- There are no repository-level secrets. Workflows from forks get no secrets.
- The pull-request workflow does not declare `environment` and does not reference secrets.

### Environment secrets (names only)

| Name | Format | Purpose |
|---|---|---|
| `EUK_OAUTH_GSC_READONLY` | JSON object `{client_id, client_secret, refresh_token}` | Google Search Console, scope `https://www.googleapis.com/auth/webmasters.readonly` |
| `EUK_OAUTH_BING_READONLY` | JSON object `{client_id, client_secret, refresh_token}` | Bing Webmaster API, scope `webmaster.read` |
| `EUK_OAUTH_TAILSCALE_SEO_DEPLOY` | JSON object `{client_id, client_secret}` | Tailscale OAuth client (`auth_keys`, `tag:gh-seo-deploy` only) |
| `EUK_SSH_SEO_DEPLOY_V8QX` | SSH private key (forced command on target) | Deploy as `seo-deploy` |

There are no separate `*_CLIENT_ID` variables. Client ids live inside the JSON secrets.

### Environment variables

| Name | Purpose |
|---|---|
| `EUK_VAR_SEO_TARGET_HOST` | Target host for the deploy. Value is not committed. |
| `EUK_VAR_SEO_TARGET_HOSTKEY` | One OpenSSH `known_hosts` line for that host. |

> **Pending CISO name approval:** `EUK_VAR_SEO_TARGET_HOSTKEY` is the known_hosts variable. Do not rename it until the CISO approves the name. The deploy workflow reads that exact name.

## Tailscale action

Checked against `tailscale/github-action` tag `v4.2.0` (`d1b6cd204f8dceda5b3eaad7f1f767be390056cd`):

| Action input | Value |
|---|---|
| `oauth-client-id` | `client_id` from `EUK_OAUTH_TAILSCALE_SEO_DEPLOY` |
| `oauth-secret` | `client_secret` from the same JSON |
| `tags` | `tag:gh-seo-deploy` |

That release has no `ephemeral` input. For an OAuth client, `src/main.ts` builds the auth key with `ephemeral=true` and `preauthorized=true`, and passes `--advertise-tags` from `tags`. The node is removed when the job ends.

## Repository security settings

- Actions: only allowlisted actions (GitHub-created `actions/*` and `tailscale/github-action`), and every action must be pinned to a full-length commit SHA.
- Default `GITHUB_TOKEN` permissions are read-only. Actions cannot create or approve PRs.
- Workflows on fork PRs need approval for **all** external contributors.
- Secret scanning and push protection are on.
- No workflow may use `pull_request_target`. CI checks this on every pull request.

## Runtime layout

On the host the service reads:

| Path | Content |
|---|---|
| `$CREDENTIALS_DIRECTORY/gsc.json` | `{client_id, client_secret, refresh_token}` from `LoadCredentialEncrypted` |
| `$CREDENTIALS_DIRECTORY/bing.json` | Same shape for Bing |
| `/etc/seo-exporter/environment` | Non-secret site settings only |

`/etc/seo-exporter/environment` must define `SEO_EXPORTER_GSC_SITE` (Search Console property) and `SEO_EXPORTER_BING_SITE` (Bing site). Do not put secrets in that file. The unit forces the metrics bind back to `127.0.0.1` and the state directory back to `/var/lib/seo-exporter` after the file is read, so the file cannot move either of those.

Optional settings in that file: `SEO_EXPORTER_PORT` (default `9108`), `SEO_EXPORTER_INTERVAL_SECONDS` (default `3600`, minimum `60`), `SEO_EXPORTER_LOOKBACK_DAYS` (default `28`), `SEO_EXPORTER_LAG_DAYS` (default `3`).

Bing may rotate refresh tokens. The service stores a replacement under the state directory, mode `0600`. Wiping that directory requires a new deploy of the credential.

Metrics, labeled only by `provider` (`gsc` or `bing`):

- `seo_exporter_up`
- `seo_exporter_clicks`
- `seo_exporter_impressions`
- `seo_exporter_ctr`
- `seo_exporter_position`
- `seo_exporter_rows`
- `seo_exporter_last_success_unixtime`
- `seo_exporter_scrape_duration_seconds`
- `seo_exporter_errors_total`

`GET /healthz` is process liveness. `GET /metrics` is the scrape. Query strings on those requests are not logged.

Logs record provider, row count, duration, and a stable error reason. They do not record credential fields, access tokens, or response bodies.

## Host setup

1. Create a system user `seo-deploy` with a locked password and no interactive shell.
2. Install `deploy/sudoers.example` as `/etc/sudoers.d/seo-exporter-deploy` (`visudo -cf` first). `log_input` and `log_output` are disabled for the installer so the payload on stdin is not recorded.
3. Bootstrap the forced command once, as root, by copying `deploy/install.sh`, `deploy/install.py`, and `deploy/seo_payload.py` to `/usr/local/lib/seo-exporter-install/` (modes `0755`, `0644`, `0644`, root-owned) and linking `/usr/local/sbin/seo-exporter-install` to `install.sh`.
4. Install `deploy/authorized_keys.example` as `~seo-deploy/.ssh/authorized_keys` after replacing `REPLACE_WITH_DEPLOY_PUBLIC_KEY` with the public key for `EUK_SSH_SEO_DEPLOY_V8QX`. The line is `restrict` plus a forced command. The account cannot allocate a TTY, forward ports, or run another command.
5. Put one `known_hosts` line in `EUK_VAR_SEO_TARGET_HOSTKEY`. Deploy uses `StrictHostKeyChecking=yes` and that file. Do not use trust-on-first-use.
6. Create `/etc/seo-exporter/environment` with the two site variables. The disk that holds `/var/lib/systemd/credential.secret` should be encrypted; `systemd-creds` warns when it is not.
7. Push to `main`. The deploy job joins the tailnet, then sends the code archive and the two provider secrets on SSH stdin. They are not process arguments, environment variables, or log lines. `deploy/install.sh` encrypts each credential with `systemd-creds encrypt --name=... --with-key=auto` into `/etc/credstore.encrypted/`, mode `0400`, root-owned, and installs `deploy/seo-exporter.service` (`LoadCredentialEncrypted`, `DynamicUser`, `NoNewPrivileges`, `ProtectSystem=strict`, and the rest of the unit). `MemoryDenyWriteExecute` is omitted because CPython needs to map executable pages.

The first deploy does not start the service until `/etc/seo-exporter/environment` contains both site variables. Later deploys restart it.

Grafana, on the same host, scrapes `http://127.0.0.1:9108/metrics`.

## Local verification

```bash
python3 -m pip install -r requirements-dev.txt
python3 -m pytest
shellcheck deploy/install.sh deploy/make_archive.sh scripts/check_workflows.sh
```

CI also runs actionlint and a sha256-checked gitleaks binary, and fails if any workflow uses `pull_request_target`.

## Revoke procedure (target: ≤ 10 minutes)

Use this when a credential leaks or is suspected to have leaked. Do these in parallel where you can; the whole list should be finished within 10 minutes.

1. **GSC**: revoke the OAuth grant or refresh token in Google Cloud / Google Account for the exporter client, then delete `EUK_OAUTH_GSC_READONLY` from the environment.
2. **Bing**: revoke or regenerate the OAuth client in Bing Webmaster Tools, then delete `EUK_OAUTH_BING_READONLY`.
3. **Tailscale**: delete the OAuth client in the Tailscale admin console, remove any `tag:gh-seo-deploy` devices, then delete `EUK_OAUTH_TAILSCALE_SEO_DEPLOY`.
4. **SSH**: remove the deploy key from `~seo-deploy/.ssh/authorized_keys` on the target host, then delete `EUK_SSH_SEO_DEPLOY_V8QX`.
5. On the host, as root, stop `seo-exporter.service`, remove `/var/lib/seo-exporter` (rotated refresh tokens), and remove `/etc/credstore.encrypted/seo-exporter-gsc.json` and `/etc/credstore.encrypted/seo-exporter-bing.json`.
6. Cancel any running workflows. If needed, disable Actions for the repository.
7. Record the incident in the security log and the expire/rotate catalog, then rotate following the canonical procedure.
