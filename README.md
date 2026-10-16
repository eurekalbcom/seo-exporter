# seo-exporter

Read-only exporter of Google Search Console and Bing Webmaster data for Eureka Labs (EUR-243).
Runs as a service on the target host. GitHub Actions deploys it through the protected `seo-readonly` environment.

> **This repository never contains secret values.** Credentials live only in the GitHub Environment `seo-readonly`. Push protection and secret scanning are on.

## GitHub Environment `seo-readonly`

- Deployments are allowed only from the `main` branch.
- Required reviewer: @janjaszczak. Admin bypass is off.
- There are no repository-level secrets. Workflows from forks get no secrets.

### Environment secrets (names only)

| Name | Format | Purpose |
|---|---|---|
| `EUK_OAUTH_GSC_READONLY` | JSON (one object per provider: client + refresh credentials) | Google Search Console, read-only scope |
| `EUK_OAUTH_BING_READONLY` | JSON (one object per provider) | Bing Webmaster API, read-only |
| `EUK_OAUTH_TAILSCALE_SEO_DEPLOY` | Tailscale OAuth client (auth_keys, `tag:gh-seo-deploy` only) | Ephemeral tailnet join for deploy |
| `EUK_SSH_SEO_DEPLOY_V8QX` | SSH private key (forced command on target) | Deploy to target host as `seo-deploy` |

### Environment variables

| Name | Purpose |
|---|---|
| `EUK_VAR_SEO_TARGET_HOST` | Target host for the deploy |

There are no separate `*_CLIENT_ID` variables. The client IDs are inside the provider JSON secrets.

## Repository security settings

- Actions: only allowlisted actions (GitHub-created `actions/*` and `tailscale/github-action`), and every action must be pinned to a full-length commit SHA.
- Default `GITHUB_TOKEN` permissions are read-only. Actions cannot create or approve PRs.
- Workflows on fork PRs need approval for **all** external contributors.
- Secret scanning and push protection are on.

## Revoke procedure (target: ≤ 10 minutes)

Use this when a credential leaks or is suspected to have leaked:

1. **GSC**: revoke the OAuth grant or refresh token in Google Cloud / Google Account for the exporter client, then delete `EUK_OAUTH_GSC_READONLY` from the environment.
2. **Bing**: revoke or regenerate the API credential in Bing Webmaster Tools, then delete `EUK_OAUTH_BING_READONLY`.
3. **Tailscale**: delete the OAuth client in the Tailscale admin console, remove any `tag:gh-seo-deploy` devices, then delete `EUK_OAUTH_TAILSCALE_SEO_DEPLOY`.
4. **SSH**: remove the deploy key from `~seo-deploy/.ssh/authorized_keys` on the target host, then delete `EUK_SSH_SEO_DEPLOY_V8QX`.
5. Cancel any running workflows. If needed, disable Actions for the repository.
6. Record the incident in the security log and the expire/rotate catalog, then rotate following the canonical procedure.

## SEO Autopilot (EUR-407)

This repository is the home for the read-only SEO Autopilot MVP. CrawlSEO is vendored in `crawlseo/` at upstream `49fd73d87a3cd86b59df8bbc41f78d10c9644596` (MIT, see `crawlseo/LICENSE` and `crawlseo/NOTICE`). The scheduler and recommendation store live in `orchestrator/`. External writes stay off until CISO GO on [EUR-406](https://linear.app/eureka-labs/issue/EUR-406/security-gate-ciso-review-trybu-zapisu-seo-autopilot-scope-bing-write).

### Flags (default)

| Name | Default | Effect |
|---|---|---|
| `WRITE_MODE` | `off` | Refuses PUT/PATCH/DELETE to non-local hosts |
| `BING_ENABLED` | off | Bing routes return 404 and the Bing worker does not run |
| `AUTOCOMPLETE_ENABLED` | off | Keyword research returns 404 and no suggestion fetch runs |
| `DISABLE_REGISTRATION` | closed | Set to `false` only to create the first account |
| `ALLOWED_EMAILS` | empty (deny) | Comma-separated sign-in allowlist |
| `CRAWL_ALLOWED_DOMAINS` | unset (deny all) | Crawl API, MCP `run_crawl`, site create/update, and the orchestrator. An empty value also denies every domain |
| `CRAWLSEO_HIDE_CLOUD_PROMO` | hidden | Set to `false` to show the crawlseo.cloud card |
| `POSTGRES_PASSWORD` | unset | Compose fails if this is missing |
| `APP_DB_PASSWORD` | unset | Password for the non-superuser `seo_app` role. Compose fails if this is missing |
| `ORCHESTRATOR_TOKEN` | unset | `/api/internal/jobs` stays 404 |
| `METRICS_TOKEN` | unset | `GET /metrics` stays 401 |
| `AUTH_TRUST_HOST` | unset | Trust `X-Forwarded-Host` only when exactly `true` |

Secrets stay in the environment. Do not commit `.env` files or keys.

### Run

```bash
cd crawlseo
npm ci
npx prisma generate
npm test
# Set POSTGRES_PASSWORD, then:
docker compose up --build
```

Prometheus metrics are `GET /metrics`. The orchestrator schedule (Europe/Warsaw) is 03:00 gsc-sync, 04:00 crawl, 05:00 vitals, 06:00 analysis. Recommendations are stored as `proposed` and are not executed.

```bash
cd orchestrator
npm ci
npm test
```

MCP is stdio only: `npm run mcp` inside `crawlseo/`. Postgres is on the compose internal network and has no published port. The app port is `127.0.0.1:3000`.
