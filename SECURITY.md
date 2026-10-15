# Security

This repository is public and holds code only. Do not open issues or pull requests that contain credentials, hostnames, addresses, tokens, or API payloads.

## Reporting

Report a vulnerability privately to the repository owners. Do not include secret values in the report. Name the affected workflow, unit, or module and describe the impact.

## Credentials

Provider credentials and the deploy key exist only as GitHub Environment secrets on `seo-readonly`, and on the host as root-only systemd encrypted credentials. The pull-request workflow has no `environment` and no secret references.

If a credential is exposed, follow the revoke procedure in the README. The target is to revoke every listed credential within 10 minutes.
