#!/bin/sh
# Bigcapital API server entrypoint for Railway.
#
# Two jobs, in order:
#   1. Repair cross-service hostnames that render empty on a cold deploy.
#   2. Apply the system schema migrations before the API opens its listener,
#      retrying so the app does not have to lose a race against MariaDB
#      (Railway has no service ordering).
set -eu

log() { echo "[bigcapital] $*"; }

# --- 1. Hostnames ------------------------------------------------------------
# A ${{svc.RAILWAY_PRIVATE_DOMAIN}} reference is an empty string until that
# service owns a deployment, which is exactly the case when a template deploys
# every service at once. Private hostnames are deterministic, so default them.
: "${DB_HOST:=}"
: "${REDIS_HOST:=}"
: "${QUEUE_HOST:=}"
: "${CLICKHOUSE_HOST:=}"
[ -n "$DB_HOST" ]         || DB_HOST=mariadb.railway.internal
[ -n "$REDIS_HOST" ]      || REDIS_HOST=redis.railway.internal
[ -n "$QUEUE_HOST" ]      || QUEUE_HOST=redis.railway.internal
[ -n "$CLICKHOUSE_HOST" ] || CLICKHOUSE_HOST=clickhouse.railway.internal
export DB_HOST REDIS_HOST QUEUE_HOST CLICKHOUSE_HOST

# The same reference inside a URL degrades to "http://:3000" rather than to "".
case "${GOTENBERG_URL:-}" in
  ""|http://:*|http://) GOTENBERG_URL="http://gotenberg.railway.internal:3000" ;;
esac
export GOTENBERG_URL

# Gotenberg fetches the print HTML back from this server, so this is our own
# private address, not a loopback one.
SELF_HOST="${RAILWAY_PRIVATE_DOMAIN:-}"
[ -n "$SELF_HOST" ] || SELF_HOST="server.railway.internal"
case "${GOTENBERG_DOCS_URL:-}" in
  ""|http://:*|http://) GOTENBERG_DOCS_URL="http://${SELF_HOST}:${PORT:-3000}/public" ;;
esac
export GOTENBERG_DOCS_URL

log "db=${DB_HOST} redis=${REDIS_HOST} queue=${QUEUE_HOST} clickhouse=${CLICKHOUSE_HOST}"
log "gotenberg=${GOTENBERG_URL} docs=${GOTENBERG_DOCS_URL}"

# --- 2. Migrations -----------------------------------------------------------
# knex resolves the system migration directory relative to the working
# directory, so this has to run from the package root.
cd /app/packages/server

attempt=1
applied=no
while [ "$attempt" -le 60 ]; do
  if node dist/cli.js system:migrate:latest; then
    applied=yes
    break
  fi
  log "system migrations not applied yet (attempt ${attempt}); retrying in 5s"
  attempt=$((attempt + 1))
  sleep 5
done

if [ "$applied" != yes ]; then
  log "FATAL: the system database never became migratable"
  exit 1
fi

# Existing organizations get their schema brought forward. Never fatal: an
# upgrade that cannot migrate one tenant should still serve the others.
node dist/cli.js tenants:migrate:latest || log "WARNING: tenant migrations failed, see above"

log "starting the API on port ${PORT:-3000}"
exec node dist/main.js
