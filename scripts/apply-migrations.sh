#!/bin/bash
# Apply one D1 schema role through the manifest-aware setup migration runner.

set -euo pipefail

ENV=""
STATUS_ONLY=false
ROLE="core"

for arg in "$@"; do
    case $arg in
        --env=*) ENV="${arg#--env=}" ;;
        --status) STATUS_ONLY=true ;;
        --role=*) ROLE="${arg#--role=}" ;;
        --initial)
            echo "Error: --initial is no longer supported. Use authrim-setup deploy for complete schema-first initial deployment." >&2
            exit 1
            ;;
        --force)
            echo "Error: --force is no longer supported because reapplying schema migrations is unsafe." >&2
            exit 1
            ;;
        *)
            echo "Error: unknown option '$arg'" >&2
            exit 1
            ;;
    esac
done

if [ -z "$ENV" ]; then
    echo "Usage: $0 --env=<environment> [--role=core|pii|admin] [--status]" >&2
    exit 1
fi

case "$ROLE" in
    core)
        DB_SUFFIX="core"
        MIGRATIONS_DIR="migrations"
        ;;
    pii)
        DB_SUFFIX="pii"
        MIGRATIONS_DIR="migrations/pii"
        ;;
    admin)
        DB_SUFFIX="admin"
        MIGRATIONS_DIR="migrations/admin"
        ;;
    *)
        echo "Error: --role must be core, pii, or admin" >&2
        exit 1
        ;;
esac

if [[ "$ENV" =~ \.\. ]] || [[ "$ENV" =~ / ]] || [[ "$ENV" =~ \\ ]] || [[ ! "$ENV" =~ ^[a-z][a-z0-9-]*$ ]]; then
    echo "Error: invalid environment name '$ENV'" >&2
    exit 1
fi

ARGS=(
    --database "${ENV}-authrim-${DB_SUFFIX}-db"
    --directory "$MIGRATIONS_DIR"
    --role "$ROLE"
    --env "$ENV"
)
if [ "$STATUS_ONLY" = true ]; then
    ARGS+=(--status)
fi
pnpm exec tsx scripts/run-d1-migrations.ts "${ARGS[@]}"
