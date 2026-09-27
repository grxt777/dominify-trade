#!/usr/bin/env bash
# Сквозной прогон на чистой базе: пересоздать БД, применить миграции и каталог, очистить Redis,
# поднять api и воркер с NOTIFY_DRIVER=log и разбором правилами, прогнать сценарий, остановить процессы.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="${E2E_DB:-dominify_e2e}"
PG_ADMIN_URL="${PG_ADMIN_URL:-postgres://postgres:postgres@localhost:5432/postgres}"
export DATABASE_URL="${PG_ADMIN_URL%/*}/${DB_NAME}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379/15}"
export NODE_ENV=test PORT="${PORT:-3100}" API_URL="http://localhost:${PORT:-3100}"
export PUBLIC_API_URL="$API_URL"
export BOT_TOKEN="123456:TEST-e2e-token-not-real"
export JWT_SECRET="e2e-jwt-secret-please-change-0123456789abcdef"
export ENCRYPTION_KEY="$(node -e 'console.log(Buffer.alloc(32,7).toString("base64"))')"
export HASH_KEY="e2e-hash-key-0123456789"
export NOTIFY_DRIVER=log LLM_PROVIDER=rules DEV_AUTH=1 ADMIN_TELEGRAM_IDS=900001
export WAVE1_WAIT_MIN=0.08 PAYME_KEY=test-payme-key CLICK_SECRET_KEY=test-click-secret CLICK_SERVICE_ID=1
export LOCAL_STORAGE_DIR="${TMPDIR:-/tmp}/dominify-e2e-uploads"

LOG_DIR="${E2E_LOG_DIR:-${TMPDIR:-/tmp}}"
psql "$PG_ADMIN_URL" -q -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)" -c "CREATE DATABASE ${DB_NAME}"
redis-cli -u "$REDIS_URL" FLUSHDB >/dev/null

pnpm --filter @dominify/shared build >/dev/null
pnpm --filter @dominify/db build >/dev/null
node packages/db/dist/migrate.js
node packages/db/dist/seed.js
pnpm --filter @dominify/server build >/dev/null

node apps/server/dist/main.api.js >"$LOG_DIR/e2e-api.log" 2>&1 &
API_PID=$!
node apps/server/dist/main.worker.js >"$LOG_DIR/e2e-worker.log" 2>&1 &
WORKER_PID=$!
trap 'kill $API_PID $WORKER_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -sf "$API_URL/health" >/dev/null && break
  sleep 0.5
done

node apps/server/dist/e2e/run.js
