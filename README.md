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
