#!/bin/sh
# Creates the audit table owner and the non-superuser application role.
# The official Postgres image makes POSTGRES_USER a superuser, which would
# ignore GRANT/REVOKE, so the app connects as seo_app instead.
set -eu
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" \
  -v app_db="$POSTGRES_DB" <<'SQL'
SELECT 'CREATE ROLE seo_audit_owner NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seo_audit_owner')
\gexec
SELECT format(
  'CREATE ROLE seo_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seo_app')
\gexec
GRANT CONNECT ON DATABASE :"app_db" TO seo_app;
GRANT USAGE, CREATE ON SCHEMA public TO seo_app;
SQL
